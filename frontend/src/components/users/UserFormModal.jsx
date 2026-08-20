import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import usePermissions from '../../hooks/usePermissions';
import { createUser, updateUser, changeUserRole } from '../../services/userService';
import { toFieldErrors } from '../../utils/errorHandler';
import { PERMISSIONS } from '../../utils/permissions';
import { ROLES, formatRole } from '../../utils/constants';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Fallback when the caller cannot read /admin/roles; mirrors the backend list. */
const ROLE_OPTIONS = Object.values(ROLES);
const EMPTY = { name: '', email: '', password: '', role: ROLES.STAFF, status: 'ACTIVE' };

function validate(form, mode) {
  const errors = {};
  if (!form.name.trim()) errors.name = 'Name is required';
  if (!form.email.trim()) errors.email = 'Email is required';
  else if (!EMAIL_PATTERN.test(form.email.trim())) errors.email = 'Enter a valid email address';

  if (mode === 'create') {
    if (!form.password) errors.password = 'Password is required';
    else if (form.password.length < 8) errors.password = 'Password must be at least 8 characters';
    else if (!/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)) {
      errors.password = 'Password must contain at least one letter and one number';
    }
  }

  return errors;
}

/**
 * Create/edit dialog. Password is only ever set here at creation time.
 *
 * `roles` lets the caller supply the roles actually defined in the backend; it
 * falls back to the shared constants when the caller cannot read /admin/roles.
 */
export default function UserFormModal({ open, mode = 'create', user = null, roles = null, onClose, onSaved }) {
  const { can } = usePermissions();
  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canAssignRole = can(PERMISSIONS.USERS_ASSIGN_ROLE);
  // The user's current role stays listed even if it is missing from the fetched
  // set, so an edit form never silently reassigns somebody.
  const roleOptions = Array.isArray(roles) && roles.length > 0
    ? [...new Set(user?.role ? [...roles, user.role] : roles)]
    : ROLE_OPTIONS;

  useEffect(() => {
    if (!open) return;
    setForm(
      mode === 'edit' && user
        ? { name: user.name, email: user.email, password: '', role: user.role, status: user.status }
        : EMPTY
    );
    setFieldErrors({});
    setFormError('');
  }, [open, mode, user]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => ({ ...current, [name]: undefined }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');

    const errors = validate(form, mode);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'create') {
        await createUser({
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: form.role,
          status: form.status
        });
      } else {
        await updateUser(user.id, { name: form.name.trim(), email: form.email.trim(), status: form.status });
        // Role lives behind its own permission and its own endpoint.
        if (canAssignRole && form.role !== user.role) {
          await changeUserRole(user.id, form.role);
        }
      }

      onSaved(mode === 'create' ? 'User created successfully' : 'User updated successfully');
    } catch (error) {
      setFormError(error.message);
      setFieldErrors(toFieldErrors(error));
    } finally {
      setSubmitting(false);
    }
  };

  const isSelf = mode === 'edit' && user?.isSelf;

  return (
    <Modal title={mode === 'create' ? 'Create user' : 'Edit user'} open={open} onClose={submitting ? () => {} : onClose}>
      <form onSubmit={handleSubmit} noValidate>
        <div className="modal-body">
          <AlertMessage message={formError} onDismiss={() => setFormError('')} />

          <div className="mb-3">
            <label className="form-label fw-semibold" htmlFor="user-name">
              Name
            </label>
            <input
              id="user-name"
              name="name"
              className={`form-control${fieldErrors.name ? ' is-invalid' : ''}`}
              value={form.name}
              onChange={handleChange}
              disabled={submitting}
              autoFocus
            />
            <div className="invalid-feedback">{fieldErrors.name}</div>
          </div>

          <div className="mb-3">
            <label className="form-label fw-semibold" htmlFor="user-email">
              Email
            </label>
            <input
              id="user-email"
              name="email"
              type="email"
              className={`form-control${fieldErrors.email ? ' is-invalid' : ''}`}
              value={form.email}
              onChange={handleChange}
              disabled={submitting}
            />
            <div className="invalid-feedback">{fieldErrors.email}</div>
          </div>

          {mode === 'create' ? (
            <div className="mb-3">
              <label className="form-label fw-semibold" htmlFor="user-password">
                Password
              </label>
              <input
                id="user-password"
                name="password"
                type="password"
                autoComplete="new-password"
                className={`form-control${fieldErrors.password ? ' is-invalid' : ''}`}
                value={form.password}
                onChange={handleChange}
                disabled={submitting}
              />
              <div className="invalid-feedback">{fieldErrors.password}</div>
              <div className="form-text">At least 8 characters, including a letter and a number.</div>
            </div>
          ) : null}

          <div className="row g-3">
            <div className="col-12 col-sm-6">
              <label className="form-label fw-semibold" htmlFor="user-role">
                Role
              </label>
              <select
                id="user-role"
                name="role"
                className={`form-select${fieldErrors.role ? ' is-invalid' : ''}`}
                value={form.role}
                onChange={handleChange}
                disabled={submitting || (mode === 'edit' && !canAssignRole)}
              >
                {roleOptions.map((role) => (
                  <option value={role} key={role}>
                    {formatRole(role)}
                  </option>
                ))}
              </select>
              <div className="invalid-feedback">{fieldErrors.role}</div>
              {mode === 'edit' && !canAssignRole ? <div className="form-text">You cannot change roles.</div> : null}
            </div>

            <div className="col-12 col-sm-6">
              <label className="form-label fw-semibold" htmlFor="user-status">
                Status
              </label>
              <select
                id="user-status"
                name="status"
                className="form-select"
                value={form.status}
                onChange={handleChange}
                disabled={submitting || isSelf}
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
              {isSelf ? <div className="form-text">You cannot change your own status.</div> : null}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                Saving…
              </>
            ) : (
              'Save'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
