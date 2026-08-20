import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Pagination from '../../components/common/Pagination';
import UserFormModal from '../../components/users/UserFormModal';
import ResetPasswordModal from '../../components/users/ResetPasswordModal';
import { RoleBadge, StatusBadge } from '../../components/users/UserBadges';
import useAuth from '../../hooks/useAuth';
import usePermissions from '../../hooks/usePermissions';
import { fetchUsers, changeUserStatus } from '../../services/userService';
import { PERMISSIONS } from '../../utils/permissions';
import { ROLES, formatRole } from '../../utils/constants';

const PAGE_SIZE = 20;
const INITIAL_FILTERS = { search: '', role: '', status: '' };

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function UsersListPage() {
  const { user: currentUser } = useAuth();
  const { can } = usePermissions();

  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(INITIAL_FILTERS);
  const [page, setPage] = useState(1);

  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [formModal, setFormModal] = useState({ open: false, mode: 'create', user: null });
  const [passwordModal, setPasswordModal] = useState({ open: false, user: null });

  const canCreate = can(PERMISSIONS.USERS_CREATE);
  const canUpdate = can(PERMISSIONS.USERS_UPDATE);
  const canResetPassword = can(PERMISSIONS.USERS_RESET_PASSWORD);
  const canActivate = can(PERMISSIONS.USERS_ACTIVATE);
  const canDeactivate = can(PERMISSIONS.USERS_DEACTIVATE);

  // Filtering and paging are done by the API, never in the browser.
  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetchUsers({ page, limit: PAGE_SIZE, ...appliedFilters });
      setUsers(response.data.users);
      setPagination(response.data.pagination);
    } catch (requestError) {
      setError(requestError.message);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [page, appliedFilters]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleSearch = (event) => {
    event.preventDefault();
    setPage(1);
    setAppliedFilters(filters);
  };

  const handleReset = () => {
    setFilters(INITIAL_FILTERS);
    setAppliedFilters(INITIAL_FILTERS);
    setPage(1);
  };

  const handleToggleStatus = async (target) => {
    const nextStatus = target.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    setBusyId(target.id);
    setError('');
    try {
      await changeUserStatus(target.id, nextStatus);
      setNotice(`${target.name} is now ${nextStatus === 'ACTIVE' ? 'active' : 'inactive'}`);
      await loadUsers();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaved = async (message) => {
    setFormModal({ open: false, mode: 'create', user: null });
    setPasswordModal({ open: false, user: null });
    setNotice(message);
    await loadUsers();
  };

  return (
    <div className="container-fluid px-0">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 fw-bold mb-1">Users</h1>
          <p className="text-secondary mb-0">Manage accounts, roles and access.</p>
        </div>
        {canCreate ? (
          <button type="button" className="btn btn-primary" onClick={() => setFormModal({ open: true, mode: 'create', user: null })}>
            <i className="bi bi-plus-lg me-2" aria-hidden="true" />
            New user
          </button>
        ) : null}
      </div>

      <AlertMessage message={notice} variant="success" onDismiss={() => setNotice('')} />
      <AlertMessage message={error} onDismiss={() => setError('')} />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <form className="row g-2 align-items-end" onSubmit={handleSearch}>
            <div className="col-12 col-md-5">
              <label className="form-label small fw-semibold" htmlFor="filter-search">
                Search
              </label>
              <input
                id="filter-search"
                className="form-control"
                placeholder="Name or email"
                value={filters.search}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              />
            </div>
            <div className="col-6 col-md-3">
              <label className="form-label small fw-semibold" htmlFor="filter-role">
                Role
              </label>
              <select
                id="filter-role"
                className="form-select"
                value={filters.role}
                onChange={(event) => setFilters((current) => ({ ...current, role: event.target.value }))}
              >
                <option value="">All roles</option>
                {Object.values(ROLES).map((role) => (
                  <option value={role} key={role}>
                    {formatRole(role)}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-6 col-md-2">
              <label className="form-label small fw-semibold" htmlFor="filter-status">
                Status
              </label>
              <select
                id="filter-status"
                className="form-select"
                value={filters.status}
                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
              >
                <option value="">All</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>
            <div className="col-12 col-md-2 d-flex gap-2">
              <button type="submit" className="btn btn-outline-primary flex-grow-1">
                Filter
              </button>
              <button type="button" className="btn btn-outline-secondary" onClick={handleReset} aria-label="Clear filters">
                <i className="bi bi-arrow-counterclockwise" aria-hidden="true" />
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col" className="text-end">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="6" className="py-5">
                    <Spinner label="Loading users…" />
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan="6" className="text-center text-secondary py-5">
                    No users match these filters.
                  </td>
                </tr>
              ) : (
                users.map((item) => {
                  const isSelf = item.id === currentUser?.id;
                  const toggleAllowed = item.status === 'ACTIVE' ? canDeactivate : canActivate;

                  return (
                    <tr key={item.id}>
                      <td>
                        <span className="fw-semibold">{item.name}</span>
                        {isSelf ? <span className="badge text-bg-light ms-2">You</span> : null}
                      </td>
                      <td className="text-break">{item.email}</td>
                      <td>
                        <RoleBadge role={item.role} />
                      </td>
                      <td>
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="text-secondary small">{formatDate(item.createdAt)}</td>
                      <td className="text-end">
                        <div className="btn-group btn-group-sm">
                          <Link className="btn btn-outline-secondary" to={`/users/${item.id}`} title="View">
                            <i className="bi bi-eye" aria-hidden="true" />
                          </Link>
                          {canUpdate ? (
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              title="Edit"
                              onClick={() => setFormModal({ open: true, mode: 'edit', user: { ...item, isSelf } })}
                            >
                              <i className="bi bi-pencil" aria-hidden="true" />
                            </button>
                          ) : null}
                          {toggleAllowed && !isSelf ? (
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              title={item.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                              onClick={() => handleToggleStatus(item)}
                              disabled={busyId === item.id}
                            >
                              <i className={`bi ${item.status === 'ACTIVE' ? 'bi-slash-circle' : 'bi-check-circle'}`} aria-hidden="true" />
                            </button>
                          ) : null}
                          {canResetPassword ? (
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              title="Reset password"
                              onClick={() => setPasswordModal({ open: true, user: item })}
                            >
                              <i className="bi bi-key" aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && users.length > 0 ? (
          <div className="card-footer bg-white border-top">
            <Pagination {...pagination} onChange={setPage} />
          </div>
        ) : null}
      </div>

      <UserFormModal
        open={formModal.open}
        mode={formModal.mode}
        user={formModal.user}
        onClose={() => setFormModal({ open: false, mode: 'create', user: null })}
        onSaved={handleSaved}
      />

      <ResetPasswordModal
        open={passwordModal.open}
        user={passwordModal.user}
        onClose={() => setPasswordModal({ open: false, user: null })}
        onSaved={handleSaved}
      />
    </div>
  );
}
