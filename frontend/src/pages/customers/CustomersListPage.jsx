import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Pagination from '../../components/common/Pagination';
import CustomerFormModal from '../../components/customers/CustomerFormModal';
import CustomerImportModal from '../../components/customers/CustomerImportModal';
import { CustomerStatusBadge, CifIdBadge } from '../../components/customers/CustomerBadges';
import usePermissions from '../../hooks/usePermissions';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { getCustomers, updateCustomerStatus } from '../../services/customerService';
import { PERMISSIONS } from '../../utils/permissions';

const PAGE_SIZE = 20;

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function CustomersListPage() {
  const { can } = usePermissions();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', state: '', city: '' });
  const [page, setPage] = useState(1);

  const [customers, setCustomers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [formModal, setFormModal] = useState({ open: false, mode: 'create', customer: null });
  const [importOpen, setImportOpen] = useState(false);

  // One request after typing settles, rather than one per keystroke.
  const debouncedSearch = useDebouncedValue(search, 400);

  const canCreate = can(PERMISSIONS.CUSTOMERS_CREATE);
  const canImport = can(PERMISSIONS.CUSTOMERS_IMPORT);
  const canUpdate = can(PERMISSIONS.CUSTOMERS_UPDATE);
  const canActivate = can(PERMISSIONS.CUSTOMERS_ACTIVATE);
  const canDeactivate = can(PERMISSIONS.CUSTOMERS_DEACTIVATE);

  // Any change to search or filters returns to the first page.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filters.status, filters.state, filters.city]);

  const loadCustomers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getCustomers({ page, limit: PAGE_SIZE, search: debouncedSearch, ...filters });
      setCustomers(response.data.customers);
      setPagination(response.data.pagination);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load customers.');
      setCustomers([]);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, filters]);

  useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

  const handleToggleStatus = async (customer) => {
    const nextStatus = customer.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    setBusyId(customer.id);
    setError('');
    try {
      await updateCustomerStatus(customer.id, nextStatus);
      setNotice({ text: `${customer.fullName} is now ${nextStatus === 'ACTIVE' ? 'active' : 'inactive'}.` });
      await loadCustomers();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaved = async ({ mode, customer }) => {
    setFormModal({ open: false, mode: 'create', customer: null });
    setNotice(
      mode === 'create'
        ? { text: 'Customer created successfully.', cifId: customer.cifId }
        : { text: 'Customer updated successfully.' }
    );
    await loadCustomers();
  };

  const clearFilters = () => {
    setSearch('');
    setFilters({ status: '', state: '', city: '' });
  };

  return (
    <div className="container-fluid px-0">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 fw-bold mb-1">Customers</h1>
          <p className="text-secondary mb-0">Central customer register. Each customer has a permanent CIFID.</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          {canImport ? (
            <button type="button" className="btn btn-outline-primary" onClick={() => setImportOpen(true)}>
              <i className="bi bi-file-earmark-arrow-up me-2" aria-hidden="true" />
              Bulk import
            </button>
          ) : null}
          {canCreate ? (
            <button type="button" className="btn btn-primary" onClick={() => setFormModal({ open: true, mode: 'create', customer: null })}>
              <i className="bi bi-plus-lg me-2" aria-hidden="true" />
              New customer
            </button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className="alert alert-success d-flex align-items-center gap-3" role="alert">
          <i className="bi bi-check-circle-fill" aria-hidden="true" />
          <div className="flex-grow-1">
            <div>{notice.text}</div>
            {notice.cifId ? (
              <div className="mt-2 d-flex align-items-center gap-2">
                <span className="fw-semibold">CIFID:</span>
                <CifIdBadge cifId={notice.cifId} copyable size="lg" />
              </div>
            ) : null}
          </div>
          <button type="button" className="btn-close" aria-label="Dismiss" onClick={() => setNotice(null)} />
        </div>
      ) : null}

      <AlertMessage message={error} onDismiss={() => setError('')} />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            <div className="col-12 col-lg-5">
              <label className="form-label small fw-semibold" htmlFor="customer-search">
                Search
              </label>
              <div className="input-group">
                <span className="input-group-text">
                  <i className="bi bi-search" aria-hidden="true" />
                </span>
                <input
                  id="customer-search"
                  className="form-control"
                  placeholder="Search CIFID, name, mobile or email"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
            <div className="col-6 col-lg-2">
              <label className="form-label small fw-semibold" htmlFor="customer-status">
                Status
              </label>
              <select
                id="customer-status"
                className="form-select"
                value={filters.status}
                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
              >
                <option value="">All</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>
            <div className="col-6 col-lg-2">
              <label className="form-label small fw-semibold" htmlFor="customer-state">
                State
              </label>
              <input
                id="customer-state"
                className="form-control"
                value={filters.state}
                onChange={(event) => setFilters((current) => ({ ...current, state: event.target.value }))}
              />
            </div>
            <div className="col-6 col-lg-2">
              <label className="form-label small fw-semibold" htmlFor="customer-city">
                City
              </label>
              <input
                id="customer-city"
                className="form-control"
                value={filters.city}
                onChange={(event) => setFilters((current) => ({ ...current, city: event.target.value }))}
              />
            </div>
            <div className="col-6 col-lg-1 d-grid">
              <button type="button" className="btn btn-outline-secondary" onClick={clearFilters} title="Clear filters">
                <i className="bi bi-arrow-counterclockwise" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th scope="col">CIFID</th>
                <th scope="col">Customer</th>
                <th scope="col">Mobile</th>
                <th scope="col">Email</th>
                <th scope="col">City</th>
                <th scope="col">State</th>
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
                  <td colSpan="9" className="py-5">
                    <Spinner label="Loading customers…" />
                  </td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan="9" className="text-center text-secondary py-5">
                    No customers found.
                  </td>
                </tr>
              ) : (
                customers.map((customer) => {
                  const toggleAllowed = customer.status === 'ACTIVE' ? canDeactivate : canActivate;

                  return (
                    <tr key={customer.id}>
                      <td>
                        <CifIdBadge cifId={customer.cifId} />
                      </td>
                      <td className="fw-semibold">{customer.fullName}</td>
                      <td className="font-monospace">{customer.mobile}</td>
                      <td className="text-break">{customer.email || <span className="text-secondary">—</span>}</td>
                      <td>{customer.city || <span className="text-secondary">—</span>}</td>
                      <td>{customer.state || <span className="text-secondary">—</span>}</td>
                      <td>
                        <CustomerStatusBadge status={customer.status} />
                      </td>
                      <td className="text-secondary small">{formatDate(customer.createdAt)}</td>
                      <td className="text-end">
                        <div className="btn-group btn-group-sm">
                          <Link className="btn btn-outline-secondary" to={`/customers/${customer.id}`} title="View">
                            <i className="bi bi-eye" aria-hidden="true" />
                          </Link>
                          {canUpdate ? (
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              title="Edit"
                              onClick={() => setFormModal({ open: true, mode: 'edit', customer })}
                            >
                              <i className="bi bi-pencil" aria-hidden="true" />
                            </button>
                          ) : null}
                          {toggleAllowed ? (
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              title={customer.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                              onClick={() => handleToggleStatus(customer)}
                              disabled={busyId === customer.id}
                            >
                              <i
                                className={`bi ${customer.status === 'ACTIVE' ? 'bi-slash-circle' : 'bi-check-circle'}`}
                                aria-hidden="true"
                              />
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

        {!loading && customers.length > 0 ? (
          <div className="card-footer bg-white border-top">
            <Pagination {...pagination} onChange={setPage} />
          </div>
        ) : null}
      </div>

      <CustomerFormModal
        open={formModal.open}
        mode={formModal.mode}
        customer={formModal.customer}
        onClose={() => setFormModal({ open: false, mode: 'create', customer: null })}
        onSaved={handleSaved}
      />

      <CustomerImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={async (data) => {
          // The modal stays open to show its summary; the list behind it is
          // refreshed so the new CIFIDs are there when it closes.
          setNotice({ text: `${data.summary.importedRows} customer(s) imported.` });
          await loadCustomers();
        }}
      />
    </div>
  );
}
