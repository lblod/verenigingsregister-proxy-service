import { Router } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { isAuthorized } from './authorizationCheck.js';
import Authenticator from './authenticator.js';

import { API_BASE, API_VERSION, MU_REQUEST_HEADERS } from '../constants.js';

const router = Router();
const VR_INITIATOR = ''; // TODO

// Instantiate authenticator
const authenticator = new Authenticator();

// Helper: build headers including auth
async function buildHeaders(req, extra = {}) {
  const accessToken = await authenticator.getAccessToken();

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

  return {
    Authorization: `Bearer ${accessToken}`,
    'x-correlation-id': uuidv4(),
    'VR-Initiator': VR_INITIATOR,
    ...(API_VERSION && { 'vr-api-version': API_VERSION }),
    ...forwardHeaders,
    ...extra,
  };
}

// Helper: forward request to target API
async function forward(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const path = req.originalUrl;
  const url = `${API_BASE}${path}`;
  const headers = await buildHeaders(req, { 'If-Match': req.header('If-Match') });
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

  return res.status(response.status).json(response.data);
}

// ----- Read -----
router.get('/:vCode', (req, res, next) => forward(req, res).catch(next));

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
