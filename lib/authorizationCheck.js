import {
  EDITOR_ROLE,
  SESSION_GRAPH,
  ORGANISATION_GRAPH,
  PROCESSING_AGREEMENT_GRAPH,
  ENABLE_PROCESSING_AGREEMENT_CHECK,
} from '../constants.js';
import { querySudo as query } from '@lblod/mu-auth-sudo';
import { sparqlEscapeUri } from 'mu';

function getOvoFromSessionIdQuery(sessionId) {
  return `
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
}

// Assumption: the PROCESSING_AGREEMENT_GRAPH contains only currently valid subprocessing agreements.
// We only check for existence of agreements, not validity periods.
// The agreements in full and their lifecycle are assumed to be managed elsewhere.
function getProcessingAgreementFromSessionId(sessionId) {
  return `
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX dpv: <https://w3id.org/dpv#>

SELECT DISTINCT ?subProcessingAgreement WHERE {
  GRAPH ${sparqlEscapeUri(SESSION_GRAPH)} {
    ${sparqlEscapeUri(sessionId)}
      ext:sessionGroup ?adminUnit .
  }

  GRAPH ${sparqlEscapeUri(PROCESSING_AGREEMENT_GRAPH)} {
    ?subProcessingAgreement
      dpv:hasDataProcessor ?adminUnit .
  }
}`;
}

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
    throw new Error(`Multiple OVO codes found for session: ${bindings.map((b) => b.identifier?.value).join(', ')}`);
  }

  // Extract the OVO code value
  const ovoCode = bindings[0].identifier?.value;

  if (!ovoCode) {
    throw new Error('OVO code identifier value is missing');
  }

  return ovoCode;
}

function isVerenigingenBeheerder(req) {
  const groupsHeader = req.headers['mu-auth-allowed-groups'];

  console.log('headers', req.headers);

  if (!groupsHeader) {
    return {
      authorized: false,
      detail: 'Missing mu-auth-allowed-groups header',
    };
  }

  try {
    const groups = JSON.parse(groupsHeader);
    console.log('roles', groups);

    if (!Array.isArray(groups)) {
      return {
        authorized: false,
        detail: 'mu-auth-allowed-groups header is not an array',
      };
    }

    const hasRole = groups.some((g) => g.name === EDITOR_ROLE);

    if (!hasRole) {
      return {
        authorized: false,
        detail: `Missing required role: ${EDITOR_ROLE}`,
      };
    }

    return { authorized: true, detail: 'User has required role' };
  } catch (error) {
    return {
      authorized: false,
      detail: `Failed to parse mu-auth-allowed-groups header: ${error.message}`,
    };
  }
}

// Processing agreements per local government
async function hasProcessingAgreement(req) {
  try {
    const sessionId = req.headers['mu-session-id'];
    if (!sessionId) {
      return {
        authorized: false,
        detail: 'No session ID found in request headers',
      };
    }

    const result = await query(getProcessingAgreementFromSessionId(sessionId));

    console.log('Processing agreement query result:', JSON.stringify(result, null, 2));

    // Check if result contains any bindings
    const hasAgreement = result?.results?.bindings && result.results.bindings.length > 0;
    return {
      authorized: hasAgreement,
      detail: hasAgreement
        ? `Processing agreement found for session ${sessionId}`
        : `No processing agreement found for session ${sessionId}`,
    };
  } catch (error) {
    return {
      authorized: false,
      detail: `Processing agreement check failed: ${error.message}`,
    };
  }
}
