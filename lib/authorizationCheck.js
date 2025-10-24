import { EDITOR_ROLE, SESSION_GRAPH, ORGANISATION_GRAPH, PROCESSING_AGREEMENT_GRAPH, ENABLE_PROCESSING_AGREEMENT_CHECK } from '../constants.js';
import { querySudo as query } from '@lblod/mu-auth-sudo';
import { sparqlEscapeUri } from 'mu';

// Cache for OVO codes with 24-hour expiration
const ovoCodeCache = new Map();
// Cache for processing agreements with 24-hour expiration
const processingAgreementCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run cleanup every hour

// Periodic cleanup of expired cache entries
function cleanupExpiredCacheEntries() {
  const now = Date.now();
  const caches = [
    { name: 'OVO code', cache: ovoCodeCache },
    { name: 'processing agreement', cache: processingAgreementCache }
  ];

  const cleanupResults = caches.map(({ name, cache }) => {
    let removedCount = 0;
    for (const [key, cached] of cache.entries()) {
      if (now - cached.timestamp >= CACHE_TTL_MS) {
        cache.delete(key);
        removedCount++;
      }
    }
    return { name, removedCount, size: cache.size };
  });

  const totalRemoved = cleanupResults.reduce((sum, result) => sum + result.removedCount, 0);
  if (totalRemoved > 0) {
    const details = cleanupResults
      .map(({ name, removedCount, size }) => `${removedCount} ${name} entries (size: ${size})`)
      .join(', ');
    console.log(`Cache cleanup: removed ${details}`);
  }
}

// Start periodic cleanup
const cleanupTimer = setInterval(cleanupExpiredCacheEntries, CLEANUP_INTERVAL_MS);

// Ensure cleanup timer doesn't prevent Node.js from exiting
cleanupTimer.unref();

const getOvoFromSessionIdQuery = (sessionId) => `
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX dct: <http://purl.org/dc/terms/>

SELECT DISTINCT ?identifier WHERE {
  GRAPH ${sparqlEscapeUri(SESSION_GRAPH)} {
    ${sparqlEscapeUri(sessionId)}
      ext:sessionGroup ?adminUnit .
  }

  GRAPH ${sparqlEscapeUri(ORGANISATION_GRAPH)} {
    ?adminUnit
      dct:identifier ?identifier .
    FILTER(STRSTARTS(STR(?identifier), "OVO"))
  }
}`;

// Assumption: the PROCESSING_AGREEMENT_GRAPH contains only currently valid subprocessing agreements.
// We only check for existence of agreements, not validity periods.
// The agreements in full and their lifecycle are assumed to be managed elsewhere.
const getProcessingAgreementsFromLocalAdminUnit = (OVOCode) => `
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX dpv: <https://w3id.org/dpv#>

SELECT DISTINCT ?identifier WHERE {
  GRAPH ${sparqlEscapeUri(ORGANISATION_GRAPH)} {
    ?adminUnit
      dct:identifier ${sparqlEscapeString(OVOCode)} .
  }

  GRAPH ${sparqlEscapeUri(PROCESSING_AGREEMENT_GRAPH)} {
    ?subProcessingAgreement
      dpv:hasDataProcessor ?adminUnit .
  }
}`;

export async function isAuthorized(req) {
  const roleCheck = isVerenigingenBeheerder(req);
  if (!roleCheck.authorized) {
    return roleCheck;
  }

  // Only check processing agreement if feature flag is enabled
  if (ENABLE_PROCESSING_AGREEMENT_CHECK) {
    const agreementCheck = await hasProcessingAgreement(req);
    if (!agreementCheck.authorized) {
      return agreementCheck;
    }
  }

  return { authorized: true, detail: 'Request authorized' };
}

