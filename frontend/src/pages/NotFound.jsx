import { Link } from 'react-router-dom';
import useAuth from '../hooks/useAuth';

export default function NotFound() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="lms-fullpage-loader d-flex align-items-center justify-content-center text-center px-3">
      <div>
        <p className="display-4 fw-bold text-primary mb-1">404</p>
        <h1 className="h5 fw-semibold mb-2">Page not found</h1>
        <p className="text-secondary mb-4">The page you are looking for does not exist or has moved.</p>
        <Link className="btn btn-primary" to={isAuthenticated ? '/dashboard' : '/login'}>
          {isAuthenticated ? 'Back to dashboard' : 'Go to login'}
        </Link>
      </div>
    </div>
  );
}
