import { useState } from 'react';

/** Customers are deactivated rather than deleted, so status is always shown. */
export function CustomerStatusBadge({ status }) {
  const isActive = status === 'ACTIVE';
  return (
    <span className={`badge ${isActive ? 'text-bg-success' : 'text-bg-light border'}`}>
      <i className={`bi ${isActive ? 'bi-check-circle' : 'bi-slash-circle'} me-1`} aria-hidden="true" />
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );
}

/** CIFID with a copy button — it is the identifier staff quote to customers. */
export function CifIdBadge({ cifId, copyable = false, size = 'sm' }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cifId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context) — the value stays selectable.
    }
  };

  const badge = (
    <span className={`badge text-bg-light border font-monospace ${size === 'lg' ? 'fs-6' : ''}`}>{cifId}</span>
  );

  if (!copyable) return badge;

  return (
    <span className="d-inline-flex align-items-center gap-2">
      {badge}
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary py-0 px-1"
        onClick={handleCopy}
        title="Copy CIFID"
        aria-label="Copy CIFID"
      >
        <i className={`bi ${copied ? 'bi-check2' : 'bi-clipboard'}`} aria-hidden="true" />
      </button>
      {copied ? <span className="text-success small">Copied</span> : null}
    </span>
  );
}
