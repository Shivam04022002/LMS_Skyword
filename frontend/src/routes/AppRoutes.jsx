import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';
import PublicRoute from './PublicRoute';
import RequirePermission from './RequirePermission';
import MainLayout from '../layouts/MainLayout';
import Login from '../pages/Login';
import Dashboard from '../pages/Dashboard';
import NotFound from '../pages/NotFound';
import UsersListPage from '../pages/users/UsersListPage';
import UserDetailsPage from '../pages/users/UserDetailsPage';
import RolesPage from '../pages/roles/RolesPage';
import CustomersListPage from '../pages/customers/CustomersListPage';
import CustomerDetailsPage from '../pages/customers/CustomerDetailsPage';
import LoansListPage from '../pages/loans/LoansListPage';
import LoanDetailsPage from '../pages/loans/LoanDetailsPage';
import LoanEmiSchedulePage from '../pages/loans/LoanEmiSchedulePage';
import CollectionsListPage from '../pages/collections/CollectionsListPage';
import CollectionDetailsPage from '../pages/collections/CollectionDetailsPage';
import RoutesListPage from '../pages/routes/RoutesListPage';
import RouteDetailsPage from '../pages/routes/RouteDetailsPage';
import DemandPage from '../pages/demand/DemandPage';
import LoanReportPage from '../pages/reports/LoanReportPage';
import CollectionReportPage from '../pages/reports/CollectionReportPage';
import EmiReportPage from '../pages/reports/EmiReportPage';
import DemandCollectionReportPage from '../pages/reports/DemandCollectionReportPage';
import CollectionReceiptPage from '../pages/receipts/CollectionReceiptPage';
// TEMPORARY: oneBulk historical collection migration utility. Remove this
// import and its <Route> below to remove the feature entirely.
import OneBulkImportPage from '../pages/oneBulk/OneBulkImportPage';
import { PERMISSIONS } from '../utils/permissions';

/** Single route table for the application. */
export default function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicRoute />}>
        <Route path="/login" element={<Login />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<MainLayout />}>
          <Route path="/dashboard" element={<Dashboard />} />

          {/* Permission-gated areas; unauthorised users get a 403 page rather
              than a redirect, so the URL stays stable. */}
          <Route element={<RequirePermission anyOf={[PERMISSIONS.CUSTOMERS_VIEW]} />}>
            <Route path="/customers" element={<CustomersListPage />} />
            <Route path="/customers/:id" element={<CustomerDetailsPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[PERMISSIONS.LOANS_VIEW]} />}>
            <Route path="/loans" element={<LoansListPage />} />
            <Route path="/loans/:id" element={<LoanDetailsPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[PERMISSIONS.EMIS_VIEW]} />}>
            <Route path="/loans/:id/emis" element={<LoanEmiSchedulePage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[PERMISSIONS.COLLECTIONS_VIEW]} />}>
            <Route path="/collections" element={<CollectionsListPage />} />
            <Route path="/collections/:id" element={<CollectionDetailsPage />} />
          </Route>

          {/* TEMPORARY: oneBulk historical collection migration utility. */}
          <Route element={<RequirePermission anyOf={[PERMISSIONS.COLLECTIONS_IMPORT]} />}>
            <Route path="/one-bulk" element={<OneBulkImportPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[PERMISSIONS.ROUTES_VIEW]} />}>
            <Route path="/routes" element={<RoutesListPage />} />
            <Route path="/routes/:id" element={<RouteDetailsPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[PERMISSIONS.DEMAND_VIEW]} />}>
            <Route path="/demand" element={<DemandPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[PERMISSIONS.REPORTS_VIEW]} />}>
            <Route path="/reports/loans" element={<LoanReportPage />} />
            <Route path="/reports/collections" element={<CollectionReportPage />} />
            <Route path="/reports/emis" element={<EmiReportPage />} />
            <Route path="/reports/demand" element={<DemandCollectionReportPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[PERMISSIONS.RECEIPTS_VIEW]} />}>
            <Route path="/collections/:id/receipt" element={<CollectionReceiptPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[PERMISSIONS.USERS_VIEW]} />}>
            <Route path="/users" element={<UsersListPage />} />
            <Route path="/users/:id" element={<UserDetailsPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[PERMISSIONS.ROLES_VIEW]} />}>
            <Route path="/roles" element={<RolesPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
