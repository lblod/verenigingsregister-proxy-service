import { EDITOR_ROLE, SESSION_GRAPH, ORGANISATION_GRAPH } from '../constants.js';
import { querySudo as query } from '@lblod/mu-auth-sudo';
import { sparqlEscapeUri } from 'mu';

// Cache for OVO codes with 24-hour expiration
const ovoCodeCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run cleanup every hour

// Periodic cleanup of expired cache entries
function cleanupExpiredCacheEntries() {
  const now = Date.now();
  let removedCount = 0;

  for (const [sessionId, cached] of ovoCodeCache.entries()) {
    if (now - cached.timestamp >= CACHE_TTL_MS) {
      ovoCodeCache.delete(sessionId);
      removedCount++;
    }
  }

  if (removedCount > 0) {
    console.log(`OVO code cache cleanup: removed ${removedCount} expired entries. Cache size: ${ovoCodeCache.size}`);
  }
}

// Start periodic cleanup
const cleanupTimer = setInterval(cleanupExpiredCacheEntries, CLEANUP_INTERVAL_MS);

// Ensure cleanup timer doesn't prevent Node.js from exiting
cleanupTimer.unref();

const getOvoFromSessionIdQuery = (sessionId) => `
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX session: <http://mu.semte.ch/vocabularies/session/>
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

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

export function isAuthorized(req) {
  return isVerenigingenBeheerder(req);
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
  if (!groupsHeader) return false;
  try {
    const groups = JSON.parse(groupsHeader);
    console.log('roles', groups);
    return Array.isArray(groups) && groups.some((g) => g.name === EDITOR_ROLE);
  } catch {
    return false;
  }
}
