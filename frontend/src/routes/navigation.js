import { PERMISSIONS, hasAnyPermission, hasRole } from '../utils/permissions';

/**
 * Sidebar definition.
 *
 * Each entry is data, not markup, so later phases only need to flip `available`
 * to true (and declare `permission`) as each module ships.
 *   - `permission`: any one of these grants visibility; empty means "all roles".
 *   - `roles`: optional extra restriction by role name.
 *   - `available`: false renders the item as a disabled placeholder.
 */
export const NAV_SECTIONS = [
  {
    id: 'operations',
    label: 'Operations',
    items: [
      { id: 'dashboard', label: 'Dashboard', path: '/dashboard', icon: 'bi-speedometer2', permission: [], roles: [], available: true },
      {
        id: 'customers',
        label: 'Customers',
        path: '/customers',
        icon: 'bi-people',
        permission: [PERMISSIONS.CUSTOMERS_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'loans',
        label: 'Loans',
        path: '/loans',
        icon: 'bi-cash-coin',
        permission: [PERMISSIONS.LOANS_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'collections',
        label: 'Collections',
        path: '/collections',
        icon: 'bi-wallet2',
        permission: [PERMISSIONS.COLLECTIONS_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'routes',
        label: 'Routes',
        path: '/routes',
        icon: 'bi-signpost-split',
        permission: [PERMISSIONS.ROUTES_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'demand',
        label: 'Demand',
        path: '/demand',
        icon: 'bi-calendar-check',
        permission: [PERMISSIONS.DEMAND_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'report-loans',
        label: 'Loan report',
        path: '/reports/loans',
        icon: 'bi-graph-up',
        permission: [PERMISSIONS.REPORTS_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'report-collections',
        label: 'Collection report',
        path: '/reports/collections',
        icon: 'bi-receipt',
        permission: [PERMISSIONS.REPORTS_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'report-emis',
        label: 'EMI report',
        path: '/reports/emis',
        icon: 'bi-list-check',
        permission: [PERMISSIONS.REPORTS_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'report-demand',
        label: 'Demand vs collection',
        path: '/reports/demand',
        icon: 'bi-bar-chart',
        permission: [PERMISSIONS.REPORTS_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'report-bounce-collections',
        label: 'Bounce Collection',
        path: '/reports/bounce-collections',
        icon: 'bi-exclamation-octagon',
        permission: [PERMISSIONS.REPORTS_VIEW],
        roles: [],
        available: true
      }
    ]
  },
  {
    // TEMPORARY: oneBulk historical collection migration utility. Remove this
    // whole section to remove the feature's nav entry.
    id: 'temporary',
    label: 'Temporary',
    items: [
      {
        id: 'one-bulk',
        label: 'oneBulk (temporary)',
        path: '/one-bulk',
        icon: 'bi-clock-history',
        permission: [PERMISSIONS.COLLECTIONS_IMPORT],
        roles: [],
        available: true
      }
    ]
  },
  {
    id: 'administration',
    label: 'Administration',
    items: [
      {
        id: 'users',
        label: 'Users',
        path: '/users',
        icon: 'bi-person-gear',
        permission: [PERMISSIONS.USERS_VIEW],
        roles: [],
        available: true
      },
      {
        id: 'roles',
        label: 'Roles & Permissions',
        path: '/roles',
        icon: 'bi-shield-lock',
        permission: [PERMISSIONS.ROLES_VIEW],
        roles: [],
        available: true
      }
    ]
  },
  {
    id: 'system',
    label: 'System',
    items: [{ id: 'settings', label: 'Settings', path: '/settings', icon: 'bi-gear', permission: [], roles: [], available: false }]
  }
];

/** Keeps only the sections/items the given user is allowed to see. */
export function getNavigationForUser(user) {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => hasAnyPermission(user, item.permission ?? []) && hasRole(user, item.roles ?? [])
    )
  })).filter((section) => section.items.length > 0);
}
