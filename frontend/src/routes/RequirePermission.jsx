import { Outlet } from 'react-router-dom';
import usePermissions from '../hooks/usePermissions';
import Forbidden from '../pages/Forbidden';

/**
 * Route guard for permission-gated areas. Renders the 403 page rather than
 * redirecting, so the URL stays put and no redirect loop is possible.
 *
 * Nest inside ProtectedRoute — authentication is checked there.
 */
export default function RequirePermission({ anyOf = [], children }) {
  const { canAny } = usePermissions();

  if (!canAny(anyOf)) {
    return <Forbidden />;
  }

  return children ?? <Outlet />;
}
