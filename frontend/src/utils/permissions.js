/**
 * Permission identifiers, mirroring backend/src/config/permissions.js.
 *
 * These drive what the UI offers. They are a convenience, never a security
 * boundary — the backend re-checks every request.
 */
export const PERMISSIONS = Object.freeze({
  USERS_VIEW: 'users.view',
  USERS_CREATE: 'users.create',
  USERS_UPDATE: 'users.update',
  USERS_DELETE: 'users.delete',
  USERS_ACTIVATE: 'users.activate',
  USERS_DEACTIVATE: 'users.deactivate',
  USERS_ASSIGN_ROLE: 'users.assign_role',
  USERS_RESET_PASSWORD: 'users.reset_password',
  ROLES_VIEW: 'roles.view',
  ROLES_MANAGE: 'roles.manage',
  PERMISSIONS_VIEW: 'permissions.view',
  PERMISSIONS_MANAGE: 'permissions.manage',
  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_UPDATE: 'customers.update',
  CUSTOMERS_ACTIVATE: 'customers.activate',
  CUSTOMERS_DEACTIVATE: 'customers.deactivate',
  CUSTOMERS_IMPORT: 'customers.import',
  LOAN_PARTIES_VIEW: 'loan_parties.view',
  LOAN_PARTIES_CREATE: 'loan_parties.create',
  LOAN_PARTIES_UPDATE: 'loan_parties.update',
  LOAN_PARTIES_REMOVE: 'loan_parties.remove',
  LOAN_PARTIES_SWAP: 'loan_parties.swap',
  LOANS_VIEW: 'loans.view',
  LOANS_CREATE: 'loans.create',
  LOANS_UPDATE: 'loans.update',
  LOANS_ACTIVATE: 'loans.activate',
  LOANS_CLOSE: 'loans.close',
  LOANS_CANCEL: 'loans.cancel',
  LOANS_IMPORT: 'loans.import',
  EMIS_VIEW: 'emis.view',
  EMIS_GENERATE: 'emis.generate',
  EMIS_UPDATE: 'emis.update',
  EMIS_BOUNCE_CHARGE: 'emis.bounce_charge',
  COLLECTIONS_VIEW: 'collections.view',
  COLLECTIONS_CREATE: 'collections.create',
  COLLECTIONS_REVERSE: 'collections.reverse',
  COLLECTIONS_IMPORT: 'collections.import',
  ROUTES_VIEW: 'routes.view',
  ROUTES_CREATE: 'routes.create',
  ROUTES_UPDATE: 'routes.update',
  ROUTES_ASSIGN: 'routes.assign',
  DEMAND_VIEW: 'demand.view',
  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',
  RECEIPTS_VIEW: 'receipts.view',
  DASHBOARD_VIEW: 'dashboard.view'
});

/** True when the user holds every listed permission. */
export function hasPermission(user, ...required) {
  const needed = required.flat().filter(Boolean);
  if (needed.length === 0) return true;
  const granted = user?.permissions;
  if (!Array.isArray(granted)) return false;
  return needed.every((permission) => granted.includes(permission));
}

/** True when the user holds at least one of the listed permissions. */
export function hasAnyPermission(user, ...required) {
  const needed = required.flat().filter(Boolean);
  if (needed.length === 0) return true;
  const granted = user?.permissions;
  if (!Array.isArray(granted)) return false;
  return needed.some((permission) => granted.includes(permission));
}

/** True when the user holds one of the listed roles. */
export function hasRole(user, ...roles) {
  const accepted = roles.flat().filter(Boolean);
  if (accepted.length === 0) return true;
  return Boolean(user?.role) && accepted.includes(user.role);
}
