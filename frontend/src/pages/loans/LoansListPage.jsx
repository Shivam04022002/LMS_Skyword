import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Pagination from '../../components/common/Pagination';
import LoanFormModal from '../../components/loans/LoanFormModal';
import LoanImportModal from '../../components/loans/LoanImportModal';
import LoanStatusBadge from '../../components/loans/LoanStatusBadge';
import usePermissions from '../../hooks/usePermissions';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { getLoans } from '../../services/loanService';
import { PERMISSIONS } from '../../utils/permissions';
import { LOAN_TYPES, LOAN_STATUSES, PERIOD_LABELS, formatCurrency, titleCase } from '../../utils/loanConstants';

const PAGE_SIZE = 20;

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function LoansListPage() {
  const { can } = usePermissions();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', loanType: '' });
  const [page, setPage] = useState(1);

  const [loans, setLoans] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 400);
  const canCreate = can(PERMISSIONS.LOANS_CREATE);
  const canImport = can(PERMISSIONS.LOANS_IMPORT);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filters.status, filters.loanType]);

  const loadLoans = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getLoans({ page, limit: PAGE_SIZE, search: debouncedSearch, ...filters });
      setLoans(response.data.loans);
      setPagination(response.data.pagination);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load loans.');
      setLoans([]);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, filters]);

  useEffect(() => {
    loadLoans();
  }, [loadLoans]);

  const handleSaved = async ({ loan }) => {
    setFormOpen(false);
    setNotice({ text: 'Loan created successfully.', loanNumber: loan.loanNumber });
    await loadLoans();
  };

  return (
    <div className="container-fluid px-0">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 fw-bold mb-1">Loans</h1>
          <p className="text-secondary mb-0">Loan agreements and their parties.</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          {canImport ? (
            <button type="button" className="btn btn-outline-primary" onClick={() => setImportOpen(true)}>
              <i className="bi bi-file-earmark-arrow-up me-2" aria-hidden="true" />
              Bulk import
            </button>
          ) : null}
          {canCreate ? (
            <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
              <i className="bi bi-plus-lg me-2" aria-hidden="true" />
              New loan
            </button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className="alert alert-success d-flex align-items-center gap-3" role="alert">
          <i className="bi bi-check-circle-fill" aria-hidden="true" />
          <div className="flex-grow-1">
            <div>{notice.text}</div>
            {notice.loanNumber ? (
              <div className="mt-1">
                <span className="fw-semibold">Loan number:</span>{' '}
                <span className="badge text-bg-light border font-monospace fs-6">{notice.loanNumber}</span>
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
            <div className="col-12 col-lg-6">
              <label className="form-label small fw-semibold" htmlFor="loan-search">
                Search
              </label>
              <div className="input-group">
                <span className="input-group-text">
                  <i className="bi bi-search" aria-hidden="true" />
                </span>
                <input
                  id="loan-search"
                  className="form-control"
                  placeholder="Search loan number, CIFID, customer name or mobile"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
            <div className="col-6 col-lg-3">
              <label className="form-label small fw-semibold" htmlFor="loan-status-filter">
                Status
              </label>
              <select
                id="loan-status-filter"
                className="form-select"
                value={filters.status}
                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
              >
                <option value="">All</option>
                {LOAN_STATUSES.map((status) => (
                  <option value={status} key={status}>
                    {titleCase(status)}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-6 col-lg-3">
              <label className="form-label small fw-semibold" htmlFor="loan-type-filter">
                Loan type
              </label>
              <select
                id="loan-type-filter"
                className="form-select"
                value={filters.loanType}
                onChange={(event) => setFilters((current) => ({ ...current, loanType: event.target.value }))}
              >
                <option value="">All</option>
                {LOAN_TYPES.map((type) => (
                  <option value={type} key={type}>
                    {titleCase(type)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th scope="col">Loan number</th>
                <th scope="col">Applicant</th>
                <th scope="col">CIFID</th>
                <th scope="col" className="text-end">Amount</th>
                <th scope="col">Type</th>
                <th scope="col" className="text-end">Tenure</th>
                <th scope="col" className="text-end">EMI</th>
                <th scope="col">Status</th>
                <th scope="col">Start date</th>
                <th scope="col" className="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="10" className="py-5">
                    <Spinner label="Loading loans…" />
                  </td>
                </tr>
              ) : loans.length === 0 ? (
                <tr>
                  <td colSpan="10" className="text-center text-secondary py-5">
                    No loans found.
                  </td>
                </tr>
              ) : (
                loans.map((loan) => (
                  <tr key={loan.id}>
                    <td>
                      <span className="badge text-bg-light border font-monospace">{loan.loanNumber}</span>
                    </td>
                    <td className="fw-semibold">
                      {loan.applicant?.fullName ?? <span className="text-secondary fw-normal">No applicant</span>}
                    </td>
                    <td className="font-monospace small">{loan.applicant?.cifId ?? '—'}</td>
                    <td className="text-end">{formatCurrency(loan.loanAmount)}</td>
                    <td>{titleCase(loan.loanType)}</td>
                    <td className="text-end">
                      {loan.tenure} <span className="text-secondary small">{PERIOD_LABELS[loan.loanType]}</span>
                    </td>
                    <td className="text-end">{formatCurrency(loan.emiAmount)}</td>
                    <td>
                      <LoanStatusBadge status={loan.status} />
                    </td>
                    <td className="text-secondary small">{formatDate(loan.startDate)}</td>
                    <td className="text-end">
                      <Link className="btn btn-sm btn-outline-secondary" to={`/loans/${loan.id}`} title="View">
                        <i className="bi bi-eye" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && loans.length > 0 ? (
          <div className="card-footer bg-white border-top">
            <Pagination {...pagination} onChange={setPage} />
          </div>
        ) : null}
      </div>

      <LoanFormModal open={formOpen} mode="create" onClose={() => setFormOpen(false)} onSaved={handleSaved} />

      <LoanImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={async (data) => {
          // The modal stays open to show its summary; the list behind it is
          // refreshed so the imported loans are there when it closes.
          setNotice({ text: `${data.summary.importedRows} loan(s) imported.` });
          await loadLoans();
        }}
      />
    </div>
  );
}
