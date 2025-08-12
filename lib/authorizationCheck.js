import { EDITOR_ROLE } from '../constants';

export function isAuthorized(req) {
  return isVerenigingenBeheerder(req);
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
