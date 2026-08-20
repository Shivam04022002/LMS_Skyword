import { useEffect, useState } from 'react';
import Spinner from '../common/Spinner';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { getCustomers } from '../../services/customerService';

/**
 * Picks an existing customer to attach to a loan.
 *
 * Reuses the Phase 3 customer search endpoint in selector mode (small `limit`)
 * rather than introducing a second search API. It never creates a customer —
 * if nobody matches, the operator is told to register them in Customers first.
 */
export default function PartySelector({ onSelect, excludeCustomerIds = [], activeOnly = true, autoFocus = false }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  const debouncedTerm = useDebouncedValue(term, 400);

  useEffect(() => {
    let cancelled = false;

    async function search() {
      if (debouncedTerm.trim().length < 2) {
        setResults([]);
        setSearched(false);
        return;
      }

      setLoading(true);
      setError('');
      try {
        const response = await getCustomers({
          search: debouncedTerm.trim(),
          limit: 10,
          ...(activeOnly ? { status: 'ACTIVE' } : {})
        });
        if (!cancelled) {
          setResults(response.data.customers);
          setSearched(true);
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError.message || 'Unable to search customers.');
          setResults([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    search();
    return () => {
      cancelled = true;
    };
  }, [debouncedTerm, activeOnly]);

  // Customers already on this loan cannot be added again.
  const selectable = results.filter((customer) => !excludeCustomerIds.includes(customer.id));

  return (
    <div>
      <label className="form-label small fw-semibold" htmlFor="party-selector-search">
        Find customer
      </label>
      <div className="input-group">
        <span className="input-group-text">
          <i className="bi bi-search" aria-hidden="true" />
        </span>
        <input
          id="party-selector-search"
          className="form-control"
          placeholder="Search CIFID, name or mobile"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          autoFocus={autoFocus}
        />
      </div>
      <div className="form-text">Customers must already exist. Register new customers under Customers.</div>

      {error ? <div className="alert alert-danger mt-3 mb-0 py-2">{error}</div> : null}

      <div className="mt-3">
        {loading ? (
          <Spinner label="Searching…" size="sm" />
        ) : searched && selectable.length === 0 ? (
          <p className="text-secondary mb-0">
            Customer not found{results.length > 0 ? ' — every match is already attached to this loan.' : '.'}
          </p>
        ) : (
          <ul className="list-group">
            {selectable.map((customer) => (
              <li key={customer.id} className="list-group-item d-flex align-items-center justify-content-between gap-3">
                <div className="min-w-0">
                  <div className="fw-semibold">{customer.fullName}</div>
                  <div className="small text-secondary">
                    <span className="font-monospace">{customer.cifId}</span>
                    <span className="mx-2">·</span>
                    <span className="font-monospace">{customer.mobile}</span>
                    {customer.status === 'INACTIVE' ? <span className="badge text-bg-warning ms-2">Inactive</span> : null}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary flex-shrink-0"
                  onClick={() => onSelect(customer)}
                  disabled={customer.status === 'INACTIVE'}
                  title={customer.status === 'INACTIVE' ? 'Inactive customers cannot be added' : 'Select'}
                >
                  Select
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
