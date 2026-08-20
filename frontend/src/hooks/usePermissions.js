import { useMemo } from 'react';
import useAuth from './useAuth';
import { hasPermission, hasAnyPermission, hasRole } from '../utils/permissions';

/**
 * Authorisation helpers bound to the current user.
 *
 *   const { can, canAny, is } = usePermissions();
 *   if (can(PERMISSIONS.USERS_CREATE)) { ... }
 */
export function usePermissions() {
  const { user } = useAuth();

  return useMemo(
    () => ({
      permissions: user?.permissions ?? [],
      can: (...required) => hasPermission(user, ...required),
      canAny: (...required) => hasAnyPermission(user, ...required),
      is: (...roles) => hasRole(user, ...roles)
    }),
    [user]
  );
}

export default usePermissions;
