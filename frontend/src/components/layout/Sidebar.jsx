import { NavLink } from 'react-router-dom';
import { getNavigationForUser } from '../../routes/navigation';
import useAuth from '../../hooks/useAuth';

/**
 * Renders the navigation defined in routes/navigation.js.
 * Items that are not available yet stay visible but inert, so the shape of the
 * product is clear without pretending the modules exist.
 */
export default function Sidebar({ isOpen, onNavigate }) {
  const { user } = useAuth();
  const sections = getNavigationForUser(user);

  return (
    <aside className={`lms-sidebar${isOpen ? ' is-open' : ''}`} aria-label="Main navigation">
      <nav className="lms-sidebar-nav">
        {sections.map((section) => (
          <div key={section.id} className="mb-3">
            <p className="lms-sidebar-heading">{section.label}</p>
            <ul className="nav flex-column">
              {section.items.map((item) => (
                <li className="nav-item" key={item.id}>
                  {item.available ? (
                    <NavLink
                      to={item.path}
                      className={({ isActive }) => `lms-nav-link${isActive ? ' active' : ''}`}
                      onClick={onNavigate}
                    >
                      <i className={`bi ${item.icon}`} aria-hidden="true" />
                      <span>{item.label}</span>
                    </NavLink>
                  ) : (
                    <span className="lms-nav-link disabled" aria-disabled="true" title="Available in a future phase">
                      <i className={`bi ${item.icon}`} aria-hidden="true" />
                      <span>{item.label}</span>
                      <span className="badge rounded-pill text-bg-light ms-auto">Soon</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="lms-sidebar-footer small text-secondary">Phase 1 · Foundation</div>
    </aside>
  );
}
