import { EDITOR_ROLE, MU_REQUEST_HEADERS } from '../constants';

export function isAuthorized(req) {
  return isVerenigingenBeheerder(req);
}

function isVerenigingenBeheerder(req) {
  // const mu_headers = getMuHeaders(req);
  // console.log('mu_headers', mu_headers);
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

// function getMuHeaders(req) {
//   const muHeaders = {};
//   for (const header of MU_REQUEST_HEADERS) {
//     if (req.headers[header]) {
//       muHeaders[header] = req.headers[header];
//     }
//   }
//   return muHeaders;
// }
