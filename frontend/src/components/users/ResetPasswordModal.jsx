import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import { resetUserPassword } from '../../services/userService';
import { toFieldErrors } from '../../utils/errorHandler';

/** Administrative password reset. The value is sent in the body, never a URL. */
export default function ResetPasswordModal({ open, user, onClose, onSaved }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setConfirm('');
    setFieldErrors({});
    setFormError('');
  }, [open]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');

    const errors = {};
    if (!password) errors.newPassword = 'A new password is required';
    else if (password.length < 8) errors.newPassword = 'Password must be at least 8 characters';
    else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      errors.newPassword = 'Password must contain at least one letter and one number';
    }
    if (password !== confirm) errors.confirm = 'Passwords do not match';

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      await resetUserPassword(user.id, password);
      onSaved(`Password reset for ${user.name}`);
    } catch (error) {
      setFormError(error.message);
      setFieldErrors(toFieldErrors(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Reset password" open={open} onClose={submitting ? () => {} : onClose}>
      <form onSubmit={handleSubmit} noValidate>
        <div className="modal-body">
          <AlertMessage message={formError} onDismiss={() => setFormError('')} />

          <p className="text-secondary">
            Set a new password for <strong>{user?.name}</strong> ({user?.email}). They will need it at their next sign-in.
          </p>

          <div className="mb-3">
            <label className="form-label fw-semibold" htmlFor="reset-password">
              New password
            </label>
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              className={`form-control${fieldErrors.newPassword ? ' is-invalid' : ''}`}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFieldErrors((current) => ({ ...current, newPassword: undefined }));
              }}
              disabled={submitting}
            />
            <div className="invalid-feedback">{fieldErrors.newPassword}</div>
            <div className="form-text">At least 8 characters, including a letter and a number.</div>
          </div>

          <div className="mb-0">
            <label className="form-label fw-semibold" htmlFor="reset-confirm">
              Confirm password
            </label>
            <input
              id="reset-confirm"
              type="password"
              autoComplete="new-password"
              className={`form-control${fieldErrors.confirm ? ' is-invalid' : ''}`}
              value={confirm}
              onChange={(event) => {
                setConfirm(event.target.value);
                setFieldErrors((current) => ({ ...current, confirm: undefined }));
              }}
              disabled={submitting}
            />
            <div className="invalid-feedback">{fieldErrors.confirm}</div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={submitting}>
            {submitting ? 'Resetting…' : 'Reset password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
