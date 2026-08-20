import { useEffect } from 'react';

/**
 * Bootstrap-styled modal rendered directly by React (no Bootstrap JS), so open
 * state stays in the component tree.
 */
export default function Modal({ title, open, onClose, children, footer, size = '' }) {
  // Escape closes; the body must not scroll behind the dialog.
  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.classList.add('modal-open');

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.classList.remove('modal-open');
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="modal fade show d-block" role="dialog" aria-modal="true" tabIndex="-1">
        <div className={`modal-dialog modal-dialog-centered ${size}`}>
          <div className="modal-content border-0 shadow">
            <div className="modal-header">
              <h2 className="modal-title h6 fw-bold">{title}</h2>
              <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
            </div>
            {children}
            {footer ? <div className="modal-footer">{footer}</div> : null}
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show" />
    </>
  );
}
