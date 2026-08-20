import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from '../components/layout/Header';
import Sidebar from '../components/layout/Sidebar';

/** Header + sidebar + content shell shared by every authenticated page. */
export default function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  // On small screens the drawer should not stay open across navigations.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="lms-shell">
      <Header onToggleSidebar={() => setSidebarOpen((open) => !open)} />

      <Sidebar isOpen={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />

      {sidebarOpen ? (
        <div className="lms-sidebar-backdrop d-lg-none" role="presentation" onClick={() => setSidebarOpen(false)} />
      ) : null}

      <main className="lms-content">
        <Outlet />
      </main>
    </div>
  );
}
