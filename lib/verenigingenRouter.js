import { Router } from 'express';
import axios from 'axios';
import { uuid } from 'mu';
import { getSessionOVOCode, isAuthorized, validateRequestReason, logDataAccess, getSessionInfo } from './authorizationCheck.js';
import Authenticator from './authenticator.js';

//Ensure Axios is not flipping with a 304 response
axios.defaults.validateStatus = (status) => {
  return (status >= 200 && status < 300) || status === 304;
};

import { API_BASE, API_VERSION, MU_REQUEST_HEADERS, FALLBACK_HEAD_CLIENT_ID } from '../constants.js';

const router = Router();

// Instantiate authenticator
const authenticator = new Authenticator();

// Helper: build headers including auth
async function buildHeaders(req, { extra = {}, fallbackClientId = null } = {}) {
  const sessionId = req.headers['mu-session-id'];
  const accessToken = await authenticator.getAccessToken(sessionId, fallbackClientId);

  // List of headers that should never be forwarded
  const EXCLUDED_HEADERS = [
    ...MU_REQUEST_HEADERS,
    'host',
    'connection',
    'content-length',
    'accept-encoding',
    'x-powered-by',
    'cookie',
    'set-cookie',
    'referer',
    'origin',
  ];

  // Remove all excluded headers from req.headers
  const forwardHeaders = Object.fromEntries(
    Object.entries(req.headers).filter(([key]) => !EXCLUDED_HEADERS.includes(key.toLowerCase()))
  );

  const sessionOVOCode = await getSessionOVOCode(req);

  return {
    Authorization: `Bearer ${accessToken}`,
    'x-correlation-id': uuid(),
    'VR-Initiator': sessionOVOCode,
    ...(API_VERSION && { 'vr-api-version': API_VERSION }),
    ...forwardHeaders,
    ...extra,
  };
}

// Helper: forward request to target API (core logic, no auth check)
async function forwardRequest(req, res) {
  const path = req.originalUrl;
  const url = `${API_BASE}${path}`;
  const headers = await buildHeaders(req, { extra: { 'If-Match': req.header('If-Match') } });

  // console.log('Axios request:', JSON.stringify({
  //   url,
  //   method: req.method,
  //   headers,
  //   params: req.query,
  //   data: req.body,
  // }, null, 2));

  const response = await axios({
    url,
    method: req.method,
    headers,
    params: req.query,
    data: req.body,
  });

  ['etag', 'vr-sequence', 'location'].forEach((h) => {
    if (response.headers[h]) res.setHeader(h, response.headers[h]);
  });

  // Handle responses with no body (304 Not Modified, 204 No Content - for completeness)
  if (response.status === 204 || response.status === 304) {
    return res.status(response.status).end();
  }

  return res.status(response.status).json(response.data);
}

// Helper: forward request with authorization check
async function forward(req, res) {
  const authResult = await isAuthorized(req);
  if (!authResult.authorized) {
    console.log('Authorization failed:', authResult.detail);
    return res.status(401).json({
      error: 'Unauthorized',
      detail: authResult.detail,
    });
  }
  return forwardRequest(req, res);
}

// ----- Head -----
// Must be defined BEFORE GET, as Express automatically handles HEAD with GET handlers
router.head('/:vCode', async (req, res, next) => {
  try {
    const authResult = await isAuthorized(req);
    if (!authResult.authorized) {
      console.log('Authorization failed:', authResult.detail);
      return res.status(401).end();
    }
    const path = req.originalUrl;
    const url = `${API_BASE}${path}`;
    const headers = await buildHeaders(req, { fallbackClientId: FALLBACK_HEAD_CLIENT_ID || null });

    const response = await axios({
      url,
      method: 'GET',
      headers,
      params: req.query,
    });

    ['etag', 'vr-sequence', 'content-type'].forEach((h) => {
      if (response.headers[h]) res.setHeader(h, response.headers[h]);
    });

    return res.status(response.status).end();
  } catch (error) {
    next(error);
  }
});

// ----- Read -----
router.get('/:vCode', async (req, res, next) => {
  const { vCode } = req.params;
  const resourceUri = `${API_BASE}${vCode}`;
  let reasonUri = null;
  let person = null;
  let adminUnit = null;

  try {
    // Get session info for logging
    const sessionInfo = await getSessionInfo(req);
    person = sessionInfo.person;
    adminUnit = sessionInfo.adminUnit;

    // Check authorization (includes role, processing agreement, and werkingsgebied checks)
    const authResult = await isAuthorized(req, { vCode });
    if (!authResult.authorized) {
      await logDataAccess({
        resourceUri,
        person,
        adminUnit,
        success: false,
        error: new Error(authResult.detail),
      });
      return res.status(403).json({
        error: 'Forbidden',
        detail: authResult.detail,
      });
    }

    // Validate request reason (additional check for sensitive data access)
    const reasonResult = await validateRequestReason(req);
    if (!reasonResult.valid) {
      await logDataAccess({
        resourceUri,
        person,
        adminUnit,
        success: false,
        error: new Error(reasonResult.detail),
      });
      return res.status(400).json({
        error: 'Bad Request',
        detail: reasonResult.detail,
      });
    }
    reasonUri = reasonResult.reasonUri;

    // Forward the request (skip auth check since we already did it)
    await forwardRequest(req, res);

    // Log successful access
    const eTag = res.getHeader('etag');
    await logDataAccess({ resourceUri, eTag, reasonUri, person, adminUnit, success: true });

  } catch (error) {
    // Log failed access
    await logDataAccess({ resourceUri, reasonUri, person, adminUnit, success: false, error });
    next(error);
  }
});

// ----- Contactgegevens -----
router.post('/:vCode/contactgegevens', (req, res, next) => forward(req, res).catch(next));
router.patch('/:vCode/contactgegevens/:id', (req, res, next) => forward(req, res).catch(next));
router.delete('/:vCode/contactgegevens/:id', (req, res, next) => forward(req, res).catch(next));

// ----- Locatie -----
router.post('/:vCode/locaties', (req, res, next) => forward(req, res).catch(next));
router.patch('/:vCode/locaties/:id', (req, res, next) => forward(req, res).catch(next));
router.delete('/:vCode/locaties/:id', (req, res, next) => forward(req, res).catch(next));

// ----- Vertegenwoordiger -----
router.post('/:vCode/vertegenwoordigers', (req, res, next) => forward(req, res).catch(next));
router.patch('/:vCode/vertegenwoordigers/:id', (req, res, next) => forward(req, res).catch(next));
router.delete('/:vCode/vertegenwoordigers/:id', (req, res, next) => forward(req, res).catch(next));

export default router;