export async function getSessionOVOCode(req) {
  const sessionId = req.headers['mu-session-id'];
  if (!sessionId) {
    throw new Error('No session ID found in request headers');
  }

  // Check cache first
  const cached = ovoCodeCache.get(sessionId);
  if (cached) {
    const now = Date.now();
    if (now - cached.timestamp < CACHE_TTL_MS) {
      console.log(`OVO code cache hit for session ${sessionId}: ${cached.ovoCode}`);
      return cached.ovoCode;
    } else {
      // Cache entry expired, remove it
      console.log(`OVO code cache expired for session ${sessionId}`);
      ovoCodeCache.delete(sessionId);
    }
  }

  // Cache miss or expired, query the database
  console.log(`OVO code cache miss for session ${sessionId}, querying database`);
  const result = await query(getOvoFromSessionIdQuery(sessionId));

  console.log('OVO Codes from session:', JSON.stringify(result, null, 2));

  // Validate the result structure
  if (!result?.results?.bindings) {
    throw new Error('Invalid SPARQL query result structure');
  }

  const bindings = result.results.bindings;

  // Check for exactly one OVO code
  if (bindings.length === 0) {
    throw new Error('No OVO code found for session');
  }

  if (bindings.length > 1) {
    throw new Error(`Multiple OVO codes found for session: ${bindings.map(b => b.identifier?.value).join(', ')}`);
  }

  // Extract the OVO code value
  const ovoCode = bindings[0].identifier?.value;

  if (!ovoCode) {
    throw new Error('OVO code identifier value is missing');
  }

  // Store in cache with timestamp
  ovoCodeCache.set(sessionId, {
    ovoCode,
    timestamp: Date.now(),
  });
  console.log(`OVO code cached for session ${sessionId}: ${ovoCode}`);

  return ovoCode;
}


function isVerenigingenBeheerder(req) {
  const groupsHeader = req.headers['mu-auth-allowed-groups'];

  if (!groupsHeader) {
    return {
      authorized: false,
      detail: 'Missing mu-auth-allowed-groups header'
    };
  }

  try {
    const groups = JSON.parse(groupsHeader);
    console.log('roles', groups);

    if (!Array.isArray(groups)) {
      return {
        authorized: false,
        detail: 'mu-auth-allowed-groups header is not an array'
      };
    }

    const hasRole = groups.some((g) => g.name === EDITOR_ROLE);

    if (!hasRole) {
      return {
        authorized: false,
        detail: `Missing required role: ${EDITOR_ROLE}`
      };
    }

    return { authorized: true, detail: 'User has required role' };
  } catch (error) {
    return {
      authorized: false,
      detail: `Failed to parse mu-auth-allowed-groups header: ${error.message}`
    };
  }
}

// Processing agreements per local government
async function hasProcessingAgreement(req) {
  try {
    const adminUnitOVOCode = await getSessionOVOCode(req);

    // Check cache first
    const cached = processingAgreementCache.get(adminUnitOVOCode);
    if (cached) {
      const now = Date.now();
      if (now - cached.timestamp < CACHE_TTL_MS) {
        console.log(`Processing agreement cache hit for OVO code ${adminUnitOVOCode}: ${cached.hasAgreement}`);
        return cached.result;
      } else {
        // Cache entry expired, remove it
        console.log(`Processing agreement cache expired for OVO code ${adminUnitOVOCode}`);
        processingAgreementCache.delete(adminUnitOVOCode);
      }
    }

    // Cache miss or expired, query the database
    console.log(`Processing agreement cache miss for OVO code ${adminUnitOVOCode}, querying database`);
    const result = await query(getProcessingAgreementsFromLocalAdminUnit(adminUnitOVOCode));

    console.log('Processing agreement query result:', JSON.stringify(result, null, 2));

    // Check if result contains any bindings
    const hasAgreement = result?.results?.bindings && result.results.bindings.length > 0;
    const authResult = {
      authorized: hasAgreement,
      detail: hasAgreement
        ? `Processing agreement found for OVO code ${adminUnitOVOCode}`
        : `No processing agreement found for OVO code ${adminUnitOVOCode}`
    };

    // Store in cache with timestamp
    processingAgreementCache.set(adminUnitOVOCode, {
      hasAgreement,
      result: authResult,
      timestamp: Date.now(),
    });
    console.log(`Processing agreement cached for OVO code ${adminUnitOVOCode}: ${hasAgreement}`);

    return authResult;
  } catch (error) {
    return {
      authorized: false,
      detail: `Processing agreement check failed: ${error.message}`
    };
  }
}
