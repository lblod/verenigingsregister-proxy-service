import {
  EDITOR_ROLE,
  VIEWER_ROLE,
  SESSION_GRAPH,
  ORGANISATION_GRAPH,
  PROCESSING_AGREEMENT_GRAPH,
  ENABLE_PROCESSING_AGREEMENT_CHECK,
  DATA_ACCESS_LOG_GRAPH,
} from '../constants.js';
import { querySudo as query, updateSudo as update } from '@lblod/mu-auth-sudo';
import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime, sparqlEscapeBool, uuid } from 'mu';

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

function getSessionInfoQuery(sessionId) {
  return `
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX session: <http://mu.semte.ch/vocabularies/session/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>

SELECT ?person ?adminUnit WHERE {
  GRAPH ${sparqlEscapeUri(SESSION_GRAPH)} {
    ${sparqlEscapeUri(sessionId)}
      ext:sessionGroup ?adminUnit ;
      session:account ?account .
  }

  ?person foaf:account ?account .
}`;
}

/**
 * Get person and administrative unit URIs from session.
 */
export async function getSessionInfo(req) {
  const sessionId = req.headers['mu-session-id'];
  if (!sessionId) {
    return { person: null, adminUnit: null };
  }

  const result = await query(getSessionInfoQuery(sessionId));
  const binding = result?.results?.bindings?.[0];

  return {
    person: binding?.person?.value || null,
    adminUnit: binding?.adminUnit?.value || null,
  };
}

export async function isAuthorized(req) {
  const method = req.method?.toUpperCase();
  const isReadOnly = method === 'GET' || method === 'HEAD';
  const roleCheck = checkRole(req, isReadOnly);
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

function checkRole(req, isReadOnly = false) {
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

    const hasEditorRole = groups.some((g) => g.name === EDITOR_ROLE);
    const hasViewerRole = groups.some((g) => g.name === VIEWER_ROLE);

    if (hasEditorRole) {
      return { authorized: true, detail: 'User has editor role' };
    }

    if (isReadOnly && hasViewerRole) {
      return { authorized: true, detail: 'User has viewer role' };
    }

    const requiredRoles = isReadOnly
      ? `${EDITOR_ROLE} or ${VIEWER_ROLE}`
      : EDITOR_ROLE;

    return {
      authorized: false,
      detail: `Missing required role: ${requiredRoles}`,
    };
  } catch (error) {
    return {
      authorized: false,
      detail: `Failed to parse mu-auth-allowed-groups header: ${error.message}`,
    };
  }
}

function getRequestReasonQuery(reasonUuid) {
  return `
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

SELECT ?reason WHERE {
  ?reason a ext:ReasonCode ;
    mu:uuid ${sparqlEscapeString(reasonUuid)} .
}`;
}

/**
 * Validate request reason for GET /:vCode requests.
 * This is an additional authorization check for viewing sensitive data.
 * Returns { valid, reasonUuid, reasonUri, detail }.
 */
export async function validateRequestReason(req) {
  const requestReason = req.header('X-Request-Reason');

  if (!requestReason) {
    return {
      valid: false,
      reasonUuid: null,
      reasonUri: null,
      detail: 'Missing required header: X-Request-Reason',
    };
  }

  const result = await query(getRequestReasonQuery(requestReason));
  const reasonUri = result?.results?.bindings?.[0]?.reason?.value;

  if (!reasonUri) {
    return {
      valid: false,
      reasonUuid: requestReason,
      reasonUri: null,
      detail: 'Invalid X-Request-Reason value',
    };
  }

  return {
    valid: true,
    reasonUuid: requestReason,
    reasonUri,
    detail: 'Request reason validated',
  };
}

function buildLogDataAccessQuery({ uuid, resourceUri, eTag, reasonUri, person, adminUnit, success, error, timestamp }) {
  const logUri = `http://data.lblod.info/id/data-access-logs/${uuid}`;

  // Build triples array - required fields first, then optional
  const triples = [
    `a ext:SensitiveInformationRead`,
    `mu:uuid ${sparqlEscapeString(uuid)}`,
    `ext:date ${sparqlEscapeDateTime(timestamp)}`,
    `ext:success ${sparqlEscapeBool(success)}`,
  ];

  // Add optional URI fields only if they have values
  if (resourceUri) {
    triples.push(`ext:resource ${sparqlEscapeUri(resourceUri)}`);
  }
  if (reasonUri) {
    triples.push(`ext:reason ${sparqlEscapeUri(reasonUri)}`);
  }
  if (person) {
    triples.push(`ext:person ${sparqlEscapeUri(person)}`);
  }
  if (adminUnit) {
    triples.push(`ext:adminUnit ${sparqlEscapeUri(adminUnit)}`);
  }
  if (eTag) {
    triples.push(`ext:etag ${sparqlEscapeString(eTag)}`);
  }
  if (error?.message) {
    triples.push(`ext:errorMessage ${sparqlEscapeString(error.message)}`);
  }

  return `
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

INSERT DATA {
  GRAPH ${sparqlEscapeUri(DATA_ACCESS_LOG_GRAPH)} {
    ${sparqlEscapeUri(logUri)} ${triples.join(' ;\n      ')} .
  }
}`;
}

/**
 * Log access to sensitive data (GET /:vCode) to triple store.
 * Called after successful or failed requests.
 */
export async function logDataAccess({ resourceUri, eTag, reasonUri, person, adminUnit, success, error }) {
  try {
    const logUuid = uuid();
    const timestamp = new Date();

    const queryString = buildLogDataAccessQuery({
      uuid: logUuid,
      resourceUri,
      eTag,
      reasonUri,
      person,
      adminUnit,
      success,
      error,
      timestamp,
    });

    await update(queryString);
    console.log('Data access logged:', { uuid: logUuid, resourceUri, success });
  } catch (err) {
    // Log error but don't throw - logging failure shouldn't break the request
    console.error('Failed to log data access:', err.message);
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
