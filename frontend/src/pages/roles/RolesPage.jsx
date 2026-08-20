import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import usePermissions from '../../hooks/usePermissions';
import { fetchRoles, fetchPermissions, updateRolePermissions } from '../../services/roleService';
import { PERMISSIONS } from '../../utils/permissions';
import { formatRole } from '../../utils/constants';

/** Groups the catalogue by the module prefix of each permission name. */
function groupByModule(permissions) {
  return permissions.reduce((accumulator, permission) => {
    const key = permission.module ?? permission.name.split('.')[0];
    accumulator[key] = accumulator[key] ?? [];
    accumulator[key].push(permission);
    return accumulator;
  }, {});
}

export default function RolesPage() {
  const { can } = usePermissions();
  // `/roles?role=COLLECTOR` opens straight at that role, so User Details can
  // link here instead of duplicating permission management.
  const [searchParams] = useSearchParams();
  const requestedRole = searchParams.get('role');
  const canManage = can(PERMISSIONS.ROLES_MANAGE);
  const canViewPermissions = can(PERMISSIONS.PERMISSIONS_VIEW);

  const [roles, setRoles] = useState([]);
  const [catalogue, setCatalogue] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const rolesResponse = await fetchRoles();
      const list = rolesResponse.data.roles;
      setRoles(list);

      const requested = requestedRole ? list.find((role) => role.name === requestedRole) : null;
      setSelectedId((current) => requested?.id ?? current ?? list[0]?.id ?? null);

      if (canViewPermissions) {
        const permissionsResponse = await fetchPermissions();
        setCatalogue(permissionsResponse.data.permissions);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [canViewPermissions, requestedRole]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = roles.find((role) => role.id === selectedId) ?? null;

  useEffect(() => {
    setDraft(selected ? selected.permissions : []);
  }, [selected]);

  const isSuperAdmin = selected?.name === 'SUPER_ADMIN';
  const editable = canManage && selected && !isSuperAdmin;

  const toggle = (permissionName) => {
    setDraft((current) =>
      current.includes(permissionName) ? current.filter((name) => name !== permissionName) : [...current, permissionName]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await updateRolePermissions(selected.id, draft);
      setNotice(`Permissions updated for ${formatRole(selected.name)}`);
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Spinner label="Loading roles…" />;
  }

  const grouped = groupByModule(catalogue);
  const dirty = selected && JSON.stringify([...draft].sort()) !== JSON.stringify([...selected.permissions].sort());

  return (
    <div className="container-fluid px-0">
      <div className="mb-4">
        <h1 className="h3 fw-bold mb-1">Roles &amp; Permissions</h1>
        <p className="text-secondary mb-0">What each role is allowed to do. Backend authorisation is driven by these grants.</p>
      </div>

      <AlertMessage message={notice} variant="success" onDismiss={() => setNotice('')} />
      <AlertMessage message={error} onDismiss={() => setError('')} />

      <div className="row g-4">
        <div className="col-12 col-lg-4">
          <div className="card border-0 shadow-sm">
            <div className="list-group list-group-flush">
              {roles.map((role) => (
                <button
                  type="button"
                  key={role.id}
                  className={`list-group-item list-group-item-action${role.id === selectedId ? ' active' : ''}`}
                  onClick={() => setSelectedId(role.id)}
                >
                  <div className="d-flex justify-content-between align-items-center">
                    <span className="fw-semibold">{formatRole(role.name)}</span>
                    <span className={`badge ${role.id === selectedId ? 'text-bg-light' : 'text-bg-secondary'}`}>
                      {role.permissions.length}
                    </span>
                  </div>
                  <small className={role.id === selectedId ? 'text-white-50' : 'text-secondary'}>
                    {role.userCount} user{role.userCount === 1 ? '' : 's'}
                  </small>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="col-12 col-lg-8">
          <div className="card border-0 shadow-sm">
            <div className="card-body">
              {selected ? (
                <>
                  <h2 className="h5 fw-bold mb-1">{formatRole(selected.name)}</h2>
                  <p className="text-secondary">{selected.description}</p>

                  {isSuperAdmin ? (
                    <AlertMessage
                      variant="info"
                      message="SUPER_ADMIN always holds every permission and cannot be edited — this prevents locking everyone out of permission management."
                    />
                  ) : null}

                  {!canViewPermissions ? (
                    <p className="text-secondary mb-0">
                      You can see this role but not the permission catalogue. Granted permissions:{' '}
                      {selected.permissions.length || 'none'}.
                    </p>
                  ) : (
                    Object.entries(grouped).map(([module, items]) => (
                      <fieldset className="mb-3" key={module}>
                        <legend className="form-label fw-semibold text-uppercase small text-secondary mb-2">{module}</legend>
                        <div className="row g-2">
                          {items.map((permission) => (
                            <div className="col-12 col-md-6" key={permission.name}>
                              <div className="form-check">
                                <input
                                  className="form-check-input"
                                  type="checkbox"
                                  id={`perm-${permission.name}`}
                                  checked={isSuperAdmin ? true : draft.includes(permission.name)}
                                  onChange={() => toggle(permission.name)}
                                  disabled={!editable || saving}
                                />
                                <label className="form-check-label" htmlFor={`perm-${permission.name}`}>
                                  <span className="font-monospace small">{permission.name}</span>
                                  <span className="d-block text-secondary small">{permission.description}</span>
                                </label>
                              </div>
                            </div>
                          ))}
                        </div>
                      </fieldset>
                    ))
                  )}

                  {editable ? (
                    <div className="d-flex gap-2 pt-2 border-top">
                      <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!dirty || saving}>
                        {saving ? 'Saving…' : 'Save permissions'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline-secondary"
                        onClick={() => setDraft(selected.permissions)}
                        disabled={!dirty || saving}
                      >
                        Reset
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-secondary mb-0">Select a role.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
