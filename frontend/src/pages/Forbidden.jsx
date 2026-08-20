import { Link } from 'react-router-dom';

/** Shown when an authenticated user lacks the permission for a page. */
export default function Forbidden() {
  return (
    <div className="text-center py-5">
      <p className="display-5 fw-bold text-warning mb-1">403</p>
      <h1 className="h5 fw-semibold mb-2">Access denied</h1>
      <p className="text-secondary mb-4">
        Your role does not include permission to view this page. Contact an administrator if you believe this is a mistake.
      </p>
      <Link className="btn btn-outline-primary" to="/dashboard">
        Back to dashboard
      </Link>
    </div>
  );
}
