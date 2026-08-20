import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import useAuth from '../hooks/useAuth';
import AlertMessage from '../components/common/AlertMessage';
import { toFieldErrors } from '../utils/errorHandler';
import { ORGANISATION_NAME } from '../utils/constants';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate({ email, password }) {
  const errors = {};
  if (!email.trim()) errors.email = 'Email is required';
  else if (!EMAIL_PATTERN.test(email.trim())) errors.email = 'Enter a valid email address';
  if (!password) errors.password = 'Password is required';
  return errors;
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const redirectTo = location.state?.from ?? '/dashboard';

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => ({ ...current, [name]: undefined }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');

    const errors = validate(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      await login({ email: form.email.trim(), password: form.password });
      navigate(redirectTo, { replace: true });
    } catch (error) {
      setFormError(error.message);
      setFieldErrors(toFieldErrors(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="lms-login-page d-flex align-items-center justify-content-center px-3 py-5">
      <div className="lms-login-card card border-0 shadow-lg">
        <div className="card-body p-4 p-sm-5">
          <div className="text-center mb-4">
            <span className="lms-login-logo">
              <i className="bi bi-bank2" aria-hidden="true" />
            </span>
            <h1 className="h5 fw-bold mt-3 mb-1">{ORGANISATION_NAME}</h1>
            <p className="text-secondary mb-0">Sign in to continue</p>
          </div>

          <AlertMessage message={formError} onDismiss={() => setFormError('')} />

          <form onSubmit={handleSubmit} noValidate>
            <div className="mb-3">
              <label htmlFor="email" className="form-label fw-semibold">
                Email
              </label>
              <div className="input-group has-validation">
                <span className="input-group-text">
                  <i className="bi bi-envelope" aria-hidden="true" />
                </span>
                <input
                  id="email"
                  name="email"
                  type="email"
                  className={`form-control${fieldErrors.email ? ' is-invalid' : ''}`}
                  placeholder="you@company.com"
                  value={form.email}
                  onChange={handleChange}
                  autoComplete="username"
                  autoFocus
                  disabled={submitting}
                />
                <div className="invalid-feedback">{fieldErrors.email}</div>
              </div>
            </div>

            <div className="mb-4">
              <label htmlFor="password" className="form-label fw-semibold">
                Password
              </label>
              <div className="input-group has-validation">
                <span className="input-group-text">
                  <i className="bi bi-lock" aria-hidden="true" />
                </span>
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  className={`form-control${fieldErrors.password ? ' is-invalid' : ''}`}
                  placeholder="Enter your password"
                  value={form.password}
                  onChange={handleChange}
                  autoComplete="current-password"
                  disabled={submitting}
                />
                <button
                  type="button"
                  className="btn btn-outline-secondary"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  disabled={submitting}
                >
                  <i className={`bi ${showPassword ? 'bi-eye-slash' : 'bi-eye'}`} aria-hidden="true" />
                </button>
                <div className="invalid-feedback">{fieldErrors.password}</div>
              </div>
            </div>

            <button type="submit" className="btn btn-primary w-100 py-2 fw-semibold" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                'Login'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
