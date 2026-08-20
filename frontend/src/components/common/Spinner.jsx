/** Bootstrap spinner, optionally centred over the full viewport. */
export default function Spinner({ label = 'Loading…', fullPage = false, size = 'md' }) {
  const spinner = (
    <div className="text-center text-secondary">
      <div
        className={`spinner-border text-primary${size === 'sm' ? ' spinner-border-sm' : ''}`}
        role="status"
        aria-hidden="true"
      />
      {label ? <p className="mt-2 mb-0 small">{label}</p> : null}
      <span className="visually-hidden">{label || 'Loading'}</span>
    </div>
  );

  if (!fullPage) return spinner;

  return <div className="lms-fullpage-loader d-flex align-items-center justify-content-center">{spinner}</div>;
}
