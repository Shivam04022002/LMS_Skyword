import { useState } from 'react';
import useAuth from '../../hooks/useAuth';
import { ORGANISATION_NAME, formatRole } from '../../utils/constants';
import skywordLogo from '../../assets/SkyWord Logo.png';

/** Top bar: sidebar toggle on small screens, brand, and the user menu. */
export default function Header({ onToggleSidebar }) {
  const { user, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  const handleLogout = async () => {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  };

  const initials = (user?.name ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

  return (
    <header className="lms-header d-flex align-items-center gap-3 px-3">
      <button
        type="button"
        className="btn btn-sm btn-outline-light d-lg-none"
        onClick={onToggleSidebar}
        aria-label="Toggle navigation"
      >
        <i className="bi bi-list" aria-hidden="true" />
      </button>

      <span className="lms-brand">
        {/* The logo carries the accessible name so the brand is announced once,
            at any width — the text beside it is hidden below `sm`. */}
        <img className="lms-brand-logo" src={skywordLogo} width="1672" height="941" alt={ORGANISATION_NAME} />
        <span className="lms-brand-name d-none d-sm-block" aria-hidden="true">
          {ORGANISATION_NAME}
        </span>
      </span>

      <div className="ms-auto dropdown">
        <button
          className="btn btn-sm lms-user-button dropdown-toggle d-flex align-items-center gap-2"
          type="button"
          data-bs-toggle="dropdown"
          aria-expanded="false"
        >
          <span className="lms-avatar">{initials}</span>
          <span className="d-none d-md-flex flex-column text-start lh-1">
            <span className="fw-semibold">{user?.name}</span>
            <small className="text-white-50">{formatRole(user?.role)}</small>
          </span>
        </button>

        <ul className="dropdown-menu dropdown-menu-end shadow-sm">
          <li className="px-3 py-2">
            <div className="fw-semibold">{user?.name}</div>
            <div className="small text-secondary text-break">{user?.email}</div>
          </li>
          <li>
            <hr className="dropdown-divider" />
          </li>
          <li>
            <button className="dropdown-item text-danger" type="button" onClick={handleLogout} disabled={signingOut}>
              <i className="bi bi-box-arrow-right me-2" aria-hidden="true" />
              {signingOut ? 'Signing out…' : 'Logout'}
            </button>
          </li>
        </ul>
      </div>
    </header>
  );
}
