import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Pagination from '../../components/common/Pagination';
import CollectionFormModal from '../../components/collections/CollectionFormModal';
import CollectionImportModal from '../../components/collections/CollectionImportModal';
import CollectionStatusBadge from '../../components/collections/CollectionStatusBadge';
import usePermissions from '../../hooks/usePermissions';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { getCollections } from '../../services/collectionService';
import { PERMISSIONS } from '../../utils/permissions';
import { formatCurrency } from '../../utils/loanConstants';
import { LEDGER_TYPES, COLLECTION_STATUSES, LEDGER_ICONS } from '../../utils/collectionConstants';

const PAGE_SIZE = 20;

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function CollectionsListPage() {
  const { can } = usePermissions();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', ledgerType: '', dateFrom: '', dateTo: '' });
  const [page, setPage] = useState(1);

  const [collections, setCollections] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 400);
  const canCreate = can(PERMISSIONS.COLLECTIONS_CREATE);
  const canImport = can(PERMISSIONS.COLLECTIONS_IMPORT);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filters.status, filters.ledgerType, filters.dateFrom, filters.dateTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getCollections({ page, limit: PAGE_SIZE, search: debouncedSearch, ...filters });
      setCollections(response.data.collections);
      setPagination(response.data.pagination);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load collections.');
      setCollections([]);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, filters]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaved = async (collection) => {
    setFormOpen(false);
    setNotice({ text: 'Collection posted successfully.', number: collection.collectionNumber });
    await load();
  };

  return (
    <div className="container-fluid px-0">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 fw-bold mb-1">Collections</h1>
          <p className="text-secondary mb-0">
            Payments received and how they were applied. Total = EMI collected + bounce collected.
          </p>
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
              Post collection
            </button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className="alert alert-success d-flex align-items-center gap-3" role="alert">
          <i className="bi bi-check-circle-fill" aria-hidden="true" />
          <div className="flex-grow-1">
            <div>{notice.text}</div>
            {notice.number ? (
              <div className="mt-1">
                <span className="fw-semibold">Collection number:</span>{' '}
                <span className="badge text-bg-light border font-monospace fs-6">{notice.number}</span>
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
            <div className="col-12 col-lg-4">
              <label className="form-label small fw-semibold" htmlFor="collection-search">
                Search
              </label>
              <div className="input-group">
                <span className="input-group-text">
                  <i className="bi bi-search" aria-hidden="true" />
                </span>
                <input
                  id="collection-search"
                  className="form-control"
                  placeholder="Collection number, loan number, CIFID or name"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
            <div className="col-6 col-lg-2">
              <label className="form-label small fw-semibold" htmlFor="collection-status-filter">
                Status
              </label>
              <select
                id="collection-status-filter"
                className="form-select"
                value={filters.status}
                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
              >
                <option value="">All</option>
                {COLLECTION_STATUSES.map((status) => (
                  <option value={status} key={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-6 col-lg-2">
              <label className="form-label small fw-semibold" htmlFor="collection-ledger-filter">
                Ledger
              </label>
              <select
                id="collection-ledger-filter"
                className="form-select"
                value={filters.ledgerType}
                onChange={(event) => setFilters((current) => ({ ...current, ledgerType: event.target.value }))}
              >
                <option value="">All</option>
                {LEDGER_TYPES.map((type) => (
                  <option value={type} key={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-6 col-lg-2">
              <label className="form-label small fw-semibold" htmlFor="collection-date-from">
                From
              </label>
              <input
                id="collection-date-from"
                type="date"
                className="form-control"
                value={filters.dateFrom}
                onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))}
              />
            </div>
            <div className="col-6 col-lg-2">
              <label className="form-label small fw-semibold" htmlFor="collection-date-to">
                To
              </label>
              <input
                id="collection-date-to"
                type="date"
                className="form-control"
                value={filters.dateTo}
                onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th scope="col">Collection</th>
                <th scope="col">Loan</th>
                <th scope="col">Customer</th>
                {/* The two components, then the total they add up to. */}
                <th scope="col" className="text-end">EMI collected</th>
                <th scope="col" className="text-end">Bounce collected</th>
                <th scope="col" className="text-end">Total</th>
                <th scope="col">Date</th>
                <th scope="col">Ledger</th>
                <th scope="col">Status</th>
                <th scope="col">Collected by</th>
                <th scope="col" className="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="11" className="py-5">
                    <Spinner label="Loading collections…" />
                  </td>
                </tr>
              ) : collections.length === 0 ? (
                <tr>
                  <td colSpan="11" className="text-center text-secondary py-5">
                    No collections found.
                  </td>
                </tr>
              ) : (
                collections.map((collection) => (
                  <tr key={collection.id} className={collection.status === 'REVERSED' ? 'text-secondary' : undefined}>
                    <td>
                      <span className="badge text-bg-light border font-monospace">{collection.collectionNumber}</span>
                    </td>
                    <td className="font-monospace small">{collection.loanNumber ?? '—'}</td>
                    <td>
                      <div className="fw-semibold">{collection.customer?.fullName ?? '—'}</div>
                      <div className="small text-secondary font-monospace">{collection.customer?.cifId}</div>
                    </td>
                    <td className="text-end small">{formatCurrency(collection.emiCollected)}</td>
                    <td className="text-end small text-secondary">{formatCurrency(collection.bounceCollected)}</td>
                    <td className="text-end fw-semibold">{formatCurrency(collection.amount)}</td>
                    <td className="small">{formatDate(collection.collectionDate)}</td>
                    <td>
                      <i className={`bi ${LEDGER_ICONS[collection.ledgerType]} me-1`} aria-hidden="true" />
                      {collection.ledgerType}
                    </td>
                    <td>
                      <CollectionStatusBadge status={collection.status} />
                    </td>
                    <td className="small text-secondary">{collection.createdBy ?? '—'}</td>
                    <td className="text-end">
                      <Link className="btn btn-sm btn-outline-secondary" to={`/collections/${collection.id}`} title="View">
                        <i className="bi bi-eye" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && collections.length > 0 ? (
          <div className="card-footer bg-white border-top">
            <Pagination {...pagination} onChange={setPage} />
          </div>
        ) : null}
      </div>

      <CollectionFormModal open={formOpen} onClose={() => setFormOpen(false)} onSaved={handleSaved} />

      <CollectionImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={async (data) => {
          // The modal stays open to show its summary; the list behind it is
          // refreshed so the posted collections are there when it closes.
          setNotice({ text: `${data.summary.importedRows} collection(s) posted, totalling ${data.summary.importedAmount}.` });
          await load();
        }}
      />
    </div>
  );
}
