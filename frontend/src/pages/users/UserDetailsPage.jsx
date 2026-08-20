import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import UserFormModal from '../../components/users/UserFormModal';
import ResetPasswordModal from '../../components/users/ResetPasswordModal';
import { RoleBadge, StatusBadge } from '../../components/users/UserBadges';
import useAuth from '../../hooks/useAuth';
import usePermissions from '../../hooks/usePermissions';
import { fetchUser } from '../../services/userService';
import { fetchRoles } from '../../services/roleService';
import { PERMISSIONS } from '../../utils/permissions';
import { formatRole } from '../../utils/constants';

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

/** Groups permission names by their module prefix, e.g. `loans.view` → `loans`. */
function groupByModule(permissions = []) {
  return permissions.reduce((accumulator, permission) => {
    const [module] = permission.split('.');
    accumulator[module] = accumulator[module] ?? [];
    accumulator[module].push(permission);
    return accumulator;
  }, {});
}

export default function UserDetailsPage() {
  const { id } = useParams();
  const { user: currentUser } = useAuth();
  const { can } = usePermissions();

  const [user, setUser] = useState(null);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const canUpdate = can(PERMISSIONS.USERS_UPDATE);
  const canResetPassword = can(PERMISSIONS.USERS_RESET_PASSWORD);
  const canViewRoles = can(PERMISSIONS.ROLES_VIEW);
  const canManageRoles = can(PERMISSIONS.ROLES_MANAGE);

  const loadUser = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetchUser(id);
      setUser(response.data.user);

      // Roles come from the API so the edit form offers exactly the roles that
      // exist. Without roles.view the form falls back to the shared constants.
      if (canViewRoles) {
        const rolesResponse = await fetchRoles();
        setRoles(rolesResponse.data.roles);
      }
    } catch (requestError) {
      setError(requestError.message);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [id, canViewRoles]);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  const roleNames = useMemo(() => roles.map((role) => role.name), [roles]);
  const grouped = useMemo(() => groupByModule(user?.permissions), [user]);

  if (loading) {
    return <Spinner label="Loading user…" />;
  }

  const isSelf = Boolean(user && currentUser && user.id === currentUser.id);

  return (
    <div className="container-fluid px-0">
      <Link className="btn btn-sm btn-outline-secondary mb-3" to="/users">
        <i className="bi bi-arrow-left me-1" aria-hidden="true" />
        Back to users
      </Link>

      <AlertMessage message={notice} variant="success" onDismiss={() => setNotice('')} />
      <AlertMessage message={error} onDismiss={() => setError('')} />

      {user ? (
        <>
          <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-4">
            <div>
              <h1 className="h4 fw-bold mb-1">
                {user.name}
                {isSelf ? <span className="badge text-bg-light border ms-2 fw-normal">You</span> : null}
              </h1>
              <p className="text-secondary text-break mb-0">{user.email}</p>
            </div>
            <div className="d-flex flex-wrap gap-2">
              {canResetPassword ? (
                <button type="button" className="btn btn-outline-secondary" onClick={() => setPasswordOpen(true)}>
                  <i className="bi bi-key me-2" aria-hidden="true" />
                  Reset password
                </button>
              ) : null}
              {canUpdate ? (
                <button type="button" className="btn btn-primary" onClick={() => setEditOpen(true)}>
                  <i className="bi bi-pencil me-2" aria-hidden="true" />
                  Edit user
                </button>
              ) : null}
            </div>
          </div>

          <div className="row g-4">
            <div className="col-12 col-lg-7">
              <div className="card border-0 shadow-sm h-100">
                <div className="card-body">
                  <h2 className="h6 fw-bold mb-3">
                    <i className="bi bi-person-badge me-2 text-primary" aria-hidden="true" />
                    Account
                  </h2>

                  <dl className="row mb-0">
                    <dt className="col-5 col-sm-4 text-secondary fw-normal">Name</dt>
                    <dd className="col-7 col-sm-8">{user.name}</dd>

                    <dt className="col-5 col-sm-4 text-secondary fw-normal">Email</dt>
                    <dd className="col-7 col-sm-8 text-break">{user.email}</dd>

                    <dt className="col-5 col-sm-4 text-secondary fw-normal">Role</dt>
                    <dd className="col-7 col-sm-8">
                      <RoleBadge role={user.role} />
                    </dd>

                    <dt className="col-5 col-sm-4 text-secondary fw-normal">Status</dt>
                    <dd className="col-7 col-sm-8">
                      <StatusBadge status={user.status} />
                    </dd>

                    {/* System-assigned identity and timestamps: displayed, never editable. */}
                    <dt className="col-5 col-sm-4 text-secondary fw-normal">User ID</dt>
                    <dd className="col-7 col-sm-8">
                      <span className="font-monospace">{user.id}</span>
                      <span className="badge text-bg-light border ms-2 fw-normal">read-only</span>
                    </dd>

                    <dt className="col-5 col-sm-4 text-secondary fw-normal">Created</dt>
                    <dd className="col-7 col-sm-8">{formatDateTime(user.createdAt)}</dd>

                    <dt className="col-5 col-sm-4 text-secondary fw-normal">Last updated</dt>
                    <dd className="col-7 col-sm-8 mb-0">{formatDateTime(user.updatedAt)}</dd>
                  </dl>

                  <p className="form-text mb-0 mt-3">
                    <i className="bi bi-lock me-1" aria-hidden="true" />
                    The user ID and the created / updated timestamps are set by the system and cannot be edited.
                  </p>
                </div>
              </div>
            </div>

            <div className="col-12 col-lg-5">
              <div className="card border-0 shadow-sm h-100">
                <div className="card-body">
                  <div className="d-flex align-items-center justify-content-between gap-2 mb-3">
                    <h2 className="h6 fw-bold mb-0">Effective permissions</h2>
                    <span className="badge text-bg-secondary fw-normal">{user.permissions?.length ?? 0}</span>
                  </div>

                  <p className="mb-3">
                    <span className="text-secondary small d-block">Role</span>
                    <RoleBadge role={user.role} />
                  </p>

                  {user.permissions?.length ? (
                    Object.entries(grouped).map(([module, items]) => (
                      <div className="mb-3" key={module}>
                        <p className="text-uppercase small fw-bold text-secondary mb-1">{module.replace(/_/g, ' ')}</p>
                        <div className="d-flex flex-wrap gap-1">
                          {items.map((permission) => (
                            <span className="badge text-bg-light border font-monospace fw-normal" key={permission}>
                              {permission}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-secondary">This role holds no permissions yet.</p>
                  )}

                  <div className="pt-3 border-top">
                    <p className="form-text mt-0">
                      Permissions come from the assigned role. They cannot be granted to a single user — change the
                      user&apos;s role, or change what the role is allowed to do.
                    </p>
                    {canViewRoles ? (
                      <Link className="btn btn-sm btn-outline-primary" to={`/roles?role=${encodeURIComponent(user.role ?? '')}`}>
                        <i className="bi bi-shield-lock me-1" aria-hidden="true" />
                        {canManageRoles ? 'Manage role permissions' : 'View role permissions'}
                      </Link>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <UserFormModal
            open={editOpen}
            mode="edit"
            user={{ ...user, isSelf }}
            roles={roleNames}
            onClose={() => setEditOpen(false)}
            onSaved={async (message) => {
              setEditOpen(false);
              setNotice(message);
              await loadUser();
            }}
          />

          <ResetPasswordModal
            open={passwordOpen}
            user={user}
            onClose={() => setPasswordOpen(false)}
            onSaved={async (message) => {
              setPasswordOpen(false);
              setNotice(message);
              await loadUser();
            }}
          />
        </>
      ) : null}
    </div>
  );
}
