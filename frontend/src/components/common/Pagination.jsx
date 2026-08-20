/** Compact pager driven by the API's pagination envelope. */
export default function Pagination({ page, totalPages, total, limit, onChange }) {
  if (!totalPages || totalPages <= 1) {
    return total ? <p className="text-secondary small mb-0">{total} record{total === 1 ? '' : 's'}</p> : null;
  }

  const first = (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);

  // Window of at most five page buttons centred on the current page.
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const pages = Array.from({ length: Math.min(5, totalPages) }, (_, index) => start + index);

  return (
    <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
      <p className="text-secondary small mb-0">
        Showing {first}–{last} of {total}
      </p>

      <nav aria-label="User list pages">
        <ul className="pagination pagination-sm mb-0">
          <li className={`page-item${page <= 1 ? ' disabled' : ''}`}>
            <button type="button" className="page-link" onClick={() => onChange(page - 1)} disabled={page <= 1}>
              Previous
            </button>
          </li>
          {pages.map((number) => (
            <li className={`page-item${number === page ? ' active' : ''}`} key={number}>
              <button type="button" className="page-link" onClick={() => onChange(number)}>
                {number}
              </button>
            </li>
          ))}
          <li className={`page-item${page >= totalPages ? ' disabled' : ''}`}>
            <button type="button" className="page-link" onClick={() => onChange(page + 1)} disabled={page >= totalPages}>
              Next
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}
