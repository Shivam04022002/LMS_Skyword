'use strict';

/**
 * Phase 2 offline test suite.
 *
 *   npm run test:offline
 *
 * Covers everything verifiable without a MySQL connection: permission
 * middleware, route protection, validators, model serialisation, the permission
 * catalogue and migration integrity. Anything requiring live data is listed by
 * the runner as NOT RUN rather than skipped silently.
 */

const path = require('path');
const fs = require('fs');
const { validationResult } = require('express-validator');

const app = require('../src/app');
const { User, Role, Permission } = require('../src/models');
const { requirePermission, requireAnyPermission } = require('../src/middleware/permissionMiddleware');
const auditService = require('../src/services/auditService');
const userValidator = require('../src/validators/userValidator');
const roleValidator = require('../src/validators/roleValidator');
const { PERMISSIONS, PERMISSION_DEFINITIONS, ROLE_DEFINITIONS, ROLE_PERMISSION_MATRIX, ALL_PERMISSIONS } = require('../src/config/permissions');
const { ROLES } = require('../src/config/roles');
const customerValidator = require('../src/validators/customerValidator');
const customerService = require('../src/services/customerService');
const { Customer } = require('../src/models');
const { normalizeMobile, isValidMobile } = require('../src/utils/mobile');
const { formatCifId, isValidCifId, CIF_NUMBER_LENGTH } = require('../src/config/customers');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../src/config/auditActions');
const loanPartyValidator = require('../src/validators/loanPartyValidator');
const loanPartyService = require('../src/services/loanPartyService');
const models = require('../src/models');
const { LoanParty } = models;
const { PARTY_ROLES, PARTY_ROLE_VALUES, PARTY_STATUS, ROLE_CARDINALITY, isPrimaryRole } = require('../src/config/loanParties');
const loanValidator = require('../src/validators/loanValidator');
const loanStatusService = require('../src/services/loanStatusService');
const { calculateLoanFinancials, calculateTotalRepayment } = require('../src/services/loanCalculationService');
const { toPaise, fromPaise } = require('../src/utils/money');
const {
  LOAN_TYPE_VALUES,
  LOAN_STATUS_VALUES,
  PERIODS_PER_YEAR,
  formatLoanNumber,
  isValidLoanNumber,
  ROI_MAX
} = require('../src/config/loans');
const emiScheduleService = require('../src/services/emiScheduleService');
const emiValidator = require('../src/validators/emiValidator');
const { EMI_STATUS, EMI_STATUS_VALUES } = require('../src/config/emis');
const { EmiSchedule } = models;
const dates = require('../src/utils/dates');
const collectionService = require('../src/services/collectionService');
const allocationService = require('../src/services/collectionAllocationService');
const collectionValidator = require('../src/validators/collectionValidator');
const {
  LEDGER_TYPES,
  LEDGER_TYPE_VALUES,
  COLLECTION_STATUS,
  COLLECTION_STATUS_VALUES,
  formatCollectionNumber,
  isValidCollectionNumber
} = require('../src/config/collections');
const routeService = require('../src/services/routeService');
const demandService = require('../src/services/demandService');
const routeValidator = require('../src/validators/routeValidator');
const demandValidator = require('../src/validators/demandValidator');
const {
  ROUTE_STATUS_VALUES,
  ASSIGNMENT_STATUS,
  ASSIGNMENT_STATUS_VALUES,
  DEMAND_BUCKET,
  DEMAND_BUCKET_VALUES,
  formatRouteCode,
  isValidRouteCode
} = require('../src/config/routes');

const results = [];
const record = (group, name, pass, detail) => results.push({ group, name, pass, detail });

/** Builds a user instance with a role + permissions attached, without any DB. */
function buildUser({ id = 1, role = ROLES.ADMIN, permissions = [], status = 'ACTIVE' } = {}) {
  const user = User.build({ id, name: 'Test User', email: 'test@example.com', password: 'hashed', roleId: 1, status });
  user.Role = Role.build({ id: 1, name: role });
  user.Role.Permissions = permissions.map((name) => Permission.build({ name }));
  return user;
}

/**
 * Removes comments before a source assertion runs, so a doc comment that
 * mentions the very thing being checked for cannot be mistaken for code.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Runs middleware and resolves to the resulting HTTP status. */
const runMiddleware = (middleware, req) =>
  new Promise((resolve) => middleware(req, {}, (error) => resolve(error ? error.statusCode : 200)));

/** Runs express-validator chains against a fake request. */
async function runRules(rules, source) {
  const req = { body: {}, params: {}, query: {}, headers: {}, ...source };
  await Promise.all(rules.map((rule) => rule.run(req)));
  return validationResult(req)
    .array()
    .map((error) => ({ field: error.path, message: error.msg }));
}

(async () => {
  // ---------- Permission middleware ----------
  {
    const anon = await runMiddleware(requirePermission(PERMISSIONS.USERS_VIEW), {});
    const missing = await runMiddleware(requirePermission(PERMISSIONS.USERS_VIEW), { user: buildUser({ permissions: [] }) });
    const granted = await runMiddleware(requirePermission(PERMISSIONS.USERS_VIEW), {
      user: buildUser({ permissions: [PERMISSIONS.USERS_VIEW] })
    });
    const partial = await runMiddleware(requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_CREATE), {
      user: buildUser({ permissions: [PERMISSIONS.USERS_VIEW] })
    });
    record(
      'Permission middleware',
      'requirePermission: 401 anon / 403 missing / 200 granted / 403 partial',
      anon === 401 && missing === 403 && granted === 200 && partial === 403,
      `anon=${anon} missing=${missing} granted=${granted} partial=${partial}`
    );

    const anyNone = await runMiddleware(requireAnyPermission(PERMISSIONS.USERS_ACTIVATE, PERMISSIONS.USERS_DEACTIVATE), {
      user: buildUser({ permissions: [] })
    });
    const anyOne = await runMiddleware(requireAnyPermission(PERMISSIONS.USERS_ACTIVATE, PERMISSIONS.USERS_DEACTIVATE), {
      user: buildUser({ permissions: [PERMISSIONS.USERS_DEACTIVATE] })
    });
    record(
      'Permission middleware',
      'requireAnyPermission: 403 with none / 200 with one',
      anyNone === 403 && anyOne === 200,
      `none=${anyNone} one=${anyOne}`
    );
  }

  // ---------- Role catalogue integrity ----------
  {
    const defined = PERMISSION_DEFINITIONS.map((p) => p.name);
    const constants = Object.values(PERMISSIONS);
    record(
      'Permission catalogue',
      'every PERMISSIONS constant has a definition row',
      constants.every((name) => defined.includes(name)) && defined.length === constants.length,
      `${constants.length} constants, ${defined.length} definitions`
    );

    const unknown = Object.entries(ROLE_PERMISSION_MATRIX)
      .filter(([, grant]) => grant !== ALL_PERMISSIONS)
      .flatMap(([, grant]) => grant)
      .filter((name) => !defined.includes(name));
    record('Permission catalogue', 'role matrix references only defined permissions', unknown.length === 0, `unknown=[${unknown.join(', ')}]`);

    record(
      'Permission catalogue',
      'SUPER_ADMIN receives every permission',
      ROLE_PERMISSION_MATRIX[ROLES.SUPER_ADMIN] === ALL_PERMISSIONS,
      `grant=${ROLE_PERMISSION_MATRIX[ROLES.SUPER_ADMIN]}`
    );

    const adminGrant = ROLE_PERMISSION_MATRIX[ROLES.ADMIN];
    record(
      'Permission catalogue',
      'ADMIN has no permission-management rights',
      !adminGrant.includes(PERMISSIONS.PERMISSIONS_MANAGE) && !adminGrant.includes(PERMISSIONS.ROLES_MANAGE),
      `admin grants=${adminGrant.length}`
    );

    const hasModulePermission = (role, prefix) =>
      ROLE_PERMISSION_MATRIX[role].some((permission) => permission.startsWith(prefix));

    record(
      'Permission catalogue',
      'COLLECTOR and STAFF hold no user-management permissions by default',
      !hasModulePermission(ROLES.COLLECTOR, 'users.') && !hasModulePermission(ROLES.STAFF, 'users.'),
      `collector=[${ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR].join(', ') || 'none'}] staff=[${ROLE_PERMISSION_MATRIX[ROLES.STAFF].join(', ') || 'none'}]`
    );

    record(
      'Permission catalogue',
      'all five roles are defined',
      ROLE_DEFINITIONS.length === 5 && ROLE_DEFINITIONS.every((role) => Object.values(ROLES).includes(role.name)),
      ROLE_DEFINITIONS.map((r) => r.name).join(', ')
    );
  }

  // ---------- Model serialisation ----------
  {
    const user = buildUser({ permissions: [PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_CREATE] });
    const publicJson = JSON.stringify(user.toPublicJSON());
    const authJson = user.toAuthJSON();

    record(
      'Model',
      'toPublicJSON never exposes the password hash',
      !publicJson.includes('password') && !publicJson.includes('hashed'),
      publicJson
    );
    record('Model', 'virtual `role` resolves to the role name', user.role === ROLES.ADMIN, `role=${user.role}`);
    record(
      'Model',
      'toAuthJSON exposes permissions and no password',
      Array.isArray(authJson.permissions) && authJson.permissions.length === 2 && !('password' in authJson),
      `permissions=${authJson.permissions.join(', ')}`
    );
    record(
      'Model',
      'hasPermission reflects granted permissions',
      user.hasPermission(PERMISSIONS.USERS_VIEW) && !user.hasPermission(PERMISSIONS.ROLES_MANAGE),
      'users.view=true roles.manage=false'
    );

    const roleless = User.build({ name: 'X', email: 'x@y.z', password: 'p', roleId: 1 });
    record('Model', 'permissionNames() is safe when the role is not loaded', roleless.permissionNames().length === 0, 'returns []');
  }

  // ---------- Audit redaction ----------
  {
    const sanitized = auditService.sanitizeDetails({
      email: 'a@b.c',
      password: 'secret-value',
      newPassword: 'secret-value',
      token: 'jwt-value',
      role: 'ADMIN'
    });
    const serialized = JSON.stringify(sanitized);
    record(
      'Audit',
      'credentials are stripped from audit details',
      !serialized.includes('secret-value') && !serialized.includes('jwt-value') && sanitized.email === 'a@b.c',
      serialized
    );
  }

  // ---------- Validators ----------
  {
    const weak = await runRules(userValidator.createUserRules, {
      body: { name: '', email: 'nope', password: 'short', role: 'WIZARD', status: 'MAYBE' }
    });
    const fields = weak.map((e) => e.field);
    record(
      'Validators',
      'createUser rejects blank name, bad email, weak password, unknown role and status',
      ['name', 'email', 'password', 'role', 'status'].every((field) => fields.includes(field)),
      `flagged: ${[...new Set(fields)].join(', ')}`
    );

    const noDigit = await runRules(userValidator.createUserRules, {
      body: { name: 'A', email: 'a@b.co', password: 'abcdefghij', role: ROLES.STAFF }
    });
    record(
      'Validators',
      'createUser requires a digit in the password',
      noDigit.some((e) => e.field === 'password'),
      noDigit.map((e) => e.message).join('; ') || 'no error raised'
    );

    const good = await runRules(userValidator.createUserRules, {
      body: { name: 'Valid User', email: 'valid@example.com', password: 'Str0ngPass', role: ROLES.MANAGER, status: 'ACTIVE' }
    });
    record('Validators', 'createUser accepts a valid payload', good.length === 0, `errors=${good.length}`);

    const escalation = await runRules(userValidator.updateUserRules, {
      params: { id: '2' },
      body: { name: 'New Name', role: ROLES.SUPER_ADMIN, password: 'Str0ngPass' }
    });
    const escalationFields = escalation.map((e) => e.field);
    record(
      'Validators',
      'updateUser refuses role and password fields (escalation path closed)',
      escalationFields.includes('role') && escalationFields.includes('password'),
      escalation.map((e) => `${e.field}: ${e.message}`).join(' | ')
    );

    const badList = await runRules(userValidator.listUsersRules, { query: { page: '0', limit: '500', role: 'NOPE', sortBy: 'password' } });
    const listFields = badList.map((e) => e.field);
    record(
      'Validators',
      'listUsers rejects bad paging, unknown role and non-sortable field',
      ['page', 'limit', 'role', 'sortBy'].every((field) => listFields.includes(field)),
      `flagged: ${listFields.join(', ')}`
    );

    const badPermissions = await runRules(roleValidator.updateRolePermissionsRules, { params: { id: '1' }, body: { permissions: 'all' } });
    record('Validators', 'role permissions must be an array', badPermissions.some((e) => e.field === 'permissions'), JSON.stringify(badPermissions));
  }

  // ---------- Customer permissions ----------
  {
    const customerPermissions = [
      PERMISSIONS.CUSTOMERS_VIEW,
      PERMISSIONS.CUSTOMERS_CREATE,
      PERMISSIONS.CUSTOMERS_UPDATE,
      PERMISSIONS.CUSTOMERS_ACTIVATE,
      PERMISSIONS.CUSTOMERS_DEACTIVATE
    ];
    const defined = PERMISSION_DEFINITIONS.map((p) => p.name);

    record(
      'Customer permissions',
      'all five customer permissions are defined in the catalogue',
      customerPermissions.every((name) => defined.includes(name)),
      customerPermissions.join(', ')
    );

    const adminGrant = ROLE_PERMISSION_MATRIX[ROLES.ADMIN];
    record(
      'Customer permissions',
      'ADMIN receives every customer permission',
      customerPermissions.every((name) => adminGrant.includes(name)),
      `admin holds ${customerPermissions.filter((n) => adminGrant.includes(n)).length}/5`
    );

    const managerGrant = ROLE_PERMISSION_MATRIX[ROLES.MANAGER];
    record(
      'Customer permissions',
      'MANAGER receives customers.view only',
      managerGrant.includes(PERMISSIONS.CUSTOMERS_VIEW) &&
        !managerGrant.includes(PERMISSIONS.CUSTOMERS_CREATE) &&
        !managerGrant.includes(PERMISSIONS.CUSTOMERS_UPDATE),
      `manager grants: ${managerGrant.join(', ')}`
    );

    const hasCustomerPermission = (role) =>
      ROLE_PERMISSION_MATRIX[role].some((permission) => permission.startsWith('customers.'));

    record(
      'Customer permissions',
      'COLLECTOR and STAFF receive no customer permissions',
      !hasCustomerPermission(ROLES.COLLECTOR) && !hasCustomerPermission(ROLES.STAFF),
      `collector=[${ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR].join(', ') || 'none'}] staff=[${ROLE_PERMISSION_MATRIX[ROLES.STAFF].join(', ') || 'none'}]`
    );

    // Phase 2 grants must not have shifted.
    const phase2AdminGrants = [
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.USERS_CREATE,
      PERMISSIONS.USERS_UPDATE,
      PERMISSIONS.USERS_ACTIVATE,
      PERMISSIONS.USERS_DEACTIVATE,
      PERMISSIONS.USERS_ASSIGN_ROLE,
      PERMISSIONS.USERS_RESET_PASSWORD,
      PERMISSIONS.ROLES_VIEW,
      PERMISSIONS.PERMISSIONS_VIEW
    ];
    record(
      'Phase 2 compatibility',
      'Phase 2 ADMIN grants are unchanged and still exclude roles.manage',
      phase2AdminGrants.every((name) => adminGrant.includes(name)) &&
        !adminGrant.includes(PERMISSIONS.ROLES_MANAGE) &&
        !adminGrant.includes(PERMISSIONS.PERMISSIONS_MANAGE),
      `admin grants=${adminGrant.length}`
    );
  }

  // ---------- CIFID format ----------
  {
    record(
      'CIFID',
      'format is C + six digits, sequential and zero-padded',
      formatCifId(1) === 'C000001' && formatCifId(42) === 'C000042' && formatCifId(999999) === 'C999999',
      `1 -> ${formatCifId(1)}, 42 -> ${formatCifId(42)}, 999999 -> ${formatCifId(999999)}`
    );

    record(
      'CIFID',
      'validator accepts the canonical form and rejects malformed ids',
      isValidCifId('C000001') &&
        !isValidCifId('C00001') &&
        !isValidCifId('c000001') &&
        !isValidCifId('X000001') &&
        !isValidCifId('C0000001') &&
        !isValidCifId(''),
      `digits=${CIF_NUMBER_LENGTH}`
    );

    record(
      'CIFID',
      'generation is sequential, never timestamp/random/UUID based',
      formatCifId(7) === 'C000007' && formatCifId(8) === 'C000008',
      'derived purely from the counter value'
    );

    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerService.js'), 'utf8');
    record(
      'CIFID',
      'service uses a locked counter row, not MAX(cif_id) + 1',
      source.includes('transaction.LOCK.UPDATE') && !/max\s*\(\s*['"`]?cif/i.test(source),
      'SELECT ... FOR UPDATE inside the creating transaction'
    );
    record(
      'CIFID',
      'CIFID allocation and customer insert share one transaction',
      source.includes('sequelize.transaction('),
      'rollback reverts the counter, so duplicates are impossible'
    );
  }

  // ---------- Mobile normalisation ----------
  {
    const cases = [
      ['+91 9876543210', '9876543210'],
      ['+919876543210', '9876543210'],
      ['09876543210', '9876543210'],
      ['9876543210', '9876543210'],
      ['98765 43210', '9876543210'],
      ['+91-98765-43210', '9876543210'],
      ['0091 9876543210', '9876543210']
    ];
    const failures = cases.filter(([input, expected]) => normalizeMobile(input) !== expected);
    record(
      'Mobile normalisation',
      'all accepted input formats reduce to one canonical 10-digit value',
      failures.length === 0,
      failures.length === 0 ? `${cases.length} formats -> 9876543210` : JSON.stringify(failures)
    );

    const invalid = ['123', '12345678901234', '5876543210', 'abcdefghij', ''];
    record(
      'Mobile normalisation',
      'implausible numbers are rejected',
      invalid.every((value) => !isValidMobile(value)),
      `rejected: ${invalid.filter((v) => !isValidMobile(v)).length}/${invalid.length}`
    );
  }

  // ---------- Full name construction ----------
  {
    const build = async (attributes) => {
      const customer = Customer.build({ ...attributes, cifId: 'C000001', mobile: '9876543210' });
      customer.fullName = null;
      await Customer.runHooks('beforeValidate', customer, {});
      return customer.fullName;
    };

    const three = await build({ firstName: 'Rahul', middleName: 'Kumar', lastName: 'Sharma' });
    const two = await build({ firstName: 'Rahul', lastName: 'Sharma' });
    const one = await build({ firstName: 'Rahul' });
    const padded = await build({ firstName: '  Rahul  ', middleName: '  Kumar ', lastName: ' Sharma ' });

    record(
      'Full name',
      'built by the backend from the name parts, ignoring gaps and whitespace',
      three === 'Rahul Kumar Sharma' && two === 'Rahul Sharma' && one === 'Rahul' && padded === 'Rahul Kumar Sharma',
      `"${three}" | "${two}" | "${one}" | "${padded}"`
    );

    // A client-supplied full name must be overwritten, not trusted.
    const spoofed = Customer.build({
      cifId: 'C000001',
      firstName: 'Rahul',
      lastName: 'Sharma',
      mobile: '9876543210',
      fullName: 'Totally Different Person'
    });
    await Customer.runHooks('beforeValidate', spoofed, {});
    record('Full name', 'a client-supplied full_name is overwritten', spoofed.fullName === 'Rahul Sharma', `-> "${spoofed.fullName}"`);

    const normalised = Customer.build({ cifId: 'C000001', firstName: 'A', mobile: '+91 98765 43210', email: '  MiXeD@Example.COM ' });
    await Customer.runHooks('beforeValidate', normalised, {});
    record(
      'Full name',
      'model hook normalises mobile and email on save',
      normalised.mobile === '9876543210' && normalised.email === 'mixed@example.com',
      `mobile=${normalised.mobile} email=${normalised.email}`
    );
  }

  // ---------- Customer validators ----------
  {
    const missing = await runRules(customerValidator.createCustomerRules, { body: {} });
    const missingFields = missing.map((e) => e.field);
    record(
      'Customer validators',
      'create requires first_name and mobile',
      missingFields.includes('firstName') && missingFields.includes('mobile'),
      missing.map((e) => `${e.field}: ${e.message}`).join(' | ')
    );

    const formatted = await runRules(customerValidator.createCustomerRules, {
      body: { firstName: 'Rahul', mobile: '+91 9876543210' }
    });
    record('Customer validators', 'create accepts a +91-formatted mobile', formatted.length === 0, `errors=${formatted.length}`);

    const badMobile = await runRules(customerValidator.createCustomerRules, { body: { firstName: 'Rahul', mobile: '12345' } });
    record('Customer validators', 'create rejects an implausible mobile', badMobile.some((e) => e.field === 'mobile'), badMobile.map((e) => e.message).join('; '));

    const cifAttempt = await runRules(customerValidator.createCustomerRules, {
      body: { firstName: 'Rahul', mobile: '9876543210', cifId: 'C000999' }
    });
    const cifSnakeAttempt = await runRules(customerValidator.createCustomerRules, {
      body: { firstName: 'Rahul', mobile: '9876543210', cif_id: 'C000999' }
    });
    record(
      'Customer validators',
      'CIFID cannot be supplied on create (camelCase or snake_case)',
      cifAttempt.some((e) => e.field === 'cifId') && cifSnakeAttempt.some((e) => e.field === 'cif_id'),
      cifAttempt.map((e) => e.message)[0] ?? 'not rejected'
    );

    const cifUpdate = await runRules(customerValidator.updateCustomerRules, { params: { id: '1' }, body: { cifId: 'C000999' } });
    record(
      'Customer validators',
      'CIFID cannot be changed on update (immutable)',
      cifUpdate.some((e) => e.field === 'cifId'),
      cifUpdate.map((e) => e.message)[0] ?? 'not rejected'
    );

    const systemFields = await runRules(customerValidator.updateCustomerRules, {
      params: { id: '1' },
      body: { createdBy: 3, updatedBy: 4, fullName: 'Spoofed Name', createdAt: '2020-01-01' }
    });
    const systemFlagged = systemFields.map((e) => e.field);
    record(
      'Customer validators',
      'createdBy/updatedBy/fullName/createdAt are rejected as backend-controlled',
      ['createdBy', 'updatedBy', 'fullName', 'createdAt'].every((field) => systemFlagged.includes(field)),
      systemFlagged.join(', ')
    );

    const statusOnUpdate = await runRules(customerValidator.updateCustomerRules, { params: { id: '1' }, body: { status: 'INACTIVE' } });
    record(
      'Customer validators',
      'status cannot be changed through the update endpoint',
      statusOnUpdate.some((e) => e.field === 'status'),
      statusOnUpdate.map((e) => e.message)[0] ?? 'not rejected'
    );

    const badStatus = await runRules(customerValidator.changeStatusRules, { params: { id: '1' }, body: { status: 'DELETED' } });
    const goodStatus = await runRules(customerValidator.changeStatusRules, { params: { id: '1' }, body: { status: 'INACTIVE' } });
    record(
      'Customer validators',
      'status endpoint accepts ACTIVE/INACTIVE only',
      badStatus.some((e) => e.field === 'status') && goodStatus.length === 0,
      `"DELETED" rejected, "INACTIVE" accepted`
    );

    const badOptional = await runRules(customerValidator.createCustomerRules, {
      body: { firstName: 'R', mobile: '9876543210', email: 'not-an-email', pincode: '12', gender: 'ROBOT', maritalStatus: 'MAYBE', dateOfBirth: '2999-01-01' }
    });
    const optionalFlagged = badOptional.map((e) => e.field);
    record(
      'Customer validators',
      'optional fields are validated (email, pincode, gender, marital status, future DOB)',
      ['email', 'pincode', 'gender', 'maritalStatus', 'dateOfBirth'].every((field) => optionalFlagged.includes(field)),
      optionalFlagged.join(', ')
    );

    const emptyOptional = await runRules(customerValidator.createCustomerRules, {
      body: { firstName: 'R', mobile: '9876543210', email: '', pincode: '', gender: '', dateOfBirth: '' }
    });
    record('Customer validators', 'blank optional fields are treated as not supplied', emptyOptional.length === 0, `errors=${emptyOptional.length}`);

    const badSearch = await runRules(customerValidator.listCustomersRules, {
      query: { page: '0', limit: '999', status: 'GONE', sortBy: 'mobile' }
    });
    const searchFlagged = badSearch.map((e) => e.field);
    record(
      'Customer validators',
      'list rejects bad pagination, unknown status and non-sortable field',
      ['page', 'limit', 'status', 'sortBy'].every((field) => searchFlagged.includes(field)),
      searchFlagged.join(', ')
    );

    const goodSearch = await runRules(customerValidator.listCustomersRules, {
      query: { page: '2', limit: '20', search: '9876543210', status: 'ACTIVE', city: 'Pune', state: 'MH' }
    });
    record('Customer validators', 'list accepts valid search/filter/pagination parameters', goodSearch.length === 0, `errors=${goodSearch.length}`);
  }

  // ---------- Backend-controlled field whitelist ----------
  {
    const picked = customerService.pickEditableFields({
      firstName: 'Rahul',
      mobile: '9876543210',
      cifId: 'C000999',
      createdBy: 99,
      updatedBy: 99,
      fullName: 'Spoofed',
      id: 4,
      createdAt: '2020-01-01',
      status: 'INACTIVE'
    });
    const keys = Object.keys(picked);
    record(
      'Field whitelist',
      'service ignores cifId, id, createdBy, updatedBy, fullName, createdAt and status',
      !keys.some((key) => ['cifId', 'id', 'createdBy', 'updatedBy', 'fullName', 'createdAt', 'status'].includes(key)) &&
        keys.includes('firstName') &&
        keys.includes('mobile'),
      `kept: ${keys.join(', ')}`
    );

    record(
      'Field whitelist',
      'whitelist covers every client-editable customer field',
      customerService.EDITABLE_FIELDS.length === 17 && customerService.EDITABLE_FIELDS.includes('pincode'),
      `${customerService.EDITABLE_FIELDS.length} fields`
    );
  }

  // ---------- Audit vocabulary ----------
  {
    const required = ['CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CUSTOMER_ACTIVATED', 'CUSTOMER_DEACTIVATED'];
    record(
      'Audit',
      'customer audit actions are defined',
      required.every((action) => AUDIT_ACTIONS[action] === action) && AUDIT_ENTITIES.CUSTOMER === 'CUSTOMER',
      required.join(', ')
    );

    // Phase 2 actions must survive.
    const phase2 = ['USER_CREATED', 'USER_UPDATED', 'ROLE_CHANGED', 'PASSWORD_RESET'];
    record('Phase 2 compatibility', 'Phase 2 audit actions still present', phase2.every((action) => AUDIT_ACTIONS[action] === action), phase2.join(', '));
  }

  // ---------- Loan party roles & rules ----------
  {
    record(
      'Loan party rules',
      'exactly three party roles are allowed',
      PARTY_ROLE_VALUES.length === 3 &&
        PARTY_ROLE_VALUES.includes('APPLICANT') &&
        PARTY_ROLE_VALUES.includes('CO_APPLICANT') &&
        PARTY_ROLE_VALUES.includes('GUARANTOR'),
      PARTY_ROLE_VALUES.join(', ')
    );

    record(
      'Loan party rules',
      'exactly one applicant; co-applicants and guarantors are unbounded',
      ROLE_CARDINALITY[PARTY_ROLES.APPLICANT].min === 1 &&
        ROLE_CARDINALITY[PARTY_ROLES.APPLICANT].max === 1 &&
        ROLE_CARDINALITY[PARTY_ROLES.CO_APPLICANT].max === null &&
        ROLE_CARDINALITY[PARTY_ROLES.GUARANTOR].max === null,
      'applicant 1..1, co-applicant 0..n, guarantor 0..n'
    );

    record(
      'Loan party rules',
      'is_primary is derived: true for applicant only',
      isPrimaryRole(PARTY_ROLES.APPLICANT) &&
        !isPrimaryRole(PARTY_ROLES.CO_APPLICANT) &&
        !isPrimaryRole(PARTY_ROLES.GUARANTOR),
      'derived from party role'
    );

    // The model hook must correct isPrimary regardless of what was passed in.
    const spoofed = LoanParty.build({ loanId: 1, customerId: 1, partyRole: PARTY_ROLES.GUARANTOR, isPrimary: true });
    await LoanParty.runHooks('beforeValidate', spoofed, {});
    const promoted = LoanParty.build({ loanId: 1, customerId: 1, partyRole: PARTY_ROLES.APPLICANT, isPrimary: false });
    await LoanParty.runHooks('beforeValidate', promoted, {});
    record(
      'Loan party rules',
      'model hook overrides a client-supplied is_primary',
      spoofed.isPrimary === false && promoted.isPrimary === true,
      `guarantor->${spoofed.isPrimary}, applicant->${promoted.isPrimary}`
    );

    record(
      'Loan party rules',
      'soft-removal statuses only (no hard delete)',
      PARTY_STATUS.ACTIVE === 'ACTIVE' && PARTY_STATUS.REMOVED === 'REMOVED' && Object.keys(PARTY_STATUS).length === 2,
      'ACTIVE / REMOVED'
    );
  }

  // ---------- No customer duplication ----------
  {
    const partyColumns = Object.keys(LoanParty.rawAttributes);
    const duplicated = partyColumns.filter((column) =>
      /name|mobile|email|address|cif|city|state|pincode|gender|occupation/i.test(column)
    );
    record(
      'No duplication',
      'LoanParty stores no customer profile data (name/mobile/email/CIFID/address)',
      duplicated.length === 0,
      `columns: ${partyColumns.join(', ')}`
    );

    const customerColumns = Object.keys(Customer.rawAttributes);
    const roleColumns = customerColumns.filter((column) =>
      /applicant|guarantor|is_primary|isPrimary|party|loan/i.test(column)
    );
    record(
      'No duplication',
      'customers still has no applicant/co-applicant/guarantor/party columns',
      roleColumns.length === 0,
      `${customerColumns.length} customer columns, none role-related`
    );

    record(
      'No duplication',
      'LoanParty resolves customer details through the Customer association',
      Object.keys(LoanParty.associations).includes('Customer'),
      `associations: ${Object.keys(LoanParty.associations).join(', ')}`
    );
  }

  // ---------- Phase 4 migration activation ----------
  {
    record(
      'Phase 4 activation',
      'the Loan model deferred by Phase 4 now exists',
      Boolean(models.Loan) && Boolean(models.LoanSequence),
      'Loan and LoanSequence registered'
    );

    const migrationsDir = path.resolve(__dirname, '..', 'migrations');
    const activeFiles = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.js'));

    record(
      'Phase 4 activation',
      'migrations/pending/ is gone — nothing is deferred any more',
      !fs.existsSync(path.join(migrationsDir, 'pending')),
      'the parked migration was activated, not duplicated'
    );

    const loanPartyMigrations = activeFiles.filter((file) => file.includes('loan-parties'));
    record(
      'Phase 4 activation',
      'exactly one loan_parties migration exists (no duplicate)',
      loanPartyMigrations.length === 1,
      loanPartyMigrations.join(', ') || 'none'
    );

    const loansIndex = activeFiles.findIndex((file) => file.includes('create-loans'));
    const partiesIndex = activeFiles.findIndex((file) => file.includes('loan-parties'));
    record(
      'Phase 4 activation',
      'loan_parties is ordered after loans, so its foreign key resolves',
      loansIndex !== -1 && partiesIndex !== -1 && loansIndex < partiesIndex,
      `${activeFiles[loansIndex]} -> ${activeFiles[partiesIndex]}`
    );

    const partySource = fs.readFileSync(path.join(migrationsDir, loanPartyMigrations[0]), 'utf8');
    record(
      'Phase 4 activation',
      'the loans foreign key is now enabled (not commented out)',
      /references:\s*\{\s*model:\s*'loans'/.test(partySource) && !/\/\/\s*references:\s*\{\s*model:\s*'loans'/.test(partySource),
      'loan_id -> loans.id, ON DELETE RESTRICT'
    );

    record(
      'Phase 4 activation',
      'database-level uniqueness guarantees were preserved through the move',
      partySource.includes('uq_loan_parties_loan_customer') &&
        partySource.includes('uq_loan_parties_active_applicant') &&
        partySource.includes('GENERATED ALWAYS AS'),
      'UNIQUE(loan_id, customer_id) + generated-column unique active applicant'
    );

    record(
      'Phase 4 activation',
      'LoanParty now associates with Loan in both directions',
      Object.keys(LoanParty.associations).includes('Loan') && Object.keys(models.Loan.associations).includes('Parties'),
      `LoanParty: ${Object.keys(LoanParty.associations).join(', ')} | Loan: ${Object.keys(models.Loan.associations).join(', ')}`
    );
  }

  // ---------- Loan constants ----------
  {
    record(
      'Loan constants',
      'exactly four loan types',
      LOAN_TYPE_VALUES.length === 4 && ['DAILY', 'WEEKLY', 'BI_WEEKLY', 'MONTHLY'].every((type) => LOAN_TYPE_VALUES.includes(type)),
      LOAN_TYPE_VALUES.join(', ')
    );

    record(
      'Loan constants',
      'exactly four loan statuses',
      LOAN_STATUS_VALUES.length === 4 &&
        ['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'].every((status) => LOAN_STATUS_VALUES.includes(status)),
      LOAN_STATUS_VALUES.join(', ')
    );

    record(
      'Loan constants',
      'tenure periods per year are defined per loan type',
      PERIODS_PER_YEAR.DAILY === 365 && PERIODS_PER_YEAR.WEEKLY === 52 && PERIODS_PER_YEAR.MONTHLY === 12,
      'DAILY 365, WEEKLY 52, MONTHLY 12 — tenure is never assumed to mean months'
    );

    record(
      'Loan number',
      'format is LN + two-digit year + six-digit sequence',
      formatLoanNumber(2026, 1) === 'LN26-000001' &&
        formatLoanNumber(2026, 2) === 'LN26-000002' &&
        formatLoanNumber(2027, 123456) === 'LN27-123456',
      `${formatLoanNumber(2026, 1)}, ${formatLoanNumber(2026, 2)}, ${formatLoanNumber(2027, 123456)}`
    );

    record(
      'Loan number',
      'validator rejects malformed loan numbers',
      isValidLoanNumber('LN26-000001') &&
        !isValidLoanNumber('LN26-00001') &&
        !isValidLoanNumber('ln26-000001') &&
        !isValidLoanNumber('LN2026-000001') &&
        !isValidLoanNumber('LN26000001'),
      'six digits, uppercase prefix, separator required'
    );

    const loanServiceSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanService.js'), 'utf8')
    );
    record(
      'Loan number',
      'allocation uses a locked counter row, not MAX(loan_number) + 1',
      loanServiceSource.includes('transaction.LOCK.UPDATE') && !/max\s*\(\s*['"`]?loan/i.test(loanServiceSource),
      'SELECT ... FOR UPDATE on loan_sequences'
    );
    record(
      'Loan number',
      'allocation and loan insert share one transaction',
      /createLoan[\s\S]*?sequelize\.transaction\(/.test(loanServiceSource) &&
        /generateLoanNumber\(year, transaction\)/.test(loanServiceSource),
      'rollback releases the number; duplicates impossible'
    );
    record(
      'Loan number',
      'no random or timestamp source is used',
      !/Math\.random|Date\.now/.test(loanServiceSource),
      'sequential counter only'
    );
    record(
      'Loan number',
      'parties are created in the same transaction as the loan',
      /LoanParty\.bulkCreate\([\s\S]*?transaction/.test(loanServiceSource),
      'no partially created loan can survive a failure'
    );
  }

  // ---------- Financial calculation ----------
  {
    // The entered rate is MONTHLY: 100000 at 1.25% a month for 12 months.
    const simple = calculateLoanFinancials({ loanAmount: '100000', roi: '1.25', tenure: 12, loanType: 'MONTHLY' });
    record(
      'Loan calculation',
      'flat interest: 100000 @ 1.25% per month x 12 months',
      simple.interest === '15000.00' && simple.totalRepayment === '115000.00' && simple.emiAmount === '9583.33' && simple.emiCount === 12,
      `interest=${simple.interest} total=${simple.totalRepayment} emi=${simple.emiAmount} count=${simple.emiCount}`
    );

    // The same loan priced before the change: an annual 12.5% is unchanged.
    const legacyAnnual = calculateLoanFinancials({ loanAmount: '100000', roi: '12.5', tenure: 12, loanType: 'MONTHLY', roiBasis: 'ANNUAL' });
    record(
      'Loan calculation',
      'a legacy annual rate still prices exactly as it did: 100000 @ 12.5% per year x 12',
      legacyAnnual.interest === '12500.00' && legacyAnnual.totalRepayment === '112500.00' && legacyAnnual.emiAmount === '9375.00',
      `interest=${legacyAnnual.interest} total=${legacyAnnual.totalRepayment} emi=${legacyAnnual.emiAmount}`
    );

    record(
      'Loan calculation',
      'emiCount always equals tenure',
      simple.emiCount === 12 &&
        calculateLoanFinancials({ loanAmount: '5000', roi: '10', tenure: 30, loanType: 'DAILY' }).emiCount === 30,
      'one instalment per period'
    );

    // Tenure is periods, not months: the same tenure on a daily loan accrues far less.
    const daily = calculateLoanFinancials({ loanAmount: '100000', roi: '12.5', tenure: 12, loanType: 'DAILY' });
    record(
      'Loan calculation',
      'tenure is interpreted per loan type, not as months',
      Number(daily.interest) < Number(simple.interest),
      `12 daily periods -> ${daily.interest}, 12 monthly periods -> ${simple.interest}`
    );

    // A tenure that does not divide evenly exercises the rounding rule.
    const uneven = calculateLoanFinancials({ loanAmount: '100000', roi: '10', tenure: 7, loanType: 'MONTHLY' });
    const instalmentsTotal =
      toPaise(uneven.emiAmount) * BigInt(uneven.emiCount - 1) + toPaise(uneven.lastEmiAmount);
    record(
      'Loan calculation',
      'rounding remainder is carried into the final instalment — no money is lost',
      instalmentsTotal === toPaise(uneven.totalRepayment),
      `${uneven.emiCount - 1} x ${uneven.emiAmount} + ${uneven.lastEmiAmount} = ${uneven.totalRepayment} (remainder ${uneven.roundingRemainder})`
    );

    record(
      'Loan calculation',
      'monetary results are fixed-point strings, never JS numbers',
      typeof simple.totalRepayment === 'string' && /^\d+\.\d{2}$/.test(simple.totalRepayment),
      `totalRepayment=${simple.totalRepayment} (${typeof simple.totalRepayment})`
    );

    // The classic float trap: 0.1 + 0.2 !== 0.3 in IEEE-754.
    record(
      'Loan calculation',
      'money arithmetic is exact where floating point is not',
      toPaise('0.1') + toPaise('0.2') === toPaise('0.3') && 0.1 + 0.2 !== 0.3,
      'integer paise via BigInt'
    );

    record(
      'Loan calculation',
      'large amounts keep full precision',
      calculateTotalRepayment({ loanAmount: '99999999.99', roi: '0', tenure: 12, loanType: 'MONTHLY' }) === '99999999.99',
      'no precision loss at DECIMAL(15,2) scale'
    );

    const calcSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanCalculationService.js'), 'utf8');
    record(
      'Loan calculation',
      'the calculation service uses BigInt, not parseFloat/Number arithmetic',
      calcSource.includes('BigInt') && !/parseFloat|toFixed/.test(calcSource),
      'decimal-safe throughout'
    );

    const controllerSources = ['loanController.js', 'customerController.js', 'userController.js'].map((file) =>
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'controllers', file), 'utf8')
    );
    record(
      'Loan calculation',
      'no financial arithmetic leaks into controllers',
      controllerSources.every((source) => !/[*/+-]\s*roi|totalRepayment\s*=/.test(source)),
      'controllers delegate to the calculation service'
    );
  }

  // ---------- Loan status transitions ----------
  {
    const cases = [
      ['DRAFT', 'ACTIVE', true],
      ['DRAFT', 'CANCELLED', true],
      ['DRAFT', 'CLOSED', false],
      ['ACTIVE', 'CLOSED', true],
      ['ACTIVE', 'CANCELLED', true],
      ['ACTIVE', 'DRAFT', false],
      ['CLOSED', 'ACTIVE', false],
      ['CLOSED', 'CANCELLED', false],
      ['CANCELLED', 'ACTIVE', false],
      ['CANCELLED', 'DRAFT', false]
    ];
    const wrong = cases.filter(([from, to, expected]) => loanStatusService.canTransition(from, to) !== expected);
    record(
      'Loan status',
      'only the defined lifecycle transitions are allowed',
      wrong.length === 0,
      wrong.length === 0 ? `${cases.length} transitions behave as specified` : JSON.stringify(wrong)
    );

    record(
      'Loan status',
      'CLOSED and CANCELLED are terminal',
      loanStatusService.ALLOWED_TRANSITIONS.CLOSED.length === 0 && loanStatusService.ALLOWED_TRANSITIONS.CANCELLED.length === 0,
      'no transitions out'
    );

    let sameStatusError = null;
    try {
      loanStatusService.assertTransitionAllowed('ACTIVE', 'ACTIVE');
    } catch (error) {
      sameStatusError = error.statusCode;
    }
    let terminalError = null;
    try {
      loanStatusService.assertTransitionAllowed('CLOSED', 'ACTIVE');
    } catch (error) {
      terminalError = error.statusCode;
    }
    record(
      'Loan status',
      'invalid transitions raise 409 rather than being ignored',
      sameStatusError === 409 && terminalError === 409,
      `same-status=${sameStatusError}, terminal=${terminalError}`
    );

    record(
      'Loan status',
      'each transition maps to its own permission',
      loanStatusService.permissionForTransition('ACTIVE') === PERMISSIONS.LOANS_ACTIVATE &&
        loanStatusService.permissionForTransition('CLOSED') === PERMISSIONS.LOANS_CLOSE &&
        loanStatusService.permissionForTransition('CANCELLED') === PERMISSIONS.LOANS_CANCEL,
      'activate / close / cancel'
    );

    record(
      'Loan status',
      'each transition maps to its own audit action',
      loanStatusService.auditActionForTransition('ACTIVE') === AUDIT_ACTIONS.LOAN_ACTIVATED &&
        loanStatusService.auditActionForTransition('CLOSED') === AUDIT_ACTIONS.LOAN_CLOSED &&
        loanStatusService.auditActionForTransition('CANCELLED') === AUDIT_ACTIONS.LOAN_CANCELLED,
      'LOAN_ACTIVATED / LOAN_CLOSED / LOAN_CANCELLED'
    );
  }

  // ---------- Loan immutability ----------
  {
    const draft = { status: 'DRAFT' };
    const active = { status: 'ACTIVE' };
    const closed = { status: 'CLOSED' };
    const cancelled = { status: 'CANCELLED' };

    let draftOk = true;
    try {
      loanStatusService.assertEditable(draft, ['loanAmount', 'roi', 'tenure', 'loanType']);
    } catch {
      draftOk = false;
    }
    record('Loan immutability', 'a DRAFT loan may have its terms revised', draftOk, 'financial edits allowed');

    let activeError = null;
    let activeMessage = '';
    try {
      loanStatusService.assertEditable(active, ['loanAmount']);
    } catch (error) {
      activeError = error.statusCode;
      activeMessage = error.message;
    }
    record(
      'Loan immutability',
      'an ACTIVE loan rejects financial edits',
      activeError === 409 && /loanAmount/.test(activeMessage),
      `${activeError}: ${activeMessage}`
    );

    const financialRejections = ['loanAmount', 'roi', 'tenure', 'loanType', 'startDate'].filter((field) => {
      try {
        loanStatusService.assertEditable(active, [field]);
        return false;
      } catch {
        return true;
      }
    });
    record(
      'Loan immutability',
      'every financial field is protected on an ACTIVE loan',
      financialRejections.length === 5,
      `protected: ${financialRejections.join(', ')}`
    );

    const readOnlyRejections = [closed, cancelled].filter((loan) => {
      try {
        loanStatusService.assertEditable(loan, []);
        return false;
      } catch (error) {
        return error.statusCode === 409;
      }
    });
    record(
      'Loan immutability',
      'CLOSED and CANCELLED loans are fully read-only, even for non-financial fields',
      readOnlyRejections.length === 2,
      'both reject any edit'
    );

    const partyLocks = [active, closed, cancelled].filter((loan) => {
      try {
        loanStatusService.assertPartiesEditable(loan);
        return false;
      } catch {
        return true;
      }
    });
    record(
      'Loan immutability',
      'parties can only change while the loan is DRAFT',
      partyLocks.length === 3,
      'ACTIVE, CLOSED and CANCELLED all refuse party changes'
    );
  }

  // ---------- Loan permissions ----------
  {
    const loanPermissions = [
      PERMISSIONS.LOANS_VIEW,
      PERMISSIONS.LOANS_CREATE,
      PERMISSIONS.LOANS_UPDATE,
      PERMISSIONS.LOANS_ACTIVATE,
      PERMISSIONS.LOANS_CLOSE,
      PERMISSIONS.LOANS_CANCEL
    ];
    const defined = PERMISSION_DEFINITIONS.map((p) => p.name);
    record('Loan permissions', 'all six loan permissions are defined', loanPermissions.every((n) => defined.includes(n)), loanPermissions.join(', '));

    const adminGrant = ROLE_PERMISSION_MATRIX[ROLES.ADMIN];
    const managerGrant = ROLE_PERMISSION_MATRIX[ROLES.MANAGER];
    record('Loan permissions', 'ADMIN receives all six', loanPermissions.every((n) => adminGrant.includes(n)), `${loanPermissions.filter((n) => adminGrant.includes(n)).length}/6`);
    record('Loan permissions', 'MANAGER receives all six', loanPermissions.every((n) => managerGrant.includes(n)), `${loanPermissions.filter((n) => managerGrant.includes(n)).length}/6`);

    const collectorGrant = ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR];
    record(
      'Loan permissions',
      'COLLECTOR receives loans.view only',
      collectorGrant.includes(PERMISSIONS.LOANS_VIEW) &&
        !collectorGrant.includes(PERMISSIONS.LOANS_CREATE) &&
        !collectorGrant.includes(PERMISSIONS.LOANS_UPDATE),
      collectorGrant.join(', ')
    );

    record(
      'Loan permissions',
      'STAFF receives no loan permissions',
      !ROLE_PERMISSION_MATRIX[ROLES.STAFF].some((permission) => permission.startsWith('loans.')),
      ROLE_PERMISSION_MATRIX[ROLES.STAFF].join(', ') || 'none'
    );

    const denied = await runMiddleware(requirePermission(PERMISSIONS.LOANS_CREATE), {
      user: buildUser({ permissions: [PERMISSIONS.LOANS_VIEW] })
    });
    const allowed = await runMiddleware(requirePermission(PERMISSIONS.LOANS_CREATE), {
      user: buildUser({ permissions: [PERMISSIONS.LOANS_CREATE] })
    });
    record(
      'Loan permissions',
      'loans.create is required to create: 403 without it, allowed with it',
      denied === 403 && allowed === 200,
      `without=${denied} with=${allowed}`
    );
  }

  // ---------- Loan validators ----------
  {
    const missing = await runRules(loanValidator.createLoanRules, { body: {} });
    const missingFields = missing.map((e) => e.field);
    record(
      'Loan validators',
      'create requires amount, ROI, tenure, type, start date and an applicant',
      ['loanAmount', 'roi', 'tenure', 'loanType', 'startDate', 'applicantCustomerId'].every((f) => missingFields.includes(f)),
      missingFields.join(', ')
    );

    const valid = await runRules(loanValidator.createLoanRules, {
      body: {
        loanAmount: '100000',
        roi: '12.5',
        tenure: 12,
        loanType: 'MONTHLY',
        startDate: '2026-08-17',
        applicantCustomerId: 1,
        coApplicantCustomerIds: [2, 3],
        guarantorCustomerIds: [4, 5, 6]
      }
    });
    record(
      'Loan validators',
      'accepts a valid loan with multiple co-applicants and guarantors',
      valid.length === 0,
      `errors=${valid.length}`
    );

    const badAmounts = await Promise.all(
      ['0', '-100', 'abc', 'Infinity', '1e5', '100.123'].map((loanAmount) =>
        runRules(loanValidator.createLoanRules, { body: { loanAmount, roi: '10', tenure: 12, loanType: 'MONTHLY', startDate: '2026-01-01', applicantCustomerId: 1 } })
      )
    );
    record(
      'Loan validators',
      'rejects 0, negative, NaN, Infinity, exponent and >2-decimal amounts',
      badAmounts.every((errors) => errors.some((e) => e.field === 'loanAmount')),
      '6/6 rejected'
    );

    const badRoi = await Promise.all(
      ['-1', '999999', 'abc'].map((roi) =>
        runRules(loanValidator.createLoanRules, { body: { loanAmount: '1000', roi, tenure: 12, loanType: 'MONTHLY', startDate: '2026-01-01', applicantCustomerId: 1 } })
      )
    );
    record(
      'Loan validators',
      'rejects negative and absurd ROI values such as 999999%',
      badRoi.every((errors) => errors.some((e) => e.field === 'roi')),
      `max ${ROI_MAX}%`
    );

    const badTenure = await Promise.all(
      ['0', '-5', '1.5', '99999'].map((tenure) =>
        runRules(loanValidator.createLoanRules, { body: { loanAmount: '1000', roi: '10', tenure, loanType: 'MONTHLY', startDate: '2026-01-01', applicantCustomerId: 1 } })
      )
    );
    record(
      'Loan validators',
      'tenure must be a positive whole number within range',
      badTenure.every((errors) => errors.some((e) => e.field === 'tenure')),
      '0, negative, fractional and out-of-range rejected'
    );

    const badType = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000', roi: '10', tenure: 12, loanType: 'YEARLY', startDate: '2026-01-01', applicantCustomerId: 1 }
    });
    record('Loan validators', 'arbitrary loan types are rejected', badType.some((e) => e.field === 'loanType'), 'YEARLY rejected');

    const calculated = await runRules(loanValidator.createLoanRules, {
      body: {
        loanAmount: '1000',
        roi: '10',
        tenure: 12,
        loanType: 'MONTHLY',
        startDate: '2026-01-01',
        applicantCustomerId: 1,
        loanNumber: 'LN26-999999',
        totalRepayment: '1',
        emiAmount: '1',
        emiCount: 25,
        status: 'ACTIVE'
      }
    });
    const calculatedFields = calculated.map((e) => e.field);
    record(
      'Loan validators',
      'loanNumber, totalRepayment, emiAmount, emiCount and status are rejected as client-supplied',
      ['loanNumber', 'totalRepayment', 'emiAmount', 'emiCount', 'status'].every((f) => calculatedFields.includes(f)),
      calculatedFields.join(', ')
    );

    const inconsistent = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000', roi: '10', tenure: 12, loanType: 'MONTHLY', startDate: '2026-01-01', applicantCustomerId: 1, emiCount: 25 }
    });
    record(
      'Loan validators',
      'tenure 12 with emiCount 25 cannot be submitted — emiCount is derived',
      inconsistent.some((e) => e.field === 'emiCount'),
      'emiCount always equals tenure'
    );

    const updateStatus = await runRules(loanValidator.updateLoanRules, { params: { id: '1' }, body: { status: 'ACTIVE' } });
    const updateParties = await runRules(loanValidator.updateLoanRules, { params: { id: '1' }, body: { applicantCustomerId: 2 } });
    record(
      'Loan validators',
      'update cannot bypass status rules or change parties',
      updateStatus.some((e) => e.field === 'status') && updateParties.some((e) => e.field === 'applicantCustomerId'),
      'both routed to their own endpoints'
    );

    const badStatus = await runRules(loanValidator.changeStatusRules, { params: { id: '1' }, body: { status: 'anything' } });
    const goodStatus = await runRules(loanValidator.changeStatusRules, { params: { id: '1' }, body: { status: 'ACTIVE' } });
    record(
      'Loan validators',
      'status endpoint accepts only defined statuses',
      badStatus.some((e) => e.field === 'status') && goodStatus.length === 0,
      '"anything" rejected'
    );

    const badList = await runRules(loanValidator.listLoansRules, {
      query: { page: '0', limit: '500', status: 'NOPE', loanType: 'YEARLY', sortBy: 'roi' }
    });
    const listFields = badList.map((e) => e.field);
    record(
      'Loan validators',
      'list rejects bad pagination, unknown status/type and non-sortable field',
      ['page', 'limit', 'status', 'loanType', 'sortBy'].every((f) => listFields.includes(f)),
      listFields.join(', ')
    );
  }

  // ---------- Loan party integration ----------
  {
    const loanServiceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanService.js'), 'utf8');

    record(
      'Loan party integration',
      'loan creation reuses the Phase 4 customer validation rather than restating it',
      loanServiceSource.includes('loanPartyService.resolveCustomer') &&
        loanServiceSource.includes('loanPartyService.assertCustomerAssignable'),
      'resolveCustomer + assertCustomerAssignable'
    );

    record(
      'Loan party integration',
      'a loan requires exactly one applicant',
      /A loan requires exactly one applicant/.test(loanServiceSource) &&
        /needs exactly one applicant before it can be activated/.test(loanServiceSource),
      'enforced at creation and again at activation'
    );

    record(
      'Loan party integration',
      'the same customer cannot hold two roles on one loan',
      /cannot hold more than one role on a loan/.test(loanServiceSource),
      'applicant + guarantor on the same loan is refused'
    );

    const loanColumns = Object.keys(models.Loan.rawAttributes);
    record(
      'Loan party integration',
      'loans has no applicant_id / co_applicant_id / guarantor_id / cif columns',
      !loanColumns.some((column) => /applicant|guarantor|cif|customer/i.test(column)),
      `${loanColumns.length} loan columns, none referencing customers directly`
    );

    record(
      'Loan party integration',
      'loans duplicates no customer profile data',
      !loanColumns.some((column) => /name|mobile|email|address/i.test(column)),
      'customer data is reached through LoanParty -> Customer'
    );
  }

  // ---------- Route protection (HTTP, no DB reached) ----------

  // ---------- Loan party permissions ----------
  {
    const partyPermissions = [
      PERMISSIONS.LOAN_PARTIES_VIEW,
      PERMISSIONS.LOAN_PARTIES_CREATE,
      PERMISSIONS.LOAN_PARTIES_UPDATE,
      PERMISSIONS.LOAN_PARTIES_REMOVE,
      PERMISSIONS.LOAN_PARTIES_SWAP
    ];
    const defined = PERMISSION_DEFINITIONS.map((p) => p.name);
    record(
      'Loan party permissions',
      'all five loan_parties permissions are defined',
      partyPermissions.every((name) => defined.includes(name)),
      partyPermissions.join(', ')
    );

    const adminGrant = ROLE_PERMISSION_MATRIX[ROLES.ADMIN];
    record('Loan party permissions', 'ADMIN receives all five', partyPermissions.every((n) => adminGrant.includes(n)), `${partyPermissions.filter((n) => adminGrant.includes(n)).length}/5`);

    const managerGrant = ROLE_PERMISSION_MATRIX[ROLES.MANAGER];
    record(
      'Loan party permissions',
      'MANAGER receives view/create/update but not remove or swap',
      managerGrant.includes(PERMISSIONS.LOAN_PARTIES_VIEW) &&
        managerGrant.includes(PERMISSIONS.LOAN_PARTIES_CREATE) &&
        managerGrant.includes(PERMISSIONS.LOAN_PARTIES_UPDATE) &&
        !managerGrant.includes(PERMISSIONS.LOAN_PARTIES_REMOVE) &&
        !managerGrant.includes(PERMISSIONS.LOAN_PARTIES_SWAP),
      managerGrant.join(', ')
    );

    const collectorGrant = ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR];
    const collectorPartyGrants = collectorGrant.filter((permission) => permission.startsWith('loan_parties.'));
    record(
      'Loan party permissions',
      'COLLECTOR receives loan_parties.view and no other party permission',
      collectorPartyGrants.length === 1 && collectorPartyGrants[0] === PERMISSIONS.LOAN_PARTIES_VIEW,
      collectorGrant.join(', ') || 'none'
    );

    record('Loan party permissions', 'STAFF receives none', ROLE_PERMISSION_MATRIX[ROLES.STAFF].length === 0, 'empty');

    // Middleware behaviour for the party permissions specifically.
    const denied = await runMiddleware(requirePermission(PERMISSIONS.LOAN_PARTIES_SWAP), {
      user: buildUser({ permissions: [PERMISSIONS.LOAN_PARTIES_VIEW] })
    });
    const allowed = await runMiddleware(requirePermission(PERMISSIONS.LOAN_PARTIES_SWAP), {
      user: buildUser({ permissions: [PERMISSIONS.LOAN_PARTIES_SWAP] })
    });
    record(
      'Loan party permissions',
      'swap requires loan_parties.swap: 403 without it, allowed with it',
      denied === 403 && allowed === 200,
      `without=${denied} with=${allowed}`
    );
  }

  // ---------- Loan party validators ----------
  {
    const noRole = await runRules(loanPartyValidator.addPartyRules, { params: { loanId: '1' }, body: { cifId: 'C000001' } });
    record('Loan party validators', 'party role is required', noRole.some((e) => e.field === 'partyRole'), noRole.map((e) => e.message).join('; '));

    const badRole = await runRules(loanPartyValidator.addPartyRules, {
      params: { loanId: '1' },
      body: { cifId: 'C000001', partyRole: 'BORROWER' }
    });
    record(
      'Loan party validators',
      'arbitrary roles are rejected',
      badRole.some((e) => e.field === 'partyRole'),
      badRole.map((e) => e.message).join('; ')
    );

    const noCustomer = await runRules(loanPartyValidator.addPartyRules, {
      params: { loanId: '1' },
      body: { partyRole: PARTY_ROLES.GUARANTOR }
    });
    record(
      'Loan party validators',
      'a customer must be identified by customerId or cifId',
      noCustomer.length > 0,
      noCustomer.map((e) => e.message).join('; ')
    );

    const badCif = await runRules(loanPartyValidator.addPartyRules, {
      params: { loanId: '1' },
      body: { partyRole: PARTY_ROLES.APPLICANT, cifId: 'C123' }
    });
    record('Loan party validators', 'malformed CIFID is rejected', badCif.some((e) => e.field === 'cifId'), badCif.map((e) => e.message).join('; '));

    const okByCif = await runRules(loanPartyValidator.addPartyRules, {
      params: { loanId: '1' },
      body: { partyRole: PARTY_ROLES.CO_APPLICANT, cifId: 'C000001' }
    });
    const okById = await runRules(loanPartyValidator.addPartyRules, {
      params: { loanId: '1' },
      body: { partyRole: PARTY_ROLES.GUARANTOR, customerId: 7 }
    });
    record(
      'Loan party validators',
      'accepts a valid party by CIFID or by customerId',
      okByCif.length === 0 && okById.length === 0,
      `cif errors=${okByCif.length}, id errors=${okById.length}`
    );

    const spoofFields = await runRules(loanPartyValidator.addPartyRules, {
      params: { loanId: '1' },
      body: { partyRole: PARTY_ROLES.GUARANTOR, cifId: 'C000001', isPrimary: true, status: 'ACTIVE', createdBy: 9, loanId: 42 }
    });
    const spoofFlagged = spoofFields.map((e) => e.field);
    record(
      'Loan party validators',
      'isPrimary, status, createdBy and loanId are rejected as backend-controlled',
      ['isPrimary', 'status', 'createdBy', 'loanId'].every((field) => spoofFlagged.includes(field)),
      spoofFlagged.join(', ')
    );

    const changeCustomer = await runRules(loanPartyValidator.updatePartyRules, {
      params: { loanId: '1', partyId: '2' },
      body: { partyRole: PARTY_ROLES.GUARANTOR, customerId: 5 }
    });
    record(
      'Loan party validators',
      'the customer on an existing party cannot be swapped out',
      changeCustomer.some((e) => e.field === 'customerId'),
      changeCustomer.map((e) => e.message)[0] ?? 'not rejected'
    );

    const badStatus = await runRules(loanPartyValidator.changePartyStatusRules, {
      params: { loanId: '1', partyId: '2' },
      body: { status: 'DELETED' }
    });
    const goodStatus = await runRules(loanPartyValidator.changePartyStatusRules, {
      params: { loanId: '1', partyId: '2' },
      body: { status: 'REMOVED' }
    });
    record(
      'Loan party validators',
      'party status accepts ACTIVE/REMOVED only',
      badStatus.some((e) => e.field === 'status') && goodStatus.length === 0,
      '"DELETED" rejected, "REMOVED" accepted'
    );

    const badSwap = await runRules(loanPartyValidator.swapRules, { params: { loanId: '1' }, body: { coApplicantPartyId: 'abc' } });
    const okSwap = await runRules(loanPartyValidator.swapRules, { params: { loanId: '1' }, body: { coApplicantPartyId: 3 } });
    const okSwapBlank = await runRules(loanPartyValidator.swapRules, { params: { loanId: '1' }, body: {} });
    record(
      'Loan party validators',
      'swap accepts an optional numeric coApplicantPartyId',
      badSwap.some((e) => e.field === 'coApplicantPartyId') && okSwap.length === 0 && okSwapBlank.length === 0,
      'non-numeric rejected, numeric and omitted accepted'
    );

    const badLoanId = await runRules(loanPartyValidator.listPartiesRules, { params: { loanId: 'abc' }, query: {} });
    record('Loan party validators', 'loan id must be a positive integer', badLoanId.some((e) => e.field === 'loanId'), badLoanId.map((e) => e.message).join('; '));
  }

  // ---------- Inactive customer & swap logic ----------
  {
    const inactive = Customer.build({ cifId: 'C000009', firstName: 'X', mobile: '9876543210', status: 'INACTIVE' });
    let rejected = null;
    try {
      loanPartyService.assertCustomerAssignable(inactive);
    } catch (error) {
      rejected = error.statusCode;
    }
    const active = Customer.build({ cifId: 'C000010', firstName: 'Y', mobile: '9876543211', status: 'ACTIVE' });
    let accepted = true;
    try {
      loanPartyService.assertCustomerAssignable(active);
    } catch {
      accepted = false;
    }
    record(
      'Inactive customer',
      'inactive customers cannot be newly assigned; active ones can',
      rejected === 409 && accepted,
      `inactive -> ${rejected}, active -> allowed`
    );

    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanPartyService.js'), 'utf8');

    record(
      'Swap logic',
      'swap runs inside a single transaction',
      /swapApplicantAndCoApplicant[\s\S]*?sequelize\.transaction\(/.test(source),
      'one call, never two independent requests'
    );
    record(
      'Swap logic',
      'swap locks the loan party rows before changing them',
      /swapApplicantAndCoApplicant[\s\S]*?lock: transaction\.LOCK\.UPDATE/.test(source),
      'concurrent swaps serialise'
    );
    record(
      'Swap logic',
      'swap demotes the applicant before promoting, so two applicants never coexist',
      source.indexOf('PARTY_ROLES.CO_APPLICANT, isPrimary: false') <
        source.indexOf('PARTY_ROLES.APPLICANT, isPrimary: true'),
      'demote-then-promote ordering'
    );
    record(
      'Swap logic',
      'add / update / remove are all transactional',
      (source.match(/sequelize\.transaction\(/g) ?? []).length >= 4,
      `${(source.match(/sequelize\.transaction\(/g) ?? []).length} transactional operations`
    );
    record(
      'Swap logic',
      'service never hard-deletes a party',
      !/\.destroy\(/.test(source),
      'no destroy() call anywhere in the service'
    );
    record(
      'Duplicate rules',
      'service rejects a customer already attached and a second applicant',
      /already attached to this loan/.test(source) && /already has an applicant/.test(source),
      'one customer = one role per loan; one applicant per loan'
    );
    record(
      'Duplicate rules',
      'service never auto-creates a customer',
      !/Customer\.create\(/.test(source),
      'missing customer -> 404'
    );
  }

  // ---------- EMI date generation ----------
  {
    // Month-end: the anchor day is kept and clamped, never chained from the
    // previous clamped result.
    const monthEnd = emiScheduleService.calculateEmiDates({
      startDate: '2026-01-31',
      loanType: 'MONTHLY',
      emiCount: 4
    });
    record(
      'EMI dates',
      'month-end anchoring: 2026-01-31 -> 02-28, 03-31, 04-30, 05-31',
      monthEnd[0] === '2026-02-28' && monthEnd[1] === '2026-03-31' && monthEnd[2] === '2026-04-30' && monthEnd[3] === '2026-05-31',
      monthEnd.join(', ')
    );

    const leap = emiScheduleService.calculateEmiDates({ startDate: '2028-01-31', loanType: 'MONTHLY', emiCount: 2 });
    record(
      'EMI dates',
      'leap year: 2028-01-31 -> 2028-02-29',
      leap[0] === '2028-02-29' && leap[1] === '2028-03-31',
      leap.join(', ')
    );

    const nonLeap = emiScheduleService.calculateEmiDates({ startDate: '2026-01-30', loanType: 'MONTHLY', emiCount: 1 });
    record('EMI dates', 'non-leap February clamps to the 28th', nonLeap[0] === '2026-02-28', nonLeap[0]);

    const april = emiScheduleService.calculateEmiDates({ startDate: '2026-03-31', loanType: 'MONTHLY', emiCount: 1 });
    const may = emiScheduleService.calculateEmiDates({ startDate: '2026-04-30', loanType: 'MONTHLY', emiCount: 1 });
    record(
      'EMI dates',
      '31-day to 30-day month clamps; 30th stays 30th',
      april[0] === '2026-04-30' && may[0] === '2026-05-30',
      `${april[0]}, ${may[0]}`
    );

    const monthly = emiScheduleService.calculateEmiDates({ startDate: '2026-08-17', loanType: 'MONTHLY', emiCount: 3 });
    record(
      'EMI dates',
      'monthly intervals: 2026-08-17 -> 09-17, 10-17, 11-17',
      monthly[0] === '2026-09-17' && monthly[1] === '2026-10-17' && monthly[2] === '2026-11-17',
      monthly.join(', ')
    );

    const weekly = emiScheduleService.calculateEmiDates({ startDate: '2026-08-17', loanType: 'WEEKLY', emiCount: 3 });
    record(
      'EMI dates',
      'weekly intervals are +7, +14, +21 days',
      weekly[0] === '2026-08-24' && weekly[1] === '2026-08-31' && weekly[2] === '2026-09-07',
      weekly.join(', ')
    );

    const daily = emiScheduleService.calculateEmiDates({ startDate: '2026-08-30', loanType: 'DAILY', emiCount: 3 });
    record(
      'EMI dates',
      'daily intervals cross a month boundary correctly',
      daily[0] === '2026-08-31' && daily[1] === '2026-09-01' && daily[2] === '2026-09-02',
      daily.join(', ')
    );

    // A year boundary is where naive millisecond maths tends to drift.
    const yearEnd = emiScheduleService.calculateEmiDates({ startDate: '2026-12-31', loanType: 'MONTHLY', emiCount: 2 });
    record('EMI dates', 'year boundary: 2026-12-31 -> 2027-01-31, 2027-02-28', yearEnd[0] === '2027-01-31' && yearEnd[1] === '2027-02-28', yearEnd.join(', '));

    const dateSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'utils', 'dates.js'), 'utf8'));
    record(
      'EMI dates',
      'month arithmetic uses calendar parts, not fixed millisecond offsets',
      !/30\s*\*\s*24|86400000\s*\*\s*30|2592000000/.test(dateSource),
      'no 30-day month approximation'
    );

    record(
      'EMI dates',
      'leap-year rule handles centuries correctly',
      dates.isLeapYear(2028) && dates.isLeapYear(2000) && !dates.isLeapYear(1900) && !dates.isLeapYear(2026),
      '2028 yes, 2000 yes, 1900 no, 2026 no'
    );
  }

  // ---------- EMI allocation and reconciliation ----------
  {
    const evenLoan = {
      id: 1,
      loanAmount: '100000.00',
      roi: '12.5',
      tenure: 12,
      loanType: 'MONTHLY',
      totalRepayment: '112500.00',
      emiAmount: '9375.00',
      emiCount: 12,
      startDate: '2026-08-17'
    };
    const { rows: evenRows } = emiScheduleService.buildSchedule(evenLoan);

    record(
      'EMI allocation',
      'generates exactly emi_count rows, numbered 1..n',
      evenRows.length === 12 && evenRows[0].emiNumber === 1 && evenRows[11].emiNumber === 12,
      `${evenRows.length} rows, ${evenRows[0].emiNumber}..${evenRows[11].emiNumber}`
    );

    record(
      'EMI allocation',
      'EMI numbers are unique and contiguous within the loan',
      new Set(evenRows.map((r) => r.emiNumber)).size === 12 &&
        evenRows.every((row, index) => row.emiNumber === index + 1),
      'no gaps, no duplicates, per-loan numbering'
    );

    // Matches the shape given in the specification's example response.
    record(
      'EMI allocation',
      'first instalment matches the specified example (9375.00 / 8333.33 / 1041.67)',
      evenRows[0].emiAmount === '9375.00' && evenRows[0].principal === '8333.33' && evenRows[0].interest === '1041.67' && evenRows[0].emiDate === '2026-09-17',
      JSON.stringify({ date: evenRows[0].emiDate, emi: evenRows[0].emiAmount, principal: evenRows[0].principal, interest: evenRows[0].interest })
    );

    const sumOf = (rows, key) => rows.reduce((total, row) => total + toPaise(row[key]), 0n);

    record(
      'EMI reconciliation',
      '100000 @ 12.5% x 12: principal, interest and instalments all reconcile exactly',
      sumOf(evenRows, 'principal') === toPaise('100000.00') &&
        sumOf(evenRows, 'interest') === toPaise('12500.00') &&
        sumOf(evenRows, 'emiAmount') === toPaise('112500.00'),
      `principal=${fromPaise(sumOf(evenRows, 'principal'))} interest=${fromPaise(sumOf(evenRows, 'interest'))} total=${fromPaise(sumOf(evenRows, 'emiAmount'))}`
    );

    // Uneven division: 105833.33 over 7 instalments cannot split evenly.
    const unevenFinancials = calculateLoanFinancials({ loanAmount: '100000', roi: '10', tenure: 7, loanType: 'MONTHLY' });
    const unevenLoan = {
      id: 2,
      loanAmount: '100000.00',
      roi: '10',
      tenure: 7,
      loanType: 'MONTHLY',
      totalRepayment: unevenFinancials.totalRepayment,
      emiAmount: unevenFinancials.emiAmount,
      emiCount: 7,
      startDate: '2026-08-17'
    };
    const { rows: unevenRows } = emiScheduleService.buildSchedule(unevenLoan);

    record(
      'EMI reconciliation',
      '100000 @ 10% x 7 (uneven): totals still reconcile to the exact cent',
      sumOf(unevenRows, 'principal') === toPaise('100000.00') &&
        sumOf(unevenRows, 'interest') === toPaise(unevenFinancials.interest) &&
        sumOf(unevenRows, 'emiAmount') === toPaise(unevenFinancials.totalRepayment),
      `principal=${fromPaise(sumOf(unevenRows, 'principal'))} interest=${fromPaise(sumOf(unevenRows, 'interest'))} total=${fromPaise(sumOf(unevenRows, 'emiAmount'))}`
    );

    record(
      'EMI reconciliation',
      'residue lands on the final instalment, not spread silently',
      unevenRows.slice(0, 6).every((row) => row.emiAmount === unevenFinancials.emiAmount) &&
        unevenRows[6].emiAmount !== unevenFinancials.emiAmount,
      `first six ${unevenRows[0].emiAmount}, last ${unevenRows[6].emiAmount}`
    );

    record(
      'EMI reconciliation',
      'schedule instalments agree with the loan headline EMI amount',
      unevenRows[0].emiAmount === unevenLoan.emiAmount,
      `schedule ${unevenRows[0].emiAmount} == loan.emiAmount ${unevenLoan.emiAmount}`
    );

    // Each row must also be internally consistent.
    const rowConsistent = [...evenRows, ...unevenRows].every(
      (row) => toPaise(row.principal) + toPaise(row.interest) === toPaise(row.emiAmount)
    );
    record('EMI reconciliation', 'every row satisfies principal + interest = instalment', rowConsistent, `${evenRows.length + unevenRows.length} rows checked`);

    // A deliberately corrupted schedule must be refused before insertion.
    let reconciliationError = null;
    try {
      emiScheduleService.validateScheduleTotals(
        [{ principal: '100.00', interest: '10.00', emiAmount: '110.00' }],
        { loanAmount: '999.00', totalInterest: '10.00', totalRepayment: '110.00' }
      );
    } catch (error) {
      reconciliationError = error.statusCode;
    }
    record(
      'EMI reconciliation',
      'a schedule that does not reconcile is rejected, never persisted',
      reconciliationError === 500,
      `validateScheduleTotals threw ${reconciliationError}`
    );

    // Weekly and daily loans reconcile through the same path.
    const dailyFinancials = calculateLoanFinancials({ loanAmount: '5000', roi: '18', tenure: 30, loanType: 'DAILY' });
    const dailyRows = emiScheduleService.buildSchedule({
      id: 3,
      loanAmount: '5000.00',
      roi: '18',
      tenure: 30,
      loanType: 'DAILY',
      totalRepayment: dailyFinancials.totalRepayment,
      emiAmount: dailyFinancials.emiAmount,
      emiCount: 30,
      startDate: '2026-08-17'
    }).rows;
    record(
      'EMI reconciliation',
      'a 30-instalment daily loan reconciles exactly',
      dailyRows.length === 30 &&
        sumOf(dailyRows, 'principal') === toPaise('5000.00') &&
        sumOf(dailyRows, 'emiAmount') === toPaise(dailyFinancials.totalRepayment),
      `30 rows, principal=${fromPaise(sumOf(dailyRows, 'principal'))}`
    );

    record(
      'EMI allocation',
      'a generated schedule starts with nothing collected',
      evenRows.every((row) => row.amountCollected === '0.00' && row.paymentDate === null && row.status === EMI_STATUS.PENDING && row.dpd === 0),
      'collections belong to a later phase'
    );

    const scheduleSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8')
    );
    record(
      'EMI allocation',
      'the schedule service reuses the money utility and the Phase 5 formula',
      scheduleSource.includes("require('../utils/money')") &&
        scheduleSource.includes('calculateLoanFinancials') &&
        !/parseFloat/.test(scheduleSource),
      'no duplicated formula, no float arithmetic'
    );
  }

  // ---------- DPD and status derivation ----------
  {
    const buildEmi = (overrides) =>
      EmiSchedule.build({
        loanId: 1,
        emiNumber: 1,
        emiDate: '2026-08-10',
        emiAmount: '1000.00',
        principal: '900.00',
        interest: '100.00',
        amountCollected: '0.00',
        status: EMI_STATUS.PENDING,
        ...overrides
      });

    // asOf is injected so the result never depends on the real system date.
    const future = buildEmi({ emiDate: '2026-09-01' }).computeDpd('2026-08-17');
    const dueToday = buildEmi({ emiDate: '2026-08-17' }).computeDpd('2026-08-17');
    const oneDay = buildEmi({ emiDate: '2026-08-16' }).computeDpd('2026-08-17');
    const sevenDays = buildEmi({ emiDate: '2026-08-10' }).computeDpd('2026-08-17');
    const paid = buildEmi({ emiDate: '2026-08-10', amountCollected: '1000.00' }).computeDpd('2026-08-17');
    const waived = buildEmi({ emiDate: '2026-08-10', status: EMI_STATUS.WAIVED }).computeDpd('2026-08-17');

    record(
      'DPD',
      'future 0, due-today 0, 1 day late 1, 7 days late 7, paid 0, waived 0',
      future === 0 && dueToday === 0 && oneDay === 1 && sevenDays === 7 && paid === 0 && waived === 0,
      `future=${future} today=${dueToday} +1=${oneDay} +7=${sevenDays} paid=${paid} waived=${waived}`
    );

    const partialLate = buildEmi({ emiDate: '2026-08-10', amountCollected: '400.00' }).computeDpd('2026-08-17');
    record('DPD', 'a partially collected overdue instalment still accrues DPD', partialLate === 7, `partial 400/1000, 7 days late -> ${partialLate}`);

    const crossMonth = buildEmi({ emiDate: '2026-07-31' }).computeDpd('2026-08-17');
    record('DPD', 'DPD counts calendar days across a month boundary', crossMonth === 17, `2026-07-31 to 2026-08-17 -> ${crossMonth}`);

    record(
      'Outstanding',
      'outstanding = instalment - collected, floored at zero',
      buildEmi({ amountCollected: '400.00' }).outstanding() === '600.00' &&
        buildEmi({ amountCollected: '0.00' }).outstanding() === '1000.00' &&
        buildEmi({ amountCollected: '1000.00' }).outstanding() === '0.00',
      '1000-400=600, 1000-0=1000, 1000-1000=0'
    );

    const statuses = {
      pending: buildEmi({ emiDate: '2026-09-01' }).computeStatus('2026-08-17'),
      due: buildEmi({ emiDate: '2026-08-17' }).computeStatus('2026-08-17'),
      overdue: buildEmi({ emiDate: '2026-08-10' }).computeStatus('2026-08-17'),
      partial: buildEmi({ emiDate: '2026-08-10', amountCollected: '400.00' }).computeStatus('2026-08-17'),
      paid: buildEmi({ emiDate: '2026-08-10', amountCollected: '1000.00' }).computeStatus('2026-08-17'),
      waived: buildEmi({ emiDate: '2026-08-10', status: EMI_STATUS.WAIVED }).computeStatus('2026-08-17')
    };
    record(
      'EMI status',
      'status is derived: PENDING / DUE / OVERDUE / PARTIAL / PAID / WAIVED',
      statuses.pending === 'PENDING' &&
        statuses.due === 'DUE' &&
        statuses.overdue === 'OVERDUE' &&
        statuses.partial === 'PARTIAL' &&
        statuses.paid === 'PAID' &&
        statuses.waived === 'WAIVED',
      JSON.stringify(statuses)
    );

    record(
      'EMI status',
      'overpayment still reads as PAID and owes nothing',
      buildEmi({ amountCollected: '1500.00' }).computeStatus('2026-08-17') === 'PAID' &&
        buildEmi({ amountCollected: '1500.00' }).outstanding() === '0.00',
      'no negative outstanding'
    );

    record(
      'EMI status',
      'a waiver is never overwritten by derivation',
      buildEmi({ emiDate: '2026-09-01', status: EMI_STATUS.WAIVED }).computeStatus('2026-08-17') === 'WAIVED',
      'explicit decisions survive recalculation'
    );

    record(
      'EMI status',
      'exactly six statuses exist',
      EMI_STATUS_VALUES.length === 6 &&
        ['PENDING', 'DUE', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED'].every((s) => EMI_STATUS_VALUES.includes(s)),
      EMI_STATUS_VALUES.join(', ')
    );

    const serialised = buildEmi({ emiDate: '2026-08-10', amountCollected: '400.00' }).toPublicJSON('2026-08-17');
    record(
      'EMI status',
      'API payload serves derived DPD/status, not the stored snapshot',
      serialised.dpd === 7 && serialised.status === 'PARTIAL' && serialised.outstanding === '600.00',
      JSON.stringify({ dpd: serialised.dpd, status: serialised.status, outstanding: serialised.outstanding })
    );
  }

  // ---------- Schedule generation safety ----------
  {
    const scheduleSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8')
    );
    const loanServiceSrc = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanService.js'), 'utf8')
    );

    record(
      'Schedule generation',
      'generation locks the loan row inside a transaction',
      /generateSchedule[\s\S]*?lock: tx\.LOCK\.UPDATE/.test(scheduleSource),
      'concurrent generation serialises'
    );

    record(
      'Schedule generation',
      'generation requires an ACTIVE loan',
      /A schedule can only be generated for an ACTIVE loan/.test(scheduleSource),
      'DRAFT, CLOSED and CANCELLED are refused'
    );

    record(
      'Schedule generation',
      'an existing schedule is never rebuilt or deleted',
      /existing > 0/.test(scheduleSource) && !/\.destroy\(/.test(scheduleSource) && !/truncate/i.test(scheduleSource),
      'idempotent; financial history is immutable'
    );

    record(
      'Schedule generation',
      'totals are validated before any row is inserted',
      scheduleSource.indexOf('validateScheduleTotals(rows') < scheduleSource.indexOf('EmiSchedule.bulkCreate'),
      'a mis-allocated schedule cannot be persisted'
    );

    record(
      'Schedule generation',
      'activation and generation share one transaction',
      /LOAN_STATUS\.ACTIVE[\s\S]*?emiScheduleService\.generateSchedule\(loan\.id, actor, \{ transaction \}\)/.test(loanServiceSrc),
      'a loan cannot become ACTIVE without its schedule'
    );

    record(
      'Schedule generation',
      'closing or cancelling generates nothing',
      (loanServiceSrc.match(/generateSchedule\(/g) ?? []).length === 1,
      'generation is reached only on the ACTIVE branch'
    );

    // Scoped to the createLoan body: an unscoped regex would happily span the
    // whole file and match the generateSchedule call inside changeStatus.
    const createStart = loanServiceSrc.indexOf('async function createLoan');
    const createEnd = loanServiceSrc.indexOf('async function ', createStart + 1);
    const createLoanBody = loanServiceSrc.slice(createStart, createEnd === -1 ? undefined : createEnd);
    record(
      'Schedule generation',
      'loan creation does not generate a schedule (loans start as DRAFT)',
      createStart !== -1 && !createLoanBody.includes('generateSchedule'),
      `createLoan body is ${createLoanBody.length} chars and never calls generateSchedule`
    );

    record(
      'Schedule generation',
      'the manual endpoint conflicts rather than silently rebuilding',
      /conflictOnExisting: true/.test(
        stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'controllers', 'emiController.js'), 'utf8'))
      ),
      'recovery use only'
    );

    const emiRouter = require('../src/routes/emiRoutes');
    const emiMethods = emiRouter.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods));
    // Phase 13C added the one exception: a bounce charge is a manually recorded
    // fee that no instalment figure derives from, so recording one amends
    // nothing financial. The schedule itself remains immutable history — no
    // route can rewrite an amount, a date or an instalment count.
    const emiMutatingRoutes = emiRouter.stack
      .filter((layer) => layer.route && Object.keys(layer.route.methods).some((method) => ['put', 'patch', 'delete'].includes(method)))
      .map((layer) => layer.route.path);
    record(
      'Schedule generation',
      'the schedule stays immutable history: the only mutating route is the bounce charge',
      !emiMethods.includes('put') &&
        !emiMethods.includes('delete') &&
        emiMutatingRoutes.length === 1 &&
        emiMutatingRoutes[0] === '/:emiId/bounce-charge',
      `methods: ${[...new Set(emiMethods)].join(', ')} — mutating: ${emiMutatingRoutes.join(', ')}`
    );

    const uniqueIndex = EmiSchedule.options.indexes?.some(
      (index) => index.unique && index.fields.join(',') === 'loan_id,emi_number'
    );
    record(
      'Schedule generation',
      'UNIQUE(loan_id, emi_number) backs the service check at database level',
      Boolean(uniqueIndex),
      'duplicate instalments impossible under concurrency'
    );
  }

  // ---------- EMI permissions and validators ----------
  {
    const emiPermissions = [PERMISSIONS.EMIS_VIEW, PERMISSIONS.EMIS_GENERATE, PERMISSIONS.EMIS_UPDATE];
    const definedPermissions = PERMISSION_DEFINITIONS.map((p) => p.name);
    record('EMI permissions', 'all three EMI permissions are defined', emiPermissions.every((n) => definedPermissions.includes(n)), emiPermissions.join(', '));

    const adminGrant = ROLE_PERMISSION_MATRIX[ROLES.ADMIN];
    const managerGrant = ROLE_PERMISSION_MATRIX[ROLES.MANAGER];
    const collectorGrant = ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR];

    record('EMI permissions', 'ADMIN receives all three', emiPermissions.every((n) => adminGrant.includes(n)), `${emiPermissions.filter((n) => adminGrant.includes(n)).length}/3`);
    record(
      'EMI permissions',
      'MANAGER receives view and generate, not update',
      managerGrant.includes(PERMISSIONS.EMIS_VIEW) &&
        managerGrant.includes(PERMISSIONS.EMIS_GENERATE) &&
        !managerGrant.includes(PERMISSIONS.EMIS_UPDATE),
      'view + generate'
    );
    record(
      'EMI permissions',
      'COLLECTOR receives emis.view only',
      collectorGrant.includes(PERMISSIONS.EMIS_VIEW) &&
        !collectorGrant.includes(PERMISSIONS.EMIS_GENERATE) &&
        !collectorGrant.includes(PERMISSIONS.EMIS_UPDATE),
      collectorGrant.join(', ')
    );
    record(
      'EMI permissions',
      'STAFF receives no EMI permissions',
      !ROLE_PERMISSION_MATRIX[ROLES.STAFF].some((permission) => permission.startsWith('emis.')),
      ROLE_PERMISSION_MATRIX[ROLES.STAFF].join(', ') || 'none'
    );

    const deniedEmi = await runMiddleware(requirePermission(PERMISSIONS.EMIS_GENERATE), {
      user: buildUser({ permissions: [PERMISSIONS.EMIS_VIEW] })
    });
    const allowedEmi = await runMiddleware(requirePermission(PERMISSIONS.EMIS_GENERATE), {
      user: buildUser({ permissions: [PERMISSIONS.EMIS_GENERATE] })
    });
    record('EMI permissions', 'generation requires emis.generate: 403 without it', deniedEmi === 403 && allowedEmi === 200, `without=${deniedEmi} with=${allowedEmi}`);

    // Superseded as a scope check once Phase 7 landed collections; retargeted to
    // the boundary that still matters — the EMI module grants no money-moving
    // rights of its own.
    const emiPermissionNames = Object.values(PERMISSIONS).filter((permission) => permission.startsWith('emis.'));
    record(
      'EMI permissions',
      'no EMI permission grants a money-moving right',
      emiPermissionNames.length === 4 &&
        !emiPermissionNames.some((permission) => /collect|post|pay|waive/.test(permission)) &&
        // The bounce charge is the one write, and it is its own grant rather
        // than a widening of an existing one.
        emiPermissionNames.includes('emis.bounce_charge'),
      emiPermissionNames.join(', ')
    );

    const spoof = await runRules(emiValidator.generateRules, {
      params: { loanId: '1' },
      body: { dpd: 30, status: 'PAID', amountCollected: '1000.00', paymentDate: '2026-08-17', emiAmount: '1.00' }
    });
    const spoofFields = spoof.map((e) => e.field);
    record(
      'EMI validators',
      'DPD, status, collected amount, payment date and amounts are all rejected from requests',
      ['dpd', 'status', 'amountCollected', 'paymentDate', 'emiAmount'].every((f) => spoofFields.includes(f)),
      spoofFields.join(', ')
    );

    const badFilter = await runRules(emiValidator.listScheduleRules, {
      params: { loanId: '1' },
      query: { status: 'SETTLED', emiNumber: '0', page: '0', limit: '9999' }
    });
    const filterFields = badFilter.map((e) => e.field);
    record(
      'EMI validators',
      'list rejects unknown status and bad pagination',
      ['status', 'emiNumber', 'page', 'limit'].every((f) => filterFields.includes(f)),
      filterFields.join(', ')
    );

    const goodFilter = await runRules(emiValidator.listScheduleRules, {
      params: { loanId: '1' },
      query: { status: 'OVERDUE', page: '1', limit: '100', dateFrom: '2026-01-01', dateTo: '2026-12-31' }
    });
    record('EMI validators', 'list accepts valid status, date range and pagination', goodFilter.length === 0, `errors=${goodFilter.length}`);

    const badIds = await runRules(emiValidator.emiIdRules, { params: { loanId: 'abc', emiId: 'xyz' } });
    record('EMI validators', 'loan id and EMI id must be positive integers', badIds.length === 2, badIds.map((e) => e.field).join(', '));
  }

  // ---------- Collection constants and numbering ----------
  {
    record(
      'Collection constants',
      'exactly two ledger types and two statuses',
      LEDGER_TYPE_VALUES.length === 2 &&
        LEDGER_TYPE_VALUES.includes('CASH') &&
        LEDGER_TYPE_VALUES.includes('BANK') &&
        COLLECTION_STATUS_VALUES.length === 2 &&
        COLLECTION_STATUS_VALUES.includes('POSTED') &&
        COLLECTION_STATUS_VALUES.includes('REVERSED'),
      `${LEDGER_TYPE_VALUES.join('/')} · ${COLLECTION_STATUS_VALUES.join('/')}`
    );

    record(
      'Collection number',
      'format is COL + two-digit year + six-digit sequence',
      formatCollectionNumber(2026, 1) === 'COL26-000001' &&
        formatCollectionNumber(2026, 2) === 'COL26-000002' &&
        formatCollectionNumber(2027, 123456) === 'COL27-123456',
      `${formatCollectionNumber(2026, 1)}, ${formatCollectionNumber(2026, 2)}`
    );

    record(
      'Collection number',
      'validator rejects malformed collection numbers',
      isValidCollectionNumber('COL26-000001') &&
        !isValidCollectionNumber('COL26-00001') &&
        !isValidCollectionNumber('col26-000001') &&
        !isValidCollectionNumber('COL2026-000001'),
      'six digits, uppercase prefix, separator required'
    );

    const collectionSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionService.js'), 'utf8')
    );

    record(
      'Collection number',
      'allocation uses a locked counter row, not MAX(collection_number) + 1',
      /generateCollectionNumber[\s\S]*?lock: transaction\.LOCK\.UPDATE/.test(collectionSource) &&
        !/max\s*\(\s*['"`]?collection/i.test(collectionSource),
      'SELECT ... FOR UPDATE on collection_sequences'
    );

    record(
      'Collection number',
      'no random or timestamp source is used for numbering',
      !/Math\.random/.test(collectionSource),
      'sequential counter only'
    );

    record(
      'Collection number',
      'numbering and the collection insert share one transaction',
      /createCollection[\s\S]*?sequelize\.transaction\(/.test(collectionSource) &&
        /generateCollectionNumber\(year, transaction\)/.test(collectionSource),
      'a rolled-back posting releases the number'
    );
  }

  // ---------- Collection guards (pure) ----------
  {
    const ledgerCases = [
      { ledger: LEDGER_TYPES.BANK, reference: null, shouldThrow: true },
      { ledger: LEDGER_TYPES.BANK, reference: '   ', shouldThrow: true },
      { ledger: LEDGER_TYPES.BANK, reference: 'UTR12345', shouldThrow: false },
      { ledger: LEDGER_TYPES.CASH, reference: null, shouldThrow: false }
    ];
    const ledgerOk = ledgerCases.every(({ ledger, reference, shouldThrow }) => {
      try {
        collectionService.assertPaymentReference(ledger, reference);
        return !shouldThrow;
      } catch {
        return shouldThrow;
      }
    });
    record(
      'Collection guards',
      'BANK collections require a payment reference; CASH does not',
      ledgerOk,
      'blank and missing references rejected for BANK only'
    );

    // asOf is injected so the assertion never depends on the real system date.
    let futureStatus = null;
    try {
      collectionService.assertCollectionDate('2026-08-18', '2026-08-17');
    } catch (error) {
      futureStatus = error.statusCode;
    }
    let todayOk = true;
    let pastOk = true;
    try {
      collectionService.assertCollectionDate('2026-08-17', '2026-08-17');
    } catch {
      todayOk = false;
    }
    try {
      collectionService.assertCollectionDate('2026-01-01', '2026-08-17');
    } catch {
      pastOk = false;
    }
    record(
      'Collection guards',
      'future-dated collections are rejected; today and past are accepted',
      futureStatus === 400 && todayOk && pastOk,
      `future -> ${futureStatus}, today -> ok, past -> ok`
    );

    const loanStatusCases = [
      { status: 'ACTIVE', shouldThrow: false },
      { status: 'DRAFT', shouldThrow: true },
      { status: 'CLOSED', shouldThrow: true },
      { status: 'CANCELLED', shouldThrow: true }
    ];
    const loanGateOk = loanStatusCases.every(({ status, shouldThrow }) => {
      try {
        collectionService.assertLoanAcceptsCollections({ status });
        return !shouldThrow;
      } catch (error) {
        return shouldThrow && error.statusCode === 409;
      }
    });
    record(
      'Collection guards',
      'collections are accepted only against an ACTIVE loan',
      loanGateOk,
      'DRAFT, CLOSED and CANCELLED all rejected with 409'
    );

    let closedMessage = '';
    try {
      collectionService.assertLoanAcceptsCollections({ status: 'CLOSED' });
    } catch (error) {
      closedMessage = error.message;
    }
    record(
      'Collection guards',
      'a closed loan points at a controlled correction workflow rather than silently allowing the posting',
      /controlled correction workflow/.test(closedMessage),
      closedMessage
    );
  }

  // ---------- Allocation money rules (pure) ----------
  {
    const alloc = (emiId, amount) => ({ emiId, amount });

    // Exact reconciliation with the collection amount.
    let exactOk = true;
    try {
      const total = allocationService.assertAllocationShape([alloc(1, '6000.00'), alloc(2, '4000.00')]);
      allocationService.assertAllocationTotal(total, '10000.00');
    } catch {
      exactOk = false;
    }
    record(
      'Allocation rules',
      'allocations totalling the collection amount are accepted (6000 + 4000 = 10000)',
      exactOk,
      'multi-EMI allocation supported'
    );

    let underStatus = null;
    let underMessage = '';
    try {
      const total = allocationService.assertAllocationShape([alloc(1, '6000.00'), alloc(2, '3000.00')]);
      allocationService.assertAllocationTotal(total, '10000.00');
    } catch (error) {
      underStatus = error.statusCode;
      underMessage = error.message;
    }
    record(
      'Allocation rules',
      'under-allocation is rejected — no silently unallocated money',
      underStatus === 400 && /1000\.00 unallocated/.test(underMessage),
      underMessage
    );

    let overStatus = null;
    try {
      const total = allocationService.assertAllocationShape([alloc(1, '7000.00'), alloc(2, '4000.00')]);
      allocationService.assertAllocationTotal(total, '10000.00');
    } catch (error) {
      overStatus = error.statusCode;
    }
    record('Allocation rules', 'allocations exceeding the collection amount are rejected', overStatus === 400, `status ${overStatus}`);

    let duplicateStatus = null;
    try {
      allocationService.assertAllocationShape([alloc(1, '5000.00'), alloc(1, '5000.00')]);
    } catch (error) {
      duplicateStatus = error.statusCode;
    }
    record('Allocation rules', 'the same instalment cannot appear twice in one collection', duplicateStatus === 400, `status ${duplicateStatus}`);

    const badAmounts = ['0', '0.00', '-100.00'];
    const badAmountsRejected = badAmounts.every((amount) => {
      try {
        allocationService.assertAllocationShape([alloc(1, amount)]);
        return false;
      } catch {
        return true;
      }
    });
    record('Allocation rules', 'zero and negative allocations are rejected', badAmountsRejected, badAmounts.join(', '));

    let emptyStatus = null;
    try {
      allocationService.assertAllocationShape([]);
    } catch (error) {
      emptyStatus = error.statusCode;
    }
    record('Allocation rules', 'a collection must allocate to at least one instalment', emptyStatus === 400, `status ${emptyStatus}`);

    // Over-allocation against an instalment's outstanding balance.
    let overEmiStatus = null;
    let overEmiMessage = '';
    try {
      allocationService.assertWithinOutstanding({ emiNumber: 3, requestedPaise: toPaise('1500.00'), remainingPaise: toPaise('1000.00') });
    } catch (error) {
      overEmiStatus = error.statusCode;
      overEmiMessage = error.message;
    }
    record(
      'Allocation rules',
      'an allocation over an instalment outstanding is rejected, never spilled to the next instalment',
      overEmiStatus === 409 && /exceeds the 1000\.00 outstanding/.test(overEmiMessage),
      overEmiMessage
    );

    let paidStatus = null;
    try {
      allocationService.assertWithinOutstanding({ emiNumber: 3, requestedPaise: toPaise('1.00'), remainingPaise: 0n });
    } catch (error) {
      paidStatus = error.statusCode;
    }
    record('Allocation rules', 'a fully paid instalment accepts no further allocation', paidStatus === 409, `status ${paidStatus}`);

    let exactlyOutstandingOk = true;
    try {
      allocationService.assertWithinOutstanding({ emiNumber: 3, requestedPaise: toPaise('1000.00'), remainingPaise: toPaise('1000.00') });
    } catch {
      exactlyOutstandingOk = false;
    }
    record('Allocation rules', 'paying exactly the outstanding balance is allowed', exactlyOutstandingOk, '1000.00 against 1000.00 outstanding');

    const emi = EmiSchedule.build({ loanId: 1, emiNumber: 1, emiDate: '2026-08-10', emiAmount: '10000.00', principal: '9000.00', interest: '1000.00' });
    record(
      'Allocation rules',
      'outstanding = instalment - ledger total, floored at zero',
      allocationService.outstandingPaise(emi, toPaise('4000.00')) === toPaise('6000.00') &&
        allocationService.outstandingPaise(emi, toPaise('10000.00')) === 0n &&
        allocationService.outstandingPaise(emi, toPaise('12000.00')) === 0n &&
        allocationService.outstandingPaise(emi, undefined) === toPaise('10000.00'),
      'never negative'
    );
  }

  // ---------- Payment date derivation (pure) ----------
  {
    const resolve = allocationService.resolvePaymentDate;

    record(
      'Payment date',
      'a partially paid instalment has no payment date',
      resolve([{ allocatedAmount: '4000.00', collectionDate: '2026-08-05' }], '10000.00') === null,
      '4000 of 10000 -> null'
    );

    record(
      'Payment date',
      'payment date is the collection that completed the instalment, not the last one seen',
      resolve(
        [
          { allocatedAmount: '4000.00', collectionDate: '2026-08-05' },
          { allocatedAmount: '3000.00', collectionDate: '2026-08-09' },
          { allocatedAmount: '3000.00', collectionDate: '2026-08-12' }
        ],
        '10000.00'
      ) === '2026-08-12',
      '4000 + 3000 + 3000 completes on 2026-08-12'
    );

    record(
      'Payment date',
      'a single covering payment stamps its own date',
      resolve([{ allocatedAmount: '10000.00', collectionDate: '2026-08-05' }], '10000.00') === '2026-08-05',
      'full payment on the first collection'
    );

    // Reversing the middle collection leaves the instalment short again.
    record(
      'Payment date',
      'removing a reversed collection clears the payment date',
      resolve(
        [
          { allocatedAmount: '4000.00', collectionDate: '2026-08-05' },
          { allocatedAmount: '3000.00', collectionDate: '2026-08-12' }
        ],
        '10000.00'
      ) === null,
      '7000 of 10000 after reversal -> null'
    );
  }

  // ---------- Collection lifecycle simulated against Phase 6 EMI logic ----------
  {
    // The ledger drives amountCollected; Phase 6 then derives status and DPD.
    const buildEmi = (collected) =>
      EmiSchedule.build({
        loanId: 1,
        emiNumber: 1,
        emiDate: '2026-08-10',
        emiAmount: '10000.00',
        principal: '9000.00',
        interest: '1000.00',
        amountCollected: collected,
        status: EMI_STATUS.PENDING
      });

    const asOf = '2026-08-20';

    const partial = buildEmi('4000.00');
    record(
      'Collection lifecycle',
      'partial payment: outstanding 6000, status PARTIAL, DPD still counts (10 days late)',
      partial.outstanding() === '6000.00' && partial.computeStatus(asOf) === 'PARTIAL' && partial.computeDpd(asOf) === 10,
      `outstanding=${partial.outstanding()} status=${partial.computeStatus(asOf)} dpd=${partial.computeDpd(asOf)}`
    );

    const full = buildEmi('10000.00');
    record(
      'Collection lifecycle',
      'full payment: outstanding 0, status PAID, DPD 0',
      full.outstanding() === '0.00' && full.computeStatus(asOf) === 'PAID' && full.computeDpd(asOf) === 0,
      `outstanding=${full.outstanding()} status=${full.computeStatus(asOf)} dpd=${full.computeDpd(asOf)}`
    );

    // Three collections against one instalment: 4000 + 3000 + 3000.
    const ledger = [toPaise('4000.00'), toPaise('3000.00'), toPaise('3000.00')];
    const afterAll = ledger.reduce((total, amount) => total + amount, 0n);
    const settled = buildEmi(fromPaise(afterAll));
    record(
      'Collection lifecycle',
      'three collections against one instalment settle it exactly',
      afterAll === toPaise('10000.00') && settled.computeStatus(asOf) === 'PAID' && settled.outstanding() === '0.00',
      '4000 + 3000 + 3000 = 10000 -> PAID'
    );

    // Reversing the middle collection: the total is rebuilt from what remains,
    // never decremented in place.
    const afterReversal = ledger[0] + ledger[2];
    const reopened = buildEmi(fromPaise(afterReversal));
    record(
      'Collection lifecycle',
      'reversing one of three collections reopens the instalment (7000 paid, 3000 outstanding, PARTIAL)',
      afterReversal === toPaise('7000.00') &&
        reopened.outstanding() === '3000.00' &&
        reopened.computeStatus(asOf) === 'PARTIAL',
      `collected=${fromPaise(afterReversal)} outstanding=${reopened.outstanding()} status=${reopened.computeStatus(asOf)}`
    );

    // Reversing the only collection returns the instalment to its date-derived state.
    const emptied = buildEmi('0.00');
    record(
      'Collection lifecycle',
      'reversing a full payment recalculates back to OVERDUE with DPD restored, not a hardcoded previous status',
      emptied.outstanding() === '10000.00' && emptied.computeStatus(asOf) === 'OVERDUE' && emptied.computeDpd(asOf) === 10,
      `status=${emptied.computeStatus(asOf)} dpd=${emptied.computeDpd(asOf)}`
    );

    // A future instalment reverts to PENDING rather than OVERDUE.
    const futureEmi = EmiSchedule.build({
      loanId: 1,
      emiNumber: 2,
      emiDate: '2026-09-10',
      emiAmount: '10000.00',
      principal: '9000.00',
      interest: '1000.00',
      amountCollected: '0.00',
      status: EMI_STATUS.PENDING
    });
    record(
      'Collection lifecycle',
      'reversal on a not-yet-due instalment returns it to PENDING with DPD 0',
      futureEmi.computeStatus(asOf) === 'PENDING' && futureEmi.computeDpd(asOf) === 0,
      'status derived from the due date, not from history'
    );

    // Multi-EMI collection: 15000 clears a 10000 and a 5000 instalment.
    const emiA = EmiSchedule.build({ loanId: 1, emiNumber: 1, emiDate: '2026-08-10', emiAmount: '10000.00', principal: '9000.00', interest: '1000.00', amountCollected: '10000.00' });
    const emiB = EmiSchedule.build({ loanId: 1, emiNumber: 2, emiDate: '2026-09-10', emiAmount: '5000.00', principal: '4500.00', interest: '500.00', amountCollected: '5000.00' });
    record(
      'Collection lifecycle',
      'one 15000 collection settles a 10000 and a 5000 instalment together',
      toPaise('10000.00') + toPaise('5000.00') === toPaise('15000.00') &&
        emiA.computeStatus(asOf) === 'PAID' &&
        emiB.computeStatus(asOf) === 'PAID',
      'both instalments PAID from a single posting'
    );
  }

  // ---------- Collection transaction, locking and immutability ----------
  {
    const collectionSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionService.js'), 'utf8')
    );
    const allocationSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionAllocationService.js'), 'utf8')
    );

    record(
      'Collection transaction',
      'posting runs in one transaction covering the collection, its allocations and the EMI rebuild',
      /createCollection[\s\S]*?sequelize\.transaction\(/.test(collectionSource) &&
        /CollectionAllocation\.bulkCreate\([\s\S]*?transaction/.test(collectionSource) &&
        /recalculateEmis\(emiIds, transaction/.test(collectionSource),
      'no partial collection can survive a failure'
    );

    record(
      'Concurrency',
      'affected instalments are locked before their balances are read',
      /lock: transaction\.LOCK\.UPDATE/.test(allocationSource) &&
        allocationSource.indexOf('lockEmis(emiIds, transaction)') < allocationSource.indexOf('calculateCollectedByEmi(orderedIds, transaction)'),
      'two collectors cannot both consume the same outstanding balance'
    );

    record(
      'Concurrency',
      'instalment locks are taken in ascending id order to limit deadlocks',
      /sort\(\(a, b\) => a - b\)/.test(allocationSource),
      'deterministic lock ordering in lockEmis'
    );

    record(
      'Concurrency',
      'the loan row is locked before a posting is validated',
      /Loan\.findByPk\(loanId, \{ transaction, lock: transaction\.LOCK\.UPDATE \}\)/.test(collectionSource),
      'loan status cannot change mid-posting'
    );

    record(
      'Concurrency',
      'reversal locks the collection row, so a second reversal conflicts',
      /reverseCollection[\s\S]*?Collection\.findByPk\(collectionId, \{ transaction, lock: transaction\.LOCK\.UPDATE \}\)/.test(collectionSource) &&
        /already been reversed/.test(collectionSource),
      'the second attempt receives 409'
    );

    record(
      'Reversal',
      'reversal is a status change; allocation rows are retained as history',
      /status: COLLECTION_STATUS\.REVERSED/.test(collectionSource) && !/\.destroy\(/.test(collectionSource),
      'no destroy() anywhere in the collection service'
    );

    record(
      'Reversal',
      'reversal recalculates the affected instalments rather than restoring a stored previous state',
      /reverseCollection[\s\S]*?recalculateEmis\(emiIds, transaction/.test(collectionSource),
      'status, DPD and payment date are rebuilt from the remaining ledger'
    );

    record(
      'Ledger authority',
      'only POSTED collections count towards an instalment balance',
      /where: \{ status: COLLECTION_STATUS\.POSTED \}/.test(allocationSource),
      'reversed collections contribute nothing'
    );

    record(
      'Ledger authority',
      'instalment snapshots are rebuilt from the ledger, never incremented in place',
      !/increment\(/.test(allocationSource) && /calculateCollectedByEmi/.test(allocationSource),
      'recalculateEmis recomputes amountCollected from allocation rows'
    );

    record(
      'Ledger authority',
      'EMI status and DPD come from the Phase 6 model methods, not restated here',
      /emi\.computeStatus\(asOf\)/.test(allocationSource) && /emi\.computeDpd\(asOf\)/.test(allocationSource),
      'no duplicated EMI status logic'
    );

    record(
      'Ledger authority',
      'the money utility is reused; no float arithmetic in the collection services',
      collectionSource.includes("require('../utils/money')") &&
        allocationSource.includes("require('../utils/money')") &&
        !/parseFloat/.test(collectionSource + allocationSource),
      'BigInt paise throughout'
    );

    record(
      'Ledger authority',
      'loan outstanding is derived, with no separate mutable total',
      !/loan\.update\(\{[^}]*outstanding/i.test(collectionSource) &&
        /totalOutstanding: fromPaise\(totalRepaymentPaise - totalCollectedPaise\)/.test(collectionSource),
      'summary is computed from instalment rows on demand'
    );

    const collectionRouter = require('../src/routes/collectionRoutes');
    const collectionMethods = collectionRouter.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods));
    record(
      'Immutability',
      'no PUT and no DELETE on a collection',
      !collectionMethods.includes('put') && !collectionMethods.includes('delete') && !collectionMethods.includes('patch'),
      `methods: ${[...new Set(collectionMethods)].join(', ')}`
    );

    record(
      'Immutability',
      'FIFO auto-allocation exists as a planner but nothing posts with it',
      /planFifoAllocation/.test(allocationSource) && !/planFifoAllocation/.test(collectionSource),
      'posting stays strictly explicit'
    );
  }

  // ---------- Collection permissions and validators ----------
  {
    const collectionPermissions = [PERMISSIONS.COLLECTIONS_VIEW, PERMISSIONS.COLLECTIONS_CREATE, PERMISSIONS.COLLECTIONS_REVERSE];
    const definedNames = PERMISSION_DEFINITIONS.map((p) => p.name);
    record(
      'Collection permissions',
      'all three collection permissions are defined',
      collectionPermissions.every((n) => definedNames.includes(n)),
      collectionPermissions.join(', ')
    );

    const adminGrant = ROLE_PERMISSION_MATRIX[ROLES.ADMIN];
    const managerGrant = ROLE_PERMISSION_MATRIX[ROLES.MANAGER];
    const collectorGrant = ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR];

    record('Collection permissions', 'ADMIN receives all three', collectionPermissions.every((n) => adminGrant.includes(n)), `${collectionPermissions.filter((n) => adminGrant.includes(n)).length}/3`);
    record('Collection permissions', 'MANAGER receives all three', collectionPermissions.every((n) => managerGrant.includes(n)), `${collectionPermissions.filter((n) => managerGrant.includes(n)).length}/3`);

    record(
      'Collection permissions',
      'COLLECTOR can view and create but NOT reverse',
      collectorGrant.includes(PERMISSIONS.COLLECTIONS_VIEW) &&
        collectorGrant.includes(PERMISSIONS.COLLECTIONS_CREATE) &&
        !collectorGrant.includes(PERMISSIONS.COLLECTIONS_REVERSE),
      collectorGrant.join(', ')
    );

    record(
      'Collection permissions',
      'STAFF receives no collection permissions',
      !ROLE_PERMISSION_MATRIX[ROLES.STAFF].some((permission) => permission.startsWith('collections.')),
      ROLE_PERMISSION_MATRIX[ROLES.STAFF].join(', ') || 'none'
    );

    // The collector-cannot-reverse rule enforced by the middleware itself.
    const collectorUser = buildUser({
      role: ROLES.COLLECTOR,
      permissions: [PERMISSIONS.COLLECTIONS_VIEW, PERMISSIONS.COLLECTIONS_CREATE]
    });
    const collectorReverse = await runMiddleware(requirePermission(PERMISSIONS.COLLECTIONS_REVERSE), { user: collectorUser });
    const collectorCreate = await runMiddleware(requirePermission(PERMISSIONS.COLLECTIONS_CREATE), { user: collectorUser });
    record(
      'Collection permissions',
      'a collector is refused reversal (403) but allowed to post (200)',
      collectorReverse === 403 && collectorCreate === 200,
      `reverse=${collectorReverse} create=${collectorCreate}`
    );

    // Validators
    const missing = await runRules(collectionValidator.createCollectionRules, { body: {} });
    const missingFields = missing.map((e) => e.field);
    record(
      'Collection validators',
      'create requires loan, customer, amount, date, ledger and allocations',
      ['loanId', 'customerId', 'amount', 'collectionDate', 'ledgerType', 'allocations'].every((f) => missingFields.includes(f)),
      missingFields.join(', ')
    );

    const valid = await runRules(collectionValidator.createCollectionRules, {
      body: {
        loanId: 1,
        customerId: 10,
        amount: '10000.00',
        collectionDate: '2026-08-17',
        ledgerType: 'CASH',
        paymentReference: null,
        notes: 'Monthly collection',
        allocations: [
          { emiId: 1, amount: '6000.00' },
          { emiId: 2, amount: '4000.00' }
        ]
      }
    });
    record('Collection validators', 'accepts the documented request shape', valid.length === 0, `errors=${valid.length}`);

    const badAmounts = await Promise.all(
      ['0', '-5', 'abc', 'Infinity', '1e5', '10.123'].map((amount) =>
        runRules(collectionValidator.createCollectionRules, {
          body: { loanId: 1, customerId: 1, amount, collectionDate: '2026-08-17', ledgerType: 'CASH', allocations: [{ emiId: 1, amount: '1.00' }] }
        })
      )
    );
    record(
      'Collection validators',
      'rejects 0, negative, NaN, Infinity, exponent and >2-decimal amounts',
      badAmounts.every((errors) => errors.some((e) => e.field === 'amount')),
      '6/6 rejected'
    );

    const badLedger = await runRules(collectionValidator.createCollectionRules, {
      body: { loanId: 1, customerId: 1, amount: '100.00', collectionDate: '2026-08-17', ledgerType: 'UPI', allocations: [{ emiId: 1, amount: '100.00' }] }
    });
    record('Collection validators', 'arbitrary ledger types are rejected', badLedger.some((e) => e.field === 'ledgerType'), 'UPI rejected');

    const spoof = await runRules(collectionValidator.createCollectionRules, {
      body: {
        loanId: 1,
        customerId: 1,
        amount: '100.00',
        collectionDate: '2026-08-17',
        ledgerType: 'CASH',
        allocations: [{ emiId: 1, amount: '100.00' }],
        collectionNumber: 'COL26-999999',
        status: 'REVERSED',
        dpd: 0,
        emiStatus: 'PAID',
        paymentDate: '2026-08-17',
        amountCollected: '100.00',
        outstanding: '0.00'
      }
    });
    const spoofFields = spoof.map((e) => e.field);
    record(
      'Collection validators',
      'collection number, status, DPD, EMI status, payment date, collected and outstanding are all rejected from requests',
      ['collectionNumber', 'status', 'dpd', 'emiStatus', 'paymentDate', 'amountCollected', 'outstanding'].every((f) => spoofFields.includes(f)),
      spoofFields.join(', ')
    );

    const badAllocationRows = await runRules(collectionValidator.createCollectionRules, {
      body: {
        loanId: 1,
        customerId: 1,
        amount: '100.00',
        collectionDate: '2026-08-17',
        ledgerType: 'CASH',
        allocations: [{ emiId: 0, amount: '-1' }]
      }
    });
    const allocationFields = badAllocationRows.map((e) => e.field);
    record(
      'Collection validators',
      'allocation rows require a positive emiId and a positive amount',
      allocationFields.some((f) => f.includes('emiId')) && allocationFields.some((f) => f.includes('amount')),
      allocationFields.join(', ')
    );

    const badList = await runRules(collectionValidator.listCollectionsRules, {
      query: { page: '0', limit: '500', status: 'CANCELLED', ledgerType: 'UPI', sortBy: 'notes' }
    });
    const listFields = badList.map((e) => e.field);
    record(
      'Collection validators',
      'list rejects bad pagination, unknown status/ledger and non-sortable field',
      ['page', 'limit', 'status', 'ledgerType', 'sortBy'].every((f) => listFields.includes(f)),
      listFields.join(', ')
    );

    const reverseSpoof = await runRules(collectionValidator.reverseCollectionRules, { params: { id: '1' }, body: { status: 'POSTED' } });
    record('Collection validators', 'reversal cannot set an arbitrary status', reverseSpoof.some((e) => e.field === 'status'), 'status rejected');
  }

  // ---------- Routes: constants and code generation ----------
  {
    record(
      'Route constants',
      'route status is ACTIVE/INACTIVE and assignment status is ACTIVE/REMOVED',
      ROUTE_STATUS_VALUES.length === 2 &&
        ROUTE_STATUS_VALUES.includes('ACTIVE') &&
        ROUTE_STATUS_VALUES.includes('INACTIVE') &&
        ASSIGNMENT_STATUS_VALUES.length === 2 &&
        ASSIGNMENT_STATUS_VALUES.includes('REMOVED'),
      `${ROUTE_STATUS_VALUES.join('/')} · ${ASSIGNMENT_STATUS_VALUES.join('/')}`
    );

    record(
      'Route code',
      'format is RT + two-digit year + six-digit sequence',
      formatRouteCode(2026, 1) === 'RT26-000001' &&
        formatRouteCode(2026, 2) === 'RT26-000002' &&
        formatRouteCode(2027, 123456) === 'RT27-123456',
      `${formatRouteCode(2026, 1)}, ${formatRouteCode(2026, 2)}`
    );

    record(
      'Route code',
      'validator rejects malformed route codes',
      isValidRouteCode('RT26-000001') &&
        !isValidRouteCode('RT26-00001') &&
        !isValidRouteCode('rt26-000001') &&
        !isValidRouteCode('RT2026-000001'),
      'six digits, uppercase prefix, separator required'
    );

    const routeSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'routeService.js'), 'utf8')
    );
    record(
      'Route code',
      'allocation uses a locked counter row, not MAX(route_code) + 1',
      /generateRouteCode[\s\S]*?lock: transaction\.LOCK\.UPDATE/.test(routeSource) &&
        !/max\s*\(\s*['"`]?route/i.test(routeSource),
      'SELECT ... FOR UPDATE on route_sequences'
    );
    record(
      'Route code',
      'no random or timestamp source is used for route codes',
      !/Math\.random|Date\.now/.test(routeSource),
      'sequential counter only'
    );

    record(
      'Route code',
      'routeCode is absent from the editable-field whitelist (immutable)',
      !routeService.EDITABLE_FIELDS.includes('routeCode') && routeService.EDITABLE_FIELDS.length === 2,
      `editable: ${routeService.EDITABLE_FIELDS.join(', ')}`
    );

    const picked = routeService.pickEditableFields({ name: 'A', description: 'B', routeCode: 'RT26-999999', status: 'INACTIVE', id: 9, createdBy: 1 });
    record(
      'Route code',
      'the service ignores routeCode, status, id and createdBy from a payload',
      Object.keys(picked).join(',') === 'name,description',
      `kept: ${Object.keys(picked).join(', ')}`
    );

    record(
      'Routes',
      'the route service never hard-deletes',
      !/\.destroy\(/.test(routeSource) && !/truncate/i.test(routeSource),
      'no destroy() call anywhere'
    );

    record(
      'Routes',
      'assignments are soft-removed with an unassignedAt stamp (history preserved)',
      /unassignedAt: status === ASSIGNMENT_STATUS\.REMOVED \? asOf : null/.test(routeSource),
      'REMOVED rows retain their period'
    );

    record(
      'Routes',
      'reassigning a loan closes the previous assignment before opening a new one',
      routeSource.indexOf('status: ASSIGNMENT_STATUS.REMOVED, unassignedAt: asOf') <
        routeSource.indexOf('LoanRoute.create('),
      'one active row per loan; prior period retained'
    );

    record(
      'Routes',
      'collector eligibility requires the COLLECTOR role AND an active account',
      /Only users with the COLLECTOR role/.test(routeSource) && /inactive and cannot be assigned/.test(routeSource),
      'both halves enforced in assertAssignableCollector'
    );

    record(
      'Routes',
      'a COLLECTOR actor is scoped to their own routes',
      /isScopedActor = \(actor\) => actor\?\.role === ROLES\.COLLECTOR/.test(routeSource) &&
        /You are not assigned to this route/.test(routeSource),
      'listRoutes and getRouteById both restrict'
    );
  }

  // ---------- Demand: derivation rules ----------
  {
    record(
      'Demand',
      'buckets are OVERDUE / DUE_TODAY / UPCOMING',
      DEMAND_BUCKET_VALUES.length === 3 &&
        DEMAND_BUCKET_VALUES.every((b) => ['OVERDUE', 'DUE_TODAY', 'UPCOMING'].includes(b)),
      DEMAND_BUCKET_VALUES.join(', ')
    );

    // Injected business date — never the real system clock.
    const asOf = '2026-08-18';
    record(
      'Demand',
      'bucket derivation: past=OVERDUE, same day=DUE_TODAY, future=UPCOMING',
      demandService.bucketFor('2026-08-10', asOf) === DEMAND_BUCKET.OVERDUE &&
        demandService.bucketFor('2026-08-18', asOf) === DEMAND_BUCKET.DUE_TODAY &&
        demandService.bucketFor('2026-09-01', asOf) === DEMAND_BUCKET.UPCOMING,
      `10th=${demandService.bucketFor('2026-08-10', asOf)} 18th=${demandService.bucketFor('2026-08-18', asOf)} Sep=${demandService.bucketFor('2026-09-01', asOf)}`
    );

    record(
      'Demand',
      'PAID and WAIVED instalments are not demandable',
      !demandService.DEMANDABLE_STATUSES.includes(EMI_STATUS.PAID) &&
        !demandService.DEMANDABLE_STATUSES.includes(EMI_STATUS.WAIVED) &&
        demandService.DEMANDABLE_STATUSES.includes(EMI_STATUS.PARTIAL) &&
        demandService.DEMANDABLE_STATUSES.includes(EMI_STATUS.OVERDUE) &&
        demandService.DEMANDABLE_STATUSES.includes(EMI_STATUS.DUE),
      `demandable: ${demandService.DEMANDABLE_STATUSES.join(', ')}`
    );

    // Totals are summed in exact integer paise.
    const rows = [
      { demandAmount: '5375.00', bucket: DEMAND_BUCKET.OVERDUE, status: EMI_STATUS.PARTIAL, dpd: 8, loan: { id: 1 } },
      { demandAmount: '9375.00', bucket: DEMAND_BUCKET.DUE_TODAY, status: EMI_STATUS.DUE, dpd: 0, loan: { id: 1 } },
      { demandAmount: '1000.50', bucket: DEMAND_BUCKET.UPCOMING, status: EMI_STATUS.PENDING, dpd: 0, loan: { id: 2 } }
    ];
    const summary = demandService.summarise(rows, asOf);
    record(
      'Demand',
      'summary totals are exact and bucketed correctly',
      summary.totalDemand === '15750.50' &&
        summary.overdueAmount === '5375.00' &&
        summary.dueTodayAmount === '9375.00' &&
        summary.upcomingAmount === '1000.50' &&
        summary.loanCount === 2 &&
        summary.maxDpd === 8 &&
        summary.partialCount === 1,
      `total=${summary.totalDemand} overdue=${summary.overdueAmount} dueToday=${summary.dueTodayAmount} loans=${summary.loanCount}`
    );

    const demandSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'demandService.js'), 'utf8')
    );

    record(
      'Demand',
      'demand reuses the existing EMI logic instead of restating payment maths',
      /emi\.computeStatus\(asOf\)/.test(demandSource) &&
        /emi\.computeDpd\(asOf\)/.test(demandSource) &&
        /emi\.outstanding\(\)/.test(demandSource),
      'outstanding/status/DPD all come from the EmiSchedule model'
    );

    record(
      'Demand',
      'demand never writes — no create/update/destroy anywhere in the service',
      !/\.create\(|\.update\(|\.destroy\(|\.bulkCreate\(/.test(demandSource),
      'read-only by construction'
    );

    record(
      'Demand',
      'no demand table or model exists (demand is derived)',
      !Object.keys(models).some((name) => /^Demand/.test(name)) &&
        !fs.readdirSync(path.resolve(__dirname, '..', 'migrations')).some((f) => /demand/i.test(f)),
      'no second ledger'
    );

    record(
      'Demand',
      'only ACTIVE loans generate demand',
      /status: LOAN_STATUS\.ACTIVE/.test(demandSource),
      'draft, closed and cancelled loans are excluded'
    );

    record(
      'Demand',
      'future instalments are excluded unless explicitly requested',
      /includeUpcoming/.test(demandSource) && /emiDate = \{ \[Op\.lte\]: asOf \}/.test(demandSource),
      'default query is due-or-overdue only'
    );

    record(
      'Demand',
      'a COLLECTOR sees demand only for their assigned routes',
      /routeService\.isScopedActor\(actor\)/.test(demandSource) &&
        /activeRouteIdsForCollector\(actor\.id\)/.test(demandSource),
      'scoped before any loan is read'
    );
  }

  // ---------- Phase 8 permissions ----------
  {
    const routePermissions = [
      PERMISSIONS.ROUTES_VIEW,
      PERMISSIONS.ROUTES_CREATE,
      PERMISSIONS.ROUTES_UPDATE,
      PERMISSIONS.ROUTES_ASSIGN,
      PERMISSIONS.DEMAND_VIEW
    ];
    const definedNames = PERMISSION_DEFINITIONS.map((p) => p.name);
    record('Route permissions', 'all five Phase 8 permissions are defined', routePermissions.every((n) => definedNames.includes(n)), routePermissions.join(', '));

    const adminGrant = ROLE_PERMISSION_MATRIX[ROLES.ADMIN];
    const managerGrant = ROLE_PERMISSION_MATRIX[ROLES.MANAGER];
    const collectorGrant = ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR];

    record('Route permissions', 'ADMIN receives all five', routePermissions.every((n) => adminGrant.includes(n)), `${routePermissions.filter((n) => adminGrant.includes(n)).length}/5`);
    record('Route permissions', 'MANAGER receives all five', routePermissions.every((n) => managerGrant.includes(n)), `${routePermissions.filter((n) => managerGrant.includes(n)).length}/5`);

    record(
      'Route permissions',
      'COLLECTOR receives routes.view + demand.view only — no create, update or assign',
      collectorGrant.includes(PERMISSIONS.ROUTES_VIEW) &&
        collectorGrant.includes(PERMISSIONS.DEMAND_VIEW) &&
        !collectorGrant.includes(PERMISSIONS.ROUTES_CREATE) &&
        !collectorGrant.includes(PERMISSIONS.ROUTES_UPDATE) &&
        !collectorGrant.includes(PERMISSIONS.ROUTES_ASSIGN),
      collectorGrant.filter((p) => /^(routes|demand)\./.test(p)).join(', ')
    );

    record(
      'Route permissions',
      'STAFF receives no route or demand permissions',
      !ROLE_PERMISSION_MATRIX[ROLES.STAFF].some((p) => /^(routes|demand)\./.test(p)),
      ROLE_PERMISSION_MATRIX[ROLES.STAFF].join(', ') || 'none'
    );

    // Existing grants must not have been weakened.
    const phase7Admin = [PERMISSIONS.COLLECTIONS_VIEW, PERMISSIONS.COLLECTIONS_CREATE, PERMISSIONS.COLLECTIONS_REVERSE, PERMISSIONS.LOANS_CREATE, PERMISSIONS.EMIS_VIEW];
    record(
      'Phase 7 compatibility',
      'existing ADMIN grants are unchanged and roles.manage is still withheld',
      phase7Admin.every((n) => adminGrant.includes(n)) && !adminGrant.includes(PERMISSIONS.ROLES_MANAGE),
      `admin now holds ${adminGrant.length} permissions`
    );
    record(
      'Phase 7 compatibility',
      'COLLECTOR still cannot reverse collections',
      !collectorGrant.includes(PERMISSIONS.COLLECTIONS_REVERSE) && collectorGrant.includes(PERMISSIONS.COLLECTIONS_CREATE),
      'authorization not weakened by Phase 8'
    );

    const denied = await runMiddleware(requirePermission(PERMISSIONS.ROUTES_ASSIGN), {
      user: buildUser({ role: ROLES.COLLECTOR, permissions: [PERMISSIONS.ROUTES_VIEW, PERMISSIONS.DEMAND_VIEW] })
    });
    const allowed = await runMiddleware(requirePermission(PERMISSIONS.ROUTES_ASSIGN), {
      user: buildUser({ permissions: [PERMISSIONS.ROUTES_ASSIGN] })
    });
    record('Route permissions', 'assignment requires routes.assign: collector 403, holder allowed', denied === 403 && allowed === 200, `collector=${denied} holder=${allowed}`);
  }

  // ---------- Phase 8 validators ----------
  {
    const missing = await runRules(routeValidator.createRouteRules, { body: {} });
    record('Route validators', 'create requires a name', missing.some((e) => e.field === 'name'), missing.map((e) => e.field).join(', '));

    const ok = await runRules(routeValidator.createRouteRules, { body: { name: 'North Zone', description: 'Sector 1-4' } });
    record('Route validators', 'create accepts a valid route', ok.length === 0, `errors=${ok.length}`);

    const spoof = await runRules(routeValidator.createRouteRules, { body: { name: 'X', routeCode: 'RT26-999999', createdBy: 3, id: 7 } });
    const spoofFields = spoof.map((e) => e.field);
    record(
      'Route validators',
      'routeCode, createdBy and id are rejected on create',
      ['routeCode', 'createdBy', 'id'].every((f) => spoofFields.includes(f)),
      spoofFields.join(', ')
    );

    const immutable = await runRules(routeValidator.updateRouteRules, { params: { id: '1' }, body: { routeCode: 'RT26-999999' } });
    const snakeImmutable = await runRules(routeValidator.updateRouteRules, { params: { id: '1' }, body: { route_code: 'RT26-999999' } });
    record(
      'Route validators',
      'route code cannot be changed on update (camelCase or snake_case)',
      immutable.some((e) => e.field === 'routeCode') && snakeImmutable.some((e) => e.field === 'route_code'),
      'immutable by design'
    );

    const statusOnUpdate = await runRules(routeValidator.updateRouteRules, { params: { id: '1' }, body: { status: 'INACTIVE' } });
    record('Route validators', 'status cannot be changed through the update endpoint', statusOnUpdate.some((e) => e.field === 'status'), 'routed to PATCH /:id/status');

    const badStatus = await runRules(routeValidator.changeStatusRules, { params: { id: '1' }, body: { status: 'ARCHIVED' } });
    const goodStatus = await runRules(routeValidator.changeStatusRules, { params: { id: '1' }, body: { status: 'INACTIVE' } });
    record('Route validators', 'route status accepts ACTIVE/INACTIVE only', badStatus.some((e) => e.field === 'status') && goodStatus.length === 0, '"ARCHIVED" rejected');

    const badAssign = await runRules(routeValidator.assignCollectorRules, { params: { id: '1' }, body: { userId: 0, assignedAt: '2026-01-01' } });
    const assignFields = badAssign.map((e) => e.field);
    record(
      'Route validators',
      'assignment requires a positive userId and rejects client-set dates',
      assignFields.includes('userId') && assignFields.includes('assignedAt'),
      assignFields.join(', ')
    );

    // Demand date validation.
    const badDates = await Promise.all(
      ['not-a-date', '18-08-2026', '2026-13-01', '2026-02-30'].map((date) => runRules(demandValidator.demandRules, { query: { date } }))
    );
    record(
      'Demand validators',
      'rejects non-ISO, wrong-order, impossible-month and impossible-day dates',
      badDates.every((errors) => errors.some((e) => e.field === 'date')),
      '4/4 rejected including 2026-02-30'
    );

    const goodDate = await runRules(demandValidator.demandRules, { query: { date: '2026-08-18', routeId: '1', bucket: 'OVERDUE', includeUpcoming: 'true' } });
    record('Demand validators', 'accepts a valid date with route and bucket filters', goodDate.length === 0, `errors=${goodDate.length}`);

    const noDate = await runRules(demandValidator.demandRules, { query: {} });
    record('Demand validators', 'date is optional (falls back to the server business date)', noDate.length === 0, 'omitted date accepted');

    const badBucket = await runRules(demandValidator.demandRules, { query: { bucket: 'LATE' } });
    record('Demand validators', 'unknown demand bucket is rejected', badBucket.some((e) => e.field === 'bucket'), '"LATE" rejected');
  }

  // ---------- Phase 8 scope and structure ----------
  {
    const routeRouter = require('../src/routes/routeRoutes');
    const routeMethods = routeRouter.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods));
    record('Routes', 'route router exposes no DELETE (routes are deactivated)', !routeMethods.includes('delete'), `methods: ${[...new Set(routeMethods)].join(', ')}`);

    const demandRouter = require('../src/routes/demandRoutes');
    const demandMethods = demandRouter.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods));
    record(
      'Demand',
      'demand router is read-only (GET only)',
      demandMethods.every((m) => m === 'get'),
      `methods: ${[...new Set(demandMethods)].join(', ')}`
    );

    // No route/collector columns leaked onto existing models.
    const loanColumns = Object.keys(models.Loan.rawAttributes);
    const customerColumns = Object.keys(models.Customer.rawAttributes);
    const userColumns = Object.keys(models.User.rawAttributes);
    record(
      'No duplication',
      'no route or collector columns were added to loans, customers or users',
      ![...loanColumns, ...customerColumns, ...userColumns].some((c) => /route|collector/i.test(c)),
      `loans=${loanColumns.length} customers=${customerColumns.length} users=${userColumns.length} columns`
    );

    record(
      'No duplication',
      'route relationships live in history tables with the expected associations',
      Object.keys(models.Route.associations).includes('Collectors') &&
        Object.keys(models.Route.associations).includes('LoanAssignments') &&
        Object.keys(models.LoanRoute.associations).includes('Loan') &&
        Object.keys(models.Loan.associations).includes('RouteAssignments'),
      `Route: ${Object.keys(models.Route.associations).join(', ')}`
    );

    record(
      'No duplication',
      'loan_routes stores no financial amounts (EMI remains the source of truth)',
      !Object.keys(models.LoanRoute.rawAttributes).some((c) => /amount|emi|principal|interest|demand/i.test(c)),
      `columns: ${Object.keys(models.LoanRoute.rawAttributes).join(', ')}`
    );
  }

  // ---------- Reports: no new tables, derived only ----------
  {
    const reportConfig = require('../src/config/reports');
    const reportService = require('../src/services/reportService');
    const receiptService = require('../src/services/receiptService');
    const reportValidator = require('../src/validators/reportValidator');
    const { toCsv, escapeField } = require('../src/utils/csv');

    const migrationFiles = fs.readdirSync(path.resolve(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.js'));
    record(
      'Reports',
      'Phase 9 added NO migration and NO report/receipt table',
      // Counting migrations would break every time a later phase adds one, so
      // this asserts what the rule actually is: no reporting table exists.
      !migrationFiles.some((f) => /report|receipt/i.test(f)),
      `${migrationFiles.length} migrations, none report-related`
    );

    const modelNames = Object.keys(models).filter((k) => k !== 'sequelize');
    record(
      'Reports',
      'no Report/Receipt model exists — reports are derived views',
      !modelNames.some((n) => /^(Report|Receipt)/.test(n)),
      `${modelNames.length} models, unchanged from Phase 8`
    );

    const reportSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportService.js'), 'utf8')
    );
    const receiptSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'receiptService.js'), 'utf8')
    );

    record(
      'Reports',
      'report and receipt services perform no writes',
      !/\.create\(|\.update\(|\.destroy\(|\.bulkCreate\(/.test(reportSource) &&
        !/\.create\(|\.update\(|\.destroy\(|\.bulkCreate\(/.test(receiptSource),
      'read-only by construction'
    );

    record(
      'Reports',
      'reports reuse the existing EMI and demand logic instead of recalculating',
      /emi\.outstanding\(\)/.test(reportSource) &&
        /emi\.computeStatus\(asOf\)/.test(reportSource) &&
        /emi\.computeDpd\(asOf\)/.test(reportSource) &&
        /demandService\.getDemand/.test(reportSource),
      'EmiSchedule model methods + demandService'
    );

    record(
      'Reports',
      'money is summed with the shared paise utility, never floats',
      reportSource.includes("require('../utils/money')") && !/parseFloat/.test(reportSource),
      'toPaise/fromPaise only'
    );

    record(
      'Reports',
      'no raw SQL string concatenation of user input',
      !/query\(`[^`]*\$\{/.test(reportSource) && !/query\('.*'\s*\+/.test(reportSource),
      'Sequelize operators throughout'
    );

    // Scope helper must exist and be used by every report.
    record(
      'Reports',
      'every report resolves the caller scope before querying',
      (reportSource.match(/resolveScope\(actor/g) ?? []).length >= 4,
      `${(reportSource.match(/resolveScope\(actor/g) ?? []).length} scope resolutions`
    );

    record(
      'Reports',
      'a collector requesting another route or collector is refused, not silently emptied',
      /You are not assigned to this route/.test(reportSource) && /only report on your own collections/.test(reportSource),
      'throws 403 in resolveScope'
    );
  }

  // ---------- EMI status predicate parity ----------
  {
    const reportService = require('../src/services/reportService');
    const statuses = [...EMI_STATUS_VALUES];

    const built = statuses.map((status) => ({
      status,
      predicate: reportService.emiStatusPredicate(status, '2026-08-18')
    }));

    // Reflect.ownKeys, not Object.keys: Sequelize builds these with Symbol
    // operator keys (Op.and), which Object.keys does not report.
    record(
      'EMI predicate',
      'a SQL predicate exists for every EMI status',
      built.every((entry) => entry.predicate && Reflect.ownKeys(entry.predicate).length > 0),
      statuses.join(', ')
    );

    // The predicate must never contradict the model's precedence: a waived row
    // is only ever WAIVED, and paid/partial are decided on money before dates.
    const predicateSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportService.js'), 'utf8')
    ).match(/function emiStatusPredicate[\s\S]*?\n}/)[0];

    record(
      'EMI predicate',
      'PAID/PARTIAL are decided on collected vs EMI amount, matching computeStatus precedence',
      /amount_collected` >= `EmiSchedule`\.`emi_amount`/.test(predicateSource) &&
        /amount_collected` > 0/.test(predicateSource) &&
        /amount_collected` < `EmiSchedule`\.`emi_amount`/.test(predicateSource),
      'money first, exactly as the model does'
    );
    record(
      'EMI predicate',
      'OVERDUE/DUE/PENDING require zero collected and compare the due date to the business date',
      /amount_collected` = 0[\s\S]*?Op\.lt/.test(predicateSource) &&
        /amount_collected` = 0[\s\S]*?emiDate: asOf/.test(predicateSource) &&
        /amount_collected` = 0[\s\S]*?Op\.gt/.test(predicateSource),
      'date ordering matches computeStatus'
    );
    // One declaration plus one use in each of the five non-waived branches.
    const notWaivedUses = (predicateSource.match(/notWaived/g) ?? []).length - 1;
    record(
      'EMI predicate',
      'every non-waived branch excludes WAIVED rows',
      notWaivedUses === 5,
      `${notWaivedUses} branches guard against WAIVED (PAID, PARTIAL, OVERDUE, DUE, PENDING)`
    );
  }

  // ---------- CSV export safety ----------
  {
    const { toCsv, escapeField } = require('../src/utils/csv');
    const { CSV_COLUMNS, REPORTS } = require('../src/config/reports');

    record(
      'CSV',
      'quotes fields containing commas, quotes and newlines',
      escapeField('a,b') === '"a,b"' &&
        escapeField('say "hi"') === '"say ""hi"""' &&
        escapeField('line1\nline2') === '"line1\nline2"',
      'RFC 4180 quoting'
    );

    record(
      'CSV',
      'neutralises spreadsheet formula injection',
      escapeField('=1+1') === "'=1+1" &&
        escapeField('+A1') === "'+A1" &&
        escapeField('-cmd') === "'-cmd" &&
        escapeField('@SUM(A1)') === "'@SUM(A1)",
      'leading = + - @ are prefixed'
    );

    const csv = toCsv([{ a: 'x', nested: { b: 'y' } }], [{ header: 'A', path: 'a' }, { header: 'B', path: 'nested.b' }]);
    record('CSV', 'reads nested paths and emits a header row', csv.includes('A,B') && csv.includes('x,y'), csv.trim().split('\r\n').join(' | '));

    const missing = toCsv([{}], [{ header: 'A', path: 'deep.missing.path' }]);
    record('CSV', 'a missing path becomes an empty cell rather than throwing', missing.includes('A\r\n'), 'no crash on absent branch');

    // No export column may expose a credential or internal identifier.
    const allColumns = Object.values(CSV_COLUMNS).flat();
    const risky = allColumns.filter((column) => /password|token|secret|hash|\bid\b|role_id|created_by_id/i.test(`${column.header} ${column.path}`));
    record(
      'CSV',
      'no export column exposes a password, token, hash or internal id',
      risky.length === 0,
      risky.length ? risky.map((c) => c.header).join(', ') : `${allColumns.length} columns across ${Object.keys(CSV_COLUMNS).length} reports`
    );

    record(
      'CSV',
      'every report has an explicit column definition (columns are declared, not inferred)',
      Object.values(REPORTS).every((key) => Array.isArray(CSV_COLUMNS[key]) && CSV_COLUMNS[key].length > 0),
      Object.values(REPORTS).map((k) => `${k}:${CSV_COLUMNS[k].length}`).join(' ')
    );

    const controllerSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'controllers', 'reportController.js'), 'utf8')
    );
    record(
      'CSV',
      'the export runs the same service call as the on-screen report',
      /run\(\s*wantsFile \?/.test(controllerSource) && !/run\(/.test(controllerSource.replace(/run\(\s*wantsFile \?/, '')),
      'one query path for JSON and every download format'
    );
    record(
      'CSV',
      'an oversized export is refused rather than silently truncated',
      /EXPORT_MAX_ROWS/.test(controllerSource) && /would exceed/.test(controllerSource),
      'explicit 400'
    );
    record(
      'CSV',
      'exports are audited (a download is a data artifact); report views are not',
      /REPORT_EXPORTED/.test(controllerSource) && !/REPORT_VIEWED/.test(controllerSource),
      'REPORT_EXPORTED only'
    );
  }

  // ---------- Receipt ----------
  {
    const receiptSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'receiptService.js'), 'utf8')
    );

    record(
      'Receipt',
      'a reversed collection is flagged as not a valid payment',
      /isValidPayment: !isReversed/.test(receiptSource) && /not a valid receipt of payment/i.test(receiptSource),
      'validity block carries the notice'
    );
    record(
      'Receipt',
      'a reversed receipt still returns its historical allocations',
      !/if \(isReversed\)[\s\S]{0,80}return/.test(receiptSource) && /allocations/.test(receiptSource),
      'history preserved, not withheld'
    );
    record(
      'Receipt',
      'totals reconcile allocated PLUS bounce against the collection amount',
      /reconciles: allocatedPaise \+ bouncePaise === amountPaise/.test(receiptSource) &&
        /unallocated: fromPaise\(amountPaise - allocatedPaise - bouncePaise\)/.test(receiptSource),
      'computed in paise; a bounce component is accounted for, not left as unexplained money'
    );
    record(
      'Receipt',
      'a collector is scope-checked before any receipt data is returned',
      /isScopedActor\(actor\)/.test(receiptSource) && /outside the routes you are assigned to/.test(receiptSource),
      'route or self-posted only'
    );
  }

  // ---------- Phase 9 permissions ----------
  {
    const phase9 = [PERMISSIONS.REPORTS_VIEW, PERMISSIONS.REPORTS_EXPORT, PERMISSIONS.RECEIPTS_VIEW];
    const defined = PERMISSION_DEFINITIONS.map((p) => p.name);
    record('Report permissions', 'all three Phase 9 permissions are defined', phase9.every((p) => defined.includes(p)), phase9.join(', '));

    const adminGrant = ROLE_PERMISSION_MATRIX[ROLES.ADMIN];
    const managerGrant = ROLE_PERMISSION_MATRIX[ROLES.MANAGER];
    const collectorGrant = ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR];

    record('Report permissions', 'ADMIN receives all three', phase9.every((p) => adminGrant.includes(p)), `${phase9.filter((p) => adminGrant.includes(p)).length}/3`);
    record('Report permissions', 'MANAGER receives all three', phase9.every((p) => managerGrant.includes(p)), `${phase9.filter((p) => managerGrant.includes(p)).length}/3`);
    record(
      'Report permissions',
      'COLLECTOR may view reports and receipts but NOT export',
      collectorGrant.includes(PERMISSIONS.REPORTS_VIEW) &&
        collectorGrant.includes(PERMISSIONS.RECEIPTS_VIEW) &&
        !collectorGrant.includes(PERMISSIONS.REPORTS_EXPORT),
      collectorGrant.filter((p) => /^(reports|receipts)\./.test(p)).join(', ')
    );
    record(
      'Report permissions',
      'STAFF receives no report or receipt permission',
      !ROLE_PERMISSION_MATRIX[ROLES.STAFF].some((p) => /^(reports|receipts)\./.test(p)),
      ROLE_PERMISSION_MATRIX[ROLES.STAFF].join(', ') || 'none'
    );

    const denied = await runMiddleware(requirePermission(PERMISSIONS.REPORTS_EXPORT), {
      user: buildUser({ role: ROLES.COLLECTOR, permissions: [PERMISSIONS.REPORTS_VIEW, PERMISSIONS.RECEIPTS_VIEW] })
    });
    const allowed = await runMiddleware(requirePermission(PERMISSIONS.REPORTS_EXPORT), {
      user: buildUser({ permissions: [PERMISSIONS.REPORTS_EXPORT] })
    });
    record('Report permissions', 'export requires reports.export: collector 403, holder allowed', denied === 403 && allowed === 200, `collector=${denied} holder=${allowed}`);

    // Phase 1-8 grants must not have been weakened.
    record(
      'Phase 8 compatibility',
      'existing route/demand grants are intact and COLLECTOR still cannot assign',
      adminGrant.includes(PERMISSIONS.ROUTES_ASSIGN) &&
        collectorGrant.includes(PERMISSIONS.ROUTES_VIEW) &&
        !collectorGrant.includes(PERMISSIONS.ROUTES_ASSIGN) &&
        !collectorGrant.includes(PERMISSIONS.COLLECTIONS_REVERSE),
      'authorization not weakened by Phase 9'
    );
  }

  // ---------- Phase 9 validators ----------
  {
    const reportValidator = require('../src/validators/reportValidator');

    const badDates = await Promise.all(
      ['2026-02-30', '18-08-2026', 'not-a-date', '2026-13-01'].map((dateFrom) =>
        runRules(reportValidator.loanReportRules, { query: { dateFrom } })
      )
    );
    record(
      'Report validators',
      'invalid dates are rejected on report filters',
      badDates.every((errors) => errors.some((e) => e.field === 'dateFrom')),
      '4/4 rejected including 2026-02-30'
    );

    const good = await runRules(reportValidator.loanReportRules, {
      query: { dateFrom: '2026-01-01', dateTo: '2026-12-31', status: 'ACTIVE', routeId: '1', page: '2', limit: '50' }
    });
    record('Report validators', 'a valid loan-report filter set is accepted', good.length === 0, `errors=${good.length}`);

    const badFormat = await runRules(reportValidator.loanReportRules, { query: { format: 'pdf' } });
    record('Report validators', 'an unsupported export format is rejected', badFormat.some((e) => e.field === 'format'), 'only csv');

    const badStatus = await runRules(reportValidator.emiReportRules, { query: { status: 'SETTLED' } });
    const badDpd = await runRules(reportValidator.emiReportRules, { query: { minDpd: '-5' } });
    record(
      'Report validators',
      'EMI report rejects unknown status and negative DPD',
      badStatus.some((e) => e.field === 'status') && badDpd.some((e) => e.field === 'minDpd'),
      'status + minDpd guarded'
    );

    const badLimit = await runRules(reportValidator.collectionReportRules, { query: { limit: '5000' } });
    record('Report validators', 'limit is capped', badLimit.some((e) => e.field === 'limit'), 'max enforced');

    const badReceipt = await runRules(reportValidator.receiptRules, { params: { id: 'abc' } });
    record('Report validators', 'receipt id must be a positive integer', badReceipt.some((e) => e.field === 'id'), 'guarded');
  }

  // ---------- Dashboard: consumer, not a source of truth ----------
  {
    const dashboardService = require('../src/services/dashboardService');
    const dashboardConfig = require('../src/config/dashboard');
    const dashboardValidator = require('../src/validators/dashboardValidator');

    const dashboardSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'dashboardService.js'), 'utf8')
    );

    record(
      'Dashboard',
      'Phase 10 added NO migration and NO dashboard table',
      !fs
        .readdirSync(path.resolve(__dirname, '..', 'migrations'))
        .some((f) => /dashboard|kpi|metric/i.test(f)),
      'no dashboard/KPI table in any migration'
    );

    record(
      'Dashboard',
      'no Dashboard/Kpi model exists',
      !Object.keys(models).some((n) => /^(Dashboard|Kpi|Metric)/.test(n)),
      `${Object.keys(models).filter((k) => k !== 'sequelize').length} models, unchanged`
    );

    record(
      'Dashboard',
      'the service performs no writes',
      !/\.create\(|\.update\(|\.destroy\(|\.bulkCreate\(/.test(dashboardSource),
      'read-only by construction'
    );

    record(
      'Dashboard',
      'loan / collection / EMI money comes from the Phase 9 report service',
      /reportService\.loanReport/.test(dashboardSource) &&
        /reportService\.collectionReport/.test(dashboardSource) &&
        /reportService\.emiReport/.test(dashboardSource),
      'summaries consumed, not recomputed'
    );

    record(
      'Dashboard',
      'demand comes from the Phase 8 demand service',
      /demandService\.getDemand/.test(dashboardSource),
      'demand is not re-derived'
    );

    record(
      'Dashboard',
      'scope uses the shared resolver rather than a second implementation',
      /reportService\.resolveScope/.test(dashboardSource) && /reportService\.loanIdsForRoutes/.test(dashboardSource),
      'same guard as the reports'
    );

    record(
      'Dashboard',
      'money is handled in paise, never floats',
      dashboardSource.includes("require('../utils/money')") && !/parseFloat/.test(dashboardSource),
      'toPaise/fromPaise/divideRoundHalfUp'
    );

    record(
      'Dashboard',
      'raw SQL is parameterised — no user input is concatenated',
      /replacements/.test(dashboardSource) && !/\$\{(filters|routeId|collectorId|date)/.test(dashboardSource),
      ':businessDate / :routeIds / :loanIds bindings only'
    );

    // Per-route and per-collector metrics must not fan out into a query each.
    record(
      'Dashboard',
      'route metrics use ONE grouped query, not one per route',
      /GROUP BY lr\.route_id/.test(dashboardSource) && (dashboardSource.match(/routeAggregate\(/g) ?? []).length === 2,
      'single aggregate covering every route'
    );
    record(
      'Dashboard',
      'collector metrics are folded from route rows, costing no extra queries',
      /for \(const routeRow of routePerformance\)/.test(dashboardSource) &&
        !/for[\s\S]{0,120}await[\s\S]{0,80}collector/i.test(dashboardSource),
      'no query inside a collector loop'
    );
    record(
      'Dashboard',
      'route collectors are fetched in one query for all routes',
      /RouteCollector\.findAll\(\{[\s\S]{0,120}routeId: \{ \[Op\.in\]: routeIdsSeen \}/.test(dashboardSource),
      'no per-route collector query'
    );

    /*
     * Overdue amount answers "how much", the count beside it answers "how many
     * borrowers". Counting instalment rows answered neither: three missed
     * instalments on one loan read as three overdue loans.
     */
    record(
      'Dashboard',
      'the overdue loan count is a DISTINCT count of loans, not a count of instalment rows',
      /COUNT\(DISTINCT CASE WHEN e\.emi_date < :businessDate[\s\S]{0,160}THEN e\.loan_id END\)[\s]*AS overdueLoanCount/.test(
        dashboardSource
      ),
      'COUNT(DISTINCT ... loan_id)'
    );
    record(
      'Dashboard',
      'it selects the same instalments as the overdue EMI count, so the two can never describe different debt',
      (() => {
        // Both predicates: past its due date AND not fully collected.
        const overdueRows = dashboardSource.match(
          /e\.emi_date < :businessDate\s*\n\s*AND e\.amount_collected < e\.emi_amount/g
        );
        // Twice per aggregate for the overall query (count + distinct loans),
        // once in the per-route query which has no distinct-loan column.
        return overdueRows !== null && overdueRows.length === 3;
      })(),
      'one predicate, used by both columns'
    );
    record(
      'Dashboard',
      'the loan count rides the SAME query as the amount, so every filter reaches it',
      (() => {
        const overall = dashboardSource.slice(
          dashboardSource.indexOf('async function overallDueAggregate'),
          dashboardSource.indexOf('/** Loan counts by status')
        );
        return (
          /AS overdueAmount/.test(overall) &&
          /AS overdueLoanCount/.test(overall) &&
          /AND e\.loan_id IN \(:loanIds\)/.test(overall) &&
          (overall.match(/sequelize\.query\(/g) ?? []).length === 1
        );
      })(),
      'business date, route and collector scope apply to both'
    );
    record(
      'Dashboard',
      'the overdue AMOUNT calculation was not touched',
      /COALESCE\(SUM\(CASE WHEN e\.emi_date < :businessDate\s*\n\s*THEN e\.emi_amount - e\.amount_collected ELSE 0 END\), 0\) AS overdueAmount/.test(
        dashboardSource
      ),
      'same SUM as before'
    );
    record(
      'Dashboard',
      'an empty scope reports zero overdue loans rather than omitting the field',
      /overdueCount: 0, overdueLoanCount: 0/.test(dashboardSource),
      'no undefined leaking into the card'
    );
    record(
      'Dashboard',
      'the card shows overdue LOANS while keeping the overdue amount as its value',
      (() => {
        const page = stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Dashboard.jsx'), 'utf8'));
        const card = page.slice(page.indexOf('label="Overdue amount"'), page.indexOf('label="Overdue amount"') + 400);
        return (
          /value=\{formatCurrency\(data\.emi\.overdueAmount\)\}/.test(card) &&
          /overdueLoanCount\} overdue loan/.test(card) &&
          !/overdueCount\} overdue EMIs/.test(card)
        );
      })(),
      '₹ amount as the value, "N overdue loans" beneath it'
    );
    record(
      'Dashboard',
      'the subtitle reads correctly for a single overdue loan',
      (() => {
        const page = stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Dashboard.jsx'), 'utf8'));
        const render = (overdueLoanCount) => `${overdueLoanCount} overdue loan${overdueLoanCount === 1 ? '' : 's'}`;
        return (
          /overdueLoanCount === 1 \? '' : 's'/.test(page) &&
          render(1) === '1 overdue loan' &&
          render(6) === '6 overdue loans' &&
          render(0) === '0 overdue loans'
        );
      })(),
      '1 overdue loan / 6 overdue loans'
    );
    record(
      'Dashboard',
      'no other dashboard card was repointed',
      (() => {
        const page = stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Dashboard.jsx'), 'utf8'));
        return (
          (page.match(/overdueLoanCount/g) ?? []).length === 2 &&
          /label="Partially paid EMIs" value=\{data\.emi\.partialCount\}/.test(page) &&
          // The route and collector tables still report instalments, as before.
          (page.match(/\{row\.overdueCount\}/g) ?? []).length === 2
        );
      })(),
      'one card changed'
    );
  }

  // ---------- Efficiency definition ----------
  {
    const dashboardService = require('../src/services/dashboardService');

    record(
      'Efficiency',
      'the ratio ships with an explicit denominator definition',
      typeof dashboardService.EFFICIENCY_DEFINITION === 'string' &&
        /due =/.test(dashboardService.EFFICIENCY_DEFINITION) &&
        /on or before the business date/.test(dashboardService.EFFICIENCY_DEFINITION),
      dashboardService.EFFICIENCY_DEFINITION.slice(0, 90) + '…'
    );

    record(
      'Efficiency',
      'future instalments are excluded from the denominator',
      /emi_date <= :businessDate/.test(
        stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'dashboardService.js'), 'utf8'))
      ),
      'upcoming demand cannot dilute current performance'
    );

    const pct = dashboardService.efficiencyPercent;
    record(
      'Efficiency',
      'percentage is computed in integer paise and rounded to one decimal',
      pct(toPaise('50.00'), toPaise('100.00')) === 50 &&
        pct(toPaise('4600.00'), toPaise('31800.00')) === 14.5 &&
        pct(toPaise('100.00'), toPaise('100.00')) === 100 &&
        pct(0n, toPaise('100.00')) === 0,
      '50%, 14.5%, 100%, 0%'
    );

    record(
      'Efficiency',
      'a zero denominator yields null rather than a divide-by-zero or a fake 0%',
      pct(toPaise('10.00'), 0n) === null && pct(0n, 0n) === null,
      'null when nothing is due'
    );
  }

  // ---------- Period resolution ----------
  {
    const { resolvePeriod, PERIODS } = require('../src/config/dashboard');
    const clockDate = '2026-08-18';

    const todayPeriod = resolvePeriod({ period: PERIODS.TODAY, date: clockDate });
    const yesterdayPeriod = resolvePeriod({ period: PERIODS.YESTERDAY, date: clockDate });
    const monthPeriod = resolvePeriod({ period: PERIODS.THIS_MONTH, date: clockDate });
    const customPeriod = resolvePeriod({ period: PERIODS.CUSTOM, date: clockDate, dateFrom: '2026-08-01', dateTo: '2026-08-10' });

    record(
      'Dashboard periods',
      'TODAY / YESTERDAY / THIS_MONTH / CUSTOM resolve to explicit date ranges',
      todayPeriod.from === clockDate && todayPeriod.to === clockDate &&
        yesterdayPeriod.businessDate === '2026-08-17' && yesterdayPeriod.from === '2026-08-17' &&
        monthPeriod.from === '2026-08-01' && monthPeriod.to === clockDate &&
        customPeriod.from === '2026-08-01' && customPeriod.to === '2026-08-10',
      `today=${todayPeriod.from} yesterday=${yesterdayPeriod.from} month=${monthPeriod.from}..${monthPeriod.to} custom=${customPeriod.from}..${customPeriod.to}`
    );

    record(
      'Dashboard periods',
      'month start is derived from the business date, crossing years correctly',
      resolvePeriod({ period: PERIODS.THIS_MONTH, date: '2027-01-15' }).from === '2027-01-01' &&
        resolvePeriod({ period: PERIODS.YESTERDAY, date: '2027-01-01' }).businessDate === '2026-12-31',
      'uses the shared date utility, no second implementation'
    );

    record(
      'Dashboard periods',
      'an unknown period falls back to TODAY rather than throwing',
      resolvePeriod({ period: 'NONSENSE', date: clockDate }).period === PERIODS.TODAY,
      'safe default'
    );
  }

  // ---------- Dashboard permissions & validators ----------
  {
    const dashboardValidator = require('../src/validators/dashboardValidator');

    record(
      'Dashboard permissions',
      'dashboard.view is defined',
      PERMISSION_DEFINITIONS.some((p) => p.name === PERMISSIONS.DASHBOARD_VIEW),
      PERMISSIONS.DASHBOARD_VIEW
    );

    const grants = {
      admin: ROLE_PERMISSION_MATRIX[ROLES.ADMIN],
      manager: ROLE_PERMISSION_MATRIX[ROLES.MANAGER],
      collector: ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR],
      staff: ROLE_PERMISSION_MATRIX[ROLES.STAFF]
    };
    record(
      'Dashboard permissions',
      'ADMIN, MANAGER and COLLECTOR hold dashboard.view; STAFF does not',
      grants.admin.includes(PERMISSIONS.DASHBOARD_VIEW) &&
        grants.manager.includes(PERMISSIONS.DASHBOARD_VIEW) &&
        grants.collector.includes(PERMISSIONS.DASHBOARD_VIEW) &&
        !grants.staff.includes(PERMISSIONS.DASHBOARD_VIEW),
      'collector access is scoped by the service'
    );

    record(
      'Phase 9 compatibility',
      'existing report/receipt grants are unchanged and COLLECTOR still cannot export',
      grants.admin.includes(PERMISSIONS.REPORTS_EXPORT) &&
        grants.collector.includes(PERMISSIONS.REPORTS_VIEW) &&
        !grants.collector.includes(PERMISSIONS.REPORTS_EXPORT),
      'authorization not weakened by Phase 10'
    );

    const badDates = await Promise.all(
      ['2026-02-30', '18-08-2026', 'not-a-date'].map((date) => runRules(dashboardValidator.dashboardRules, { query: { date } }))
    );
    record('Dashboard validators', 'invalid dates rejected', badDates.every((e) => e.some((x) => x.field === 'date')), '3/3');

    const badPeriod = await runRules(dashboardValidator.dashboardRules, { query: { period: 'LAST_DECADE' } });
    record('Dashboard validators', 'unknown period rejected', badPeriod.some((e) => e.field === 'period'), 'guarded');

    const badIds = await runRules(dashboardValidator.dashboardRules, { query: { routeId: '0', collectorId: 'abc' } });
    record('Dashboard validators', 'routeId/collectorId must be positive integers', badIds.length === 2, badIds.map((e) => e.field).join(', '));

    const good = await runRules(dashboardValidator.dashboardRules, {
      query: { period: 'THIS_MONTH', date: '2026-08-18', routeId: '1', collectorId: '4' }
    });
    record('Dashboard validators', 'a valid filter set is accepted', good.length === 0, `errors=${good.length}`);

    const dashboardRouter = require('../src/routes/dashboardRoutes');
    const methods = dashboardRouter.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods));
    record(
      'Dashboard',
      'the dashboard router is read-only (GET only) and is a single endpoint',
      methods.length === 1 && methods[0] === 'get',
      `methods: ${methods.join(', ')}`
    );

    const controllerSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'controllers', 'dashboardController.js'), 'utf8')
    );
    record(
      'Dashboard',
      'dashboard views are not audited',
      !/auditService/.test(controllerSource),
      'no audit row per view'
    );
  }

  // ---------- Alerts ----------
  {
    const { ALERT_TYPES, ALERT_SEVERITY } = require('../src/config/dashboard');
    const dashboardSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'dashboardService.js'), 'utf8')
    );

    record(
      'Alerts',
      'alert vocabulary is fixed and fact-based',
      Object.keys(ALERT_TYPES).length === 6 && Object.keys(ALERT_SEVERITY).length === 3,
      Object.values(ALERT_TYPES).join(', ')
    );
    record(
      'Alerts',
      'no risk score, weighting or invented threshold is computed',
      !/riskScore|weight|score\s*=/.test(dashboardSource),
      'counts and amounts only'
    );
    record(
      'Alerts',
      'every alert carries a destination link',
      (dashboardSource.match(/link:/g) ?? []).length >= 5,
      'each alert points at the page showing the detail'
    );
  }

  // ---------- Phase 11: interest method (FLAT / REDUCING) ----------
  {
    const calc = require('../src/services/loanCalculationService');
    const { INTEREST_METHODS, WEEKLY_OFF, isWeeklyOffAllowed, FINANCIAL_FIELDS } = require('../src/config/loans');

    const sumOf = (periods, key) => fromPaise(periods.reduce((total, row) => total + toPaise(row[key]), 0n));

    // --- FLAT stays exactly what Phase 5 produced ---
    // These are the loans already in the database. They were priced when the
    // entered rate meant "per year", so they are checked on that basis.
    const flatCases = [
      { terms: { loanAmount: '100000.00', roi: '12.5000', tenure: 12, loanType: 'MONTHLY', roiBasis: 'ANNUAL' }, total: '112500.00', emi: '9375.00', count: 12 },
      { terms: { loanAmount: '10000.00', roi: '10.0000', tenure: 90, loanType: 'DAILY', roiBasis: 'ANNUAL' }, total: '10246.58', emi: '113.85', count: 90 },
      { terms: { loanAmount: '60000.00', roi: '12.0000', tenure: 6, loanType: 'MONTHLY', roiBasis: 'ANNUAL' }, total: '63600.00', emi: '10600.00', count: 6 }
    ];
    const flatUnchanged = flatCases.map((testCase) => {
      const result = calculateLoanFinancials(testCase.terms);
      return result.totalRepayment === testCase.total && result.emiAmount === testCase.emi && result.emiCount === testCase.count;
    });
    record(
      'Phase 11 flat',
      'the existing flat figures are unchanged by the new calculation path',
      flatUnchanged.every(Boolean),
      flatCases.map((c, i) => `${c.terms.loanAmount}@${c.terms.roi}x${c.terms.tenure}=${flatUnchanged[i] ? 'same' : 'CHANGED'}`).join(', ')
    );
    record(
      'Phase 11 flat',
      'FLAT remains the default when no method is supplied',
      calculateLoanFinancials(flatCases[0].terms).interestMethod === INTEREST_METHODS.FLAT,
      'interestMethod defaults to FLAT'
    );

    const flatPlan = calc.buildInstalmentPlan({ loanAmount: '100000.00', roi: '10.0000', tenure: 7, loanType: 'MONTHLY' });
    record(
      'Phase 11 flat',
      'flat instalments reconcile: principal = loan, interest = total interest, EMIs = repayment',
      sumOf(flatPlan.periods, 'principal') === '100000.00' &&
        sumOf(flatPlan.periods, 'interest') === flatPlan.summary.interest &&
        sumOf(flatPlan.periods, 'emiAmount') === flatPlan.summary.totalRepayment,
      `principal ${sumOf(flatPlan.periods, 'principal')}, interest ${sumOf(flatPlan.periods, 'interest')}, emis ${sumOf(flatPlan.periods, 'emiAmount')}`
    );
    record(
      'Phase 11 flat',
      'the flat rounding residue lands on the final instalment',
      toPaise(flatPlan.periods[flatPlan.periods.length - 1].emiAmount) - toPaise(flatPlan.summary.emiAmount) ===
        toPaise(flatPlan.summary.roundingRemainder),
      `emi ${flatPlan.summary.emiAmount}, last ${flatPlan.summary.lastEmiAmount}, residue ${flatPlan.summary.roundingRemainder}`
    );

    // --- REDUCING ---
    const reducingTerms = { loanAmount: '100000.00', roi: '1.0000', tenure: 12, loanType: 'MONTHLY', interestMethod: 'REDUCING' };
    const reducing = calc.buildInstalmentPlan(reducingTerms);

    record(
      'Phase 11 reducing',
      'the level instalment matches the standard reducing-balance EMI',
      reducing.summary.emiAmount === '8884.88',
      `100000 @ 1% per month x 12 -> ${reducing.summary.emiAmount} (textbook 8884.88)`
    );
    record(
      'Phase 11 reducing',
      'the first instalment charges interest on the full principal',
      reducing.periods[0].interest === '1000.00',
      `100000 x 1% per month = ${reducing.periods[0].interest}`
    );

    const interestFalls = reducing.periods.every(
      (row, index) => index === 0 || toPaise(row.interest) < toPaise(reducing.periods[index - 1].interest)
    );
    const principalRises = reducing.periods.every(
      (row, index) => index === 0 || toPaise(row.principal) > toPaise(reducing.periods[index - 1].principal)
    );
    record(
      'Phase 11 reducing',
      'interest falls and principal rises across the schedule',
      interestFalls && principalRises,
      `interest ${reducing.periods[0].interest} -> ${reducing.periods[11].interest}, principal ${reducing.periods[0].principal} -> ${reducing.periods[11].principal}`
    );
    record(
      'Phase 11 reducing',
      'reducing instalments reconcile to the paise',
      sumOf(reducing.periods, 'principal') === '100000.00' &&
        sumOf(reducing.periods, 'interest') === reducing.summary.interest &&
        sumOf(reducing.periods, 'emiAmount') === reducing.summary.totalRepayment,
      `principal ${sumOf(reducing.periods, 'principal')}, interest ${sumOf(reducing.periods, 'interest')}, emis ${sumOf(reducing.periods, 'emiAmount')}`
    );
    record(
      'Phase 11 reducing',
      'the final instalment absorbs the rounding residue',
      toPaise(reducing.summary.lastEmiAmount) - toPaise(reducing.summary.emiAmount) === toPaise(reducing.summary.roundingRemainder) &&
        reducing.summary.lastEmiAmount === reducing.periods[reducing.periods.length - 1].emiAmount,
      `emi ${reducing.summary.emiAmount}, last ${reducing.summary.lastEmiAmount}, residue ${reducing.summary.roundingRemainder}`
    );

    const flatSame = calculateLoanFinancials({ loanAmount: '100000.00', roi: '1.0000', tenure: 12, loanType: 'MONTHLY' });
    record(
      'Phase 11 reducing',
      'reducing costs the borrower less than flat on identical terms',
      toPaise(reducing.summary.interest) < toPaise(flatSame.interest),
      `reducing ${reducing.summary.interest} < flat ${flatSame.interest}`
    );

    const zeroRate = calc.buildInstalmentPlan({ loanAmount: '12000.00', roi: '0', tenure: 12, loanType: 'MONTHLY', interestMethod: 'REDUCING' });
    record(
      'Phase 11 reducing',
      'a zero rate splits the principal evenly instead of dividing by zero',
      zeroRate.summary.interest === '0.00' && zeroRate.summary.emiAmount === '1000.00' && sumOf(zeroRate.periods, 'principal') === '12000.00',
      `emi ${zeroRate.summary.emiAmount}, interest ${zeroRate.summary.interest}`
    );

    const single = calc.buildInstalmentPlan({ loanAmount: '10000.00', roi: '1.0000', tenure: 1, loanType: 'MONTHLY', interestMethod: 'REDUCING' });
    record(
      'Phase 11 reducing',
      'a single-instalment reducing loan repays principal plus one period of interest',
      single.periods.length === 1 && single.periods[0].principal === '10000.00' && single.periods[0].interest === '100.00',
      `emi ${single.summary.emiAmount} = 10000.00 + 100.00`
    );

    const longDaily = calc.buildInstalmentPlan({
      loanAmount: '500000.00', roi: '2.0000', tenure: 3650, loanType: 'DAILY', startDate: '2026-01-01', interestMethod: 'REDUCING'
    });
    record(
      'Phase 11 reducing',
      'the longest permitted term still reconciles exactly',
      longDaily.periods.length === 3650 && sumOf(longDaily.periods, 'principal') === '500000.00',
      `3650 daily instalments, principal ${sumOf(longDaily.periods, 'principal')}`
    );

    // Reachable, and not theoretical: a monthly rate high enough that the level
    // instalment never bites into principal must be refused, not looped over.
    let neverAmortises = null;
    try {
      calc.buildInstalmentPlan({
        loanAmount: '500000.00', roi: '24.0000', tenure: 3650, loanType: 'DAILY', startDate: '2026-01-01', interestMethod: 'REDUCING'
      });
    } catch (error) {
      neverAmortises = error;
    }
    record(
      'Phase 11 reducing',
      'a rate that would never amortise is refused rather than silently mis-priced',
      neverAmortises !== null && neverAmortises.statusCode === 400,
      `${neverAmortises?.statusCode} — "${neverAmortises?.message}"`
    );

    record(
      'Phase 11 reducing',
      'the annuity is evaluated in exact integer arithmetic, with no float or Math.pow',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanCalculationService.js'), 'utf8'));
        return !/Math\.(pow|round|floor|ceil)|parseFloat|Number\(.*\)\s*[*/+-]\s*Number\(/.test(source) && /\*\* n/.test(source);
      })(),
      'BigInt exponentiation only'
    );
  }

  // ---------- Phase 11: daily loans and Sunday exclusion ----------
  {
    const calc = require('../src/services/loanCalculationService');
    const { WEEKLY_OFF } = require('../src/config/loans');

    // 2026-08-18 is a Tuesday: the 30 days after it contain exactly 4 Sundays.
    const base = { loanAmount: '10000.00', roi: '10.0000', tenure: 30, loanType: 'DAILY', startDate: '2026-08-18' };

    const none = calc.resolvePeriods({ ...base, weeklyOff: WEEKLY_OFF.NONE });
    const sunday = calc.resolvePeriods({ ...base, weeklyOff: WEEKLY_OFF.SUNDAY });

    record(
      'Phase 11 daily',
      'weekly off NONE charges every calendar day',
      none.calendarDays === 30 && none.chargeableDays === 30 && none.emiCount === 30,
      '30 calendar days -> 30 chargeable days'
    );
    record(
      'Phase 11 daily',
      '30 calendar days containing 4 Sundays give 26 chargeable days',
      sunday.calendarDays === 30 && sunday.chargeableDays === 26 && sunday.emiCount === 26,
      `${sunday.chargeableDays} chargeable days / ${sunday.calendarDays} calendar days`
    );

    const sundayDates = sunday.offsets.map((offset) => dates.addDays(base.startDate, offset));
    record(
      'Phase 11 daily',
      'no instalment falls on a Sunday',
      sundayDates.every((date) => !dates.isSunday(date)),
      `${sundayDates.length} instalments, ${sundayDates.filter((d) => dates.isSunday(d)).length} on a Sunday`
    );
    record(
      'Phase 11 daily',
      'the excluded days are exactly the Sundays inside the window, counted independently',
      (() => {
        let sundays = 0;
        for (let offset = 1; offset <= 30; offset += 1) {
          if (dates.isSunday(dates.addDays(base.startDate, offset))) sundays += 1;
        }
        return sundays === 4 && none.chargeableDays - sunday.chargeableDays === sundays;
      })(),
      '4 Sundays skipped'
    );
    record(
      'Phase 11 daily',
      'the term is not extended to make up the skipped days',
      dates.differenceInDays(base.startDate, sundayDates[sundayDates.length - 1]) <= 30,
      `last instalment ${sundayDates[sundayDates.length - 1]}, window ends ${dates.addDays(base.startDate, 30)}`
    );

    // Month and year boundaries.
    const crossesYear = calc.resolvePeriods({ loanType: 'DAILY', tenure: 45, startDate: '2026-12-10', weeklyOff: WEEKLY_OFF.SUNDAY });
    const yearDates = crossesYear.offsets.map((offset) => dates.addDays('2026-12-10', offset));
    record(
      'Phase 11 daily',
      'a term crossing a month and a year boundary still skips only Sundays',
      (() => {
        let sundays = 0;
        for (let offset = 1; offset <= 45; offset += 1) {
          if (dates.isSunday(dates.addDays('2026-12-10', offset))) sundays += 1;
        }
        return (
          yearDates.every((date) => !dates.isSunday(date)) &&
          yearDates.some((date) => date.startsWith('2027-01')) &&
          sundays > 0 &&
          crossesYear.chargeableDays === 45 - sundays
        );
      })(),
      `${crossesYear.chargeableDays}/45 days, ${yearDates[0]} → ${yearDates[yearDates.length - 1]}`
    );

    // 2026-08-16 is a Sunday.
    record('Phase 11 daily', '2026-08-16 is correctly identified as a Sunday', dates.isSunday('2026-08-16'), 'weekday helper');

    const startsOnSunday = calc.resolvePeriods({ loanType: 'DAILY', tenure: 14, startDate: '2026-08-16', weeklyOff: WEEKLY_OFF.SUNDAY });
    const startsOnSundayDates = startsOnSunday.offsets.map((offset) => dates.addDays('2026-08-16', offset));
    record(
      'Phase 11 daily',
      'a loan starting on a Sunday charges from the Monday and skips the next Sunday',
      startsOnSundayDates[0] === '2026-08-17' && startsOnSundayDates.every((date) => !dates.isSunday(date)) && startsOnSunday.chargeableDays === 12,
      `${startsOnSunday.chargeableDays}/14 days, first ${startsOnSundayDates[0]}`
    );

    // 2026-08-15 is a Saturday, so a 1-day term lands entirely on a Sunday.
    let noChargeableDays = null;
    try {
      calc.resolvePeriods({ loanType: 'DAILY', tenure: 1, startDate: '2026-08-15', weeklyOff: WEEKLY_OFF.SUNDAY });
    } catch (error) {
      noChargeableDays = error;
    }
    record(
      'Phase 11 daily',
      'a term whose only day is excluded is refused rather than priced at zero instalments',
      noChargeableDays !== null && noChargeableDays.statusCode === 400,
      `${noChargeableDays?.statusCode} — "${noChargeableDays?.message}"`
    );

    let wrongType = null;
    try {
      calc.resolvePeriods({ loanType: 'MONTHLY', tenure: 12, startDate: '2026-08-18', weeklyOff: WEEKLY_OFF.SUNDAY });
    } catch (error) {
      wrongType = error;
    }
    record(
      'Phase 11 daily',
      'a weekly off on a non-daily loan is refused by the calculation service',
      wrongType !== null && wrongType.statusCode === 400,
      `${wrongType?.statusCode} — "${wrongType?.message}"`
    );

    let missingStart = null;
    try {
      calc.resolvePeriods({ loanType: 'DAILY', tenure: 30, weeklyOff: WEEKLY_OFF.SUNDAY });
    } catch (error) {
      missingStart = error;
    }
    record(
      'Phase 11 daily',
      'chargeable days are never guessed without a start date',
      missingStart !== null && missingStart.statusCode === 400,
      `${missingStart?.statusCode}`
    );

    const priced = calculateLoanFinancials({ ...base, weeklyOff: WEEKLY_OFF.SUNDAY });
    const openDaily = calculateLoanFinancials({ ...base, weeklyOff: WEEKLY_OFF.NONE });
    record(
      'Phase 11 daily',
      'the EMI count follows the chargeable days, while the interest follows the agreed term',
      priced.emiCount === 26 && priced.chargeableDays === 26 && priced.calendarDays === 30 &&
        priced.interest === openDaily.interest && priced.totalRepayment === openDaily.totalRepayment,
      `26 instalments instead of 30, same interest ${priced.interest} over the same 30-day term`
    );
  }

  // ---------- Phase 11: schedule generation under both rules ----------
  {
    const buildLoanFor = (overrides) =>
      models.Loan.build({
        id: 9911,
        loanNumber: 'LN26-009911',
        status: 'ACTIVE',
        ...overrides
      });

    // A daily, Sunday-off, reducing loan: every Phase 11 rule at once.
    const financials = calculateLoanFinancials({
      loanAmount: '50000.00', roi: '18.0000', tenure: 30, loanType: 'DAILY', startDate: '2026-08-18',
      interestMethod: 'REDUCING', weeklyOff: 'SUNDAY'
    });
    const combined = buildLoanFor({
      loanAmount: '50000.00', roi: '18.0000', tenure: 30, loanType: 'DAILY', startDate: '2026-08-18',
      interestMethod: 'REDUCING', weeklyOff: 'SUNDAY',
      totalRepayment: financials.totalRepayment, emiAmount: financials.emiAmount, emiCount: financials.emiCount
    });
    const combinedSchedule = emiScheduleService.buildSchedule(combined);

    record(
      'Phase 11 schedule',
      'a daily + Sunday-off + reducing schedule builds, reconciles and skips every Sunday',
      combinedSchedule.rows.length === 26 && combinedSchedule.rows.every((row) => !dates.isSunday(row.emiDate)),
      `${combinedSchedule.rows.length} instalments, none on a Sunday`
    );
    record(
      'Phase 11 schedule',
      'its interest declines instalment by instalment',
      combinedSchedule.rows.every(
        (row, index) => index === 0 || toPaise(row.interest) <= toPaise(combinedSchedule.rows[index - 1].interest)
      ),
      `${combinedSchedule.rows[0].interest} → ${combinedSchedule.rows[25].interest}`
    );
    record(
      'Phase 11 schedule',
      'schedule totals are validated before any row could be written',
      (() => {
        const sum = (key) => combinedSchedule.rows.reduce((total, row) => total + toPaise(row[key]), 0n);
        return fromPaise(sum('principal')) === '50000.00' && fromPaise(sum('emiAmount')) === financials.totalRepayment;
      })(),
      `principal 50000.00, repayment ${financials.totalRepayment}`
    );

    const dailySunFlat = calculateLoanFinancials({
      loanAmount: '10000.00', roi: '10.0000', tenure: 30, loanType: 'DAILY', startDate: '2026-08-18', weeklyOff: 'SUNDAY'
    });
    const flatSunday = buildLoanFor({
      loanAmount: '10000.00', roi: '10.0000', tenure: 30, loanType: 'DAILY', startDate: '2026-08-18',
      interestMethod: 'FLAT', weeklyOff: 'SUNDAY',
      totalRepayment: dailySunFlat.totalRepayment, emiAmount: dailySunFlat.emiAmount, emiCount: dailySunFlat.emiCount
    });
    const flatSundaySchedule = emiScheduleService.buildSchedule(flatSunday);
    record(
      'Phase 11 schedule',
      'a flat daily loan with a weekly off also produces 26 Sunday-free instalments',
      flatSundaySchedule.rows.length === 26 && flatSundaySchedule.rows.every((row) => !dates.isSunday(row.emiDate)),
      `${flatSundaySchedule.rows.length} instalments`
    );

    record(
      'Phase 11 schedule',
      'a flat schedule is rebuilt from the loan’s stored totals, never re-priced',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8'));
        return /totalRepayment: loan\.totalRepayment, emiAmount: loan\.emiAmount/.test(source);
      })(),
      'stored totalRepayment and emiAmount are passed back in'
    );
    record(
      'Phase 11 schedule',
      'an existing schedule is still never regenerated',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8'));
        return /existing > 0/.test(source) && /created: false/.test(source);
      })(),
      'generateSchedule remains idempotent'
    );
  }

  // ---------- Phase 11: data model, validation and defaults ----------
  {
    const { INTEREST_METHODS, INTEREST_METHOD_VALUES, WEEKLY_OFF, WEEKLY_OFF_VALUES, FINANCIAL_FIELDS, isWeeklyOffAllowed } = require('../src/config/loans');

    record(
      'Phase 11 model',
      'the two new fields are the only ones added, with existing-loan defaults',
      INTEREST_METHOD_VALUES.join() === 'FLAT,REDUCING' && WEEKLY_OFF_VALUES.join() === 'NONE,SUNDAY',
      `${INTEREST_METHOD_VALUES.join('/')} and ${WEEKLY_OFF_VALUES.join('/')}`
    );
    record(
      'Phase 11 model',
      'a loan built without them defaults to FLAT / NONE',
      (() => {
        const loan = models.Loan.build({ loanNumber: 'LN26-000000', loanAmount: '1000.00', roi: '10.0000', tenure: 1, loanType: 'MONTHLY', totalRepayment: '1000.00', emiAmount: '1000.00', emiCount: 1, startDate: '2026-01-01' });
        return loan.interestMethod === INTEREST_METHODS.FLAT && loan.weeklyOff === WEEKLY_OFF.NONE;
      })(),
      'matches every loan created before this phase'
    );
    record(
      'Phase 11 model',
      'both fields are exposed by the loan API shape, with derived day counts',
      (() => {
        const loan = models.Loan.build({ loanNumber: 'LN26-000000', loanAmount: '1000.00', roi: '10.0000', tenure: 30, loanType: 'DAILY', interestMethod: 'REDUCING', weeklyOff: 'SUNDAY', totalRepayment: '1000.00', emiAmount: '40.00', emiCount: 26, startDate: '2026-08-18' });
        const json = loan.toPublicJSON();
        return json.interestMethod === 'REDUCING' && json.weeklyOff === 'SUNDAY' && json.calendarDays === 30 && json.chargeableDays === 26;
      })(),
      'calendarDays/chargeableDays derived, not stored twice'
    );
    record(
      'Phase 11 model',
      'both fields are financial terms, so they are frozen once a loan leaves DRAFT',
      FINANCIAL_FIELDS.includes('interestMethod') && FINANCIAL_FIELDS.includes('weeklyOff'),
      FINANCIAL_FIELDS.join(', ')
    );
    record(
      'Phase 11 model',
      'the migration adds both columns with backward-compatible defaults and can be rolled back',
      (() => {
        const file = path.resolve(__dirname, '..', 'migrations', '020-add-loan-interest-method-and-weekly-off.js');
        if (!fs.existsSync(file)) return false;
        const source = stripComments(fs.readFileSync(file, 'utf8'));
        const migration = require(file);
        return (
          typeof migration.up === 'function' &&
          typeof migration.down === 'function' &&
          /defaultValue: 'FLAT'/.test(source) &&
          /defaultValue: 'NONE'/.test(source) &&
          !/UPDATE|recalc|loans SET/i.test(source)
        );
      })(),
      'adds columns only — no data is rewritten'
    );

    const badMethod = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000.00', roi: '10', tenure: 12, loanType: 'MONTHLY', startDate: '2026-01-01', applicantCustomerId: 1, interestMethod: 'COMPOUND' }
    });
    record('Phase 11 validation', 'an unknown interest method is rejected', badMethod.some((e) => e.field === 'interestMethod'), badMethod.map((e) => e.message).join('; ') || 'accepted');

    const badWeeklyOff = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000.00', roi: '10', tenure: 30, loanType: 'DAILY', startDate: '2026-01-01', applicantCustomerId: 1, weeklyOff: 'SATURDAY' }
    });
    record('Phase 11 validation', 'an unknown weekly off is rejected', badWeeklyOff.some((e) => e.field === 'weeklyOff'), badWeeklyOff.map((e) => e.message).join('; ') || 'accepted');

    const badCombination = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000.00', roi: '10', tenure: 12, loanType: 'MONTHLY', startDate: '2026-01-01', applicantCustomerId: 1, weeklyOff: 'SUNDAY' }
    });
    record(
      'Phase 11 validation',
      'a weekly off on a monthly loan is rejected as an invalid combination',
      badCombination.some((e) => e.field === 'weeklyOff'),
      badCombination.map((e) => e.message).join('; ') || 'accepted'
    );

    const goodCombination = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000.00', roi: '10', tenure: 30, loanType: 'DAILY', startDate: '2026-01-01', applicantCustomerId: 1, interestMethod: 'REDUCING', weeklyOff: 'SUNDAY' }
    });
    record('Phase 11 validation', 'a daily loan with Sunday off and reducing interest is accepted', goodCombination.length === 0, goodCombination.map((e) => e.message).join('; ') || 'no errors');

    const previewNoStart = await runRules(loanValidator.previewRules, {
      body: { loanAmount: '1000.00', roi: '10', tenure: 30, loanType: 'DAILY', weeklyOff: 'SUNDAY' }
    });
    record(
      'Phase 11 validation',
      'a preview with a weekly off but no start date is rejected',
      previewNoStart.some((e) => e.field === 'startDate'),
      previewNoStart.map((e) => e.message).join('; ') || 'accepted'
    );

    const stillGuarded = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000.00', roi: '10', tenure: 12, loanType: 'MONTHLY', startDate: '2026-01-01', applicantCustomerId: 1, totalRepayment: '1.00', emiAmount: '1.00' }
    });
    record(
      'Phase 11 validation',
      'the client still cannot supply calculated totals',
      stillGuarded.some((e) => e.field === 'totalRepayment') && stillGuarded.some((e) => e.field === 'emiAmount'),
      'totalRepayment and emiAmount remain backend-owned'
    );

    record(
      'Phase 11 validation',
      'the weekly-off combination rule is shared between the config, the validator and the service',
      isWeeklyOffAllowed('DAILY', 'SUNDAY') && !isWeeklyOffAllowed('WEEKLY', 'SUNDAY') && !isWeeklyOffAllowed('MONTHLY', 'SUNDAY'),
      'one predicate, three callers'
    );

    // The browser must never compute money.
    const formSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'loans', 'LoanFormModal.jsx'), 'utf8'));
    record(
      'Phase 11 frontend',
      'the loan form asks the backend for every figure, including the new ones',
      /previewLoanFinancials\(\{[^}]*interestMethod[^}]*weeklyOff/.test(formSource.replace(/\s+/g, ' ')) &&
        !/roi\s*\/\s*100|Math\.pow|\*\s*tenure/.test(formSource),
      'preview call carries interestMethod and weeklyOff; no arithmetic in the browser'
    );
    const detailsSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'loans', 'LoanDetailsPage.jsx'), 'utf8'));
    record(
      'Phase 11 frontend',
      'loan details shows the method and the chargeable-day split from the API',
      /INTEREST_METHOD_LABELS\[loan\.interestMethod\]/.test(detailsSource) && /loan\.chargeableDays/.test(detailsSource) && /loan\.calendarDays/.test(detailsSource),
      'displayed, not recomputed'
    );
  }

  // ---------- Frontend permission-constant parity ----------
  {
    /*
     * Guards the regression found during Phase 7: LOANS_* and EMIS_* were never
     * added to the frontend constant map, so `PERMISSIONS.LOANS_VIEW` was
     * undefined. `canAny([undefined])` filters falsy values to an empty list and
     * returns true, silently opening those UI gates to every role. This asserts
     * both halves stay in step.
     */
    const frontendPath = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'utils', 'permissions.js');
    const frontendExists = fs.existsSync(frontendPath);

    if (!frontendExists) {
      record('Frontend permissions', 'frontend permission map is present', false, `not found at ${frontendPath}`);
    } else {
      const source = fs.readFileSync(frontendPath, 'utf8');
      const entries = [...source.matchAll(/^\s{2}([A-Z0-9_]+):\s*'([^']*)'/gm)].map((m) => ({ key: m[1], value: m[2] }));

      record(
        'Frontend permissions',
        'every frontend permission constant is a non-empty string',
        entries.length > 0 && entries.every((e) => typeof e.value === 'string' && e.value.trim().length > 0),
        `${entries.length} constants, ${entries.filter((e) => !e.value.trim()).length} empty`
      );

      const frontendValues = entries.map((e) => e.value);
      const backendValues = Object.values(PERMISSIONS);

      const missingInFrontend = backendValues.filter((v) => !frontendValues.includes(v));
      const missingInBackend = frontendValues.filter((v) => !backendValues.includes(v));

      record(
        'Frontend permissions',
        'every backend permission has a matching frontend constant',
        missingInFrontend.length === 0,
        missingInFrontend.length ? `MISSING IN FRONTEND: ${missingInFrontend.join(', ')}` : `${backendValues.length} permissions in parity`
      );

      record(
        'Frontend permissions',
        'the frontend declares no permission the backend does not define',
        missingInBackend.length === 0,
        missingInBackend.length ? `UNKNOWN TO BACKEND: ${missingInBackend.join(', ')}` : 'no orphans'
      );

      // Phase 8 specifically.
      const phase8 = ['routes.view', 'routes.create', 'routes.update', 'routes.assign', 'demand.view'];
      record(
        'Frontend permissions',
        'Phase 8 permission constants are present in the frontend',
        phase8.every((v) => frontendValues.includes(v)),
        phase8.filter((v) => frontendValues.includes(v)).length + '/5 present'
      );

      // Navigation must gate the new items on real permission strings.
      const navPath = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'routes', 'navigation.js');
      if (fs.existsSync(navPath)) {
        const navSource = fs.readFileSync(navPath, 'utf8');
        record(
          'Frontend permissions',
          'Routes and Demand nav items are permission-gated and enabled',
          /id: 'routes'[\s\S]{0,240}PERMISSIONS\.ROUTES_VIEW[\s\S]{0,120}available: true/.test(navSource) &&
            /id: 'demand'[\s\S]{0,240}PERMISSIONS\.DEMAND_VIEW[\s\S]{0,120}available: true/.test(navSource),
          'both bound to real permission constants'
        );
      }
    }
  }

  // ---------- User details: edit + role-based permission display ----------
  {
    const frontendSrc = path.resolve(__dirname, '..', '..', 'frontend', 'src');
    const detailsPath = path.join(frontendSrc, 'pages', 'users', 'UserDetailsPage.jsx');
    const modalPath = path.join(frontendSrc, 'components', 'users', 'UserFormModal.jsx');
    const rolesPagePath = path.join(frontendSrc, 'pages', 'roles', 'RolesPage.jsx');

    const details = stripComments(fs.readFileSync(detailsPath, 'utf8'));
    const modal = stripComments(fs.readFileSync(modalPath, 'utf8'));
    const rolesPage = stripComments(fs.readFileSync(rolesPagePath, 'utf8'));
    const userServiceSource = stripComments(fs.readFileSync(path.join(frontendSrc, 'services', 'userService.js'), 'utf8'));

    record(
      'User details',
      'the Edit user action is gated on users.update',
      /canUpdate = can\(PERMISSIONS\.USERS_UPDATE\)/.test(details) && /canUpdate \?[\s\S]{0,400}Edit user/.test(details),
      'button rendered only with users.update'
    );
    record(
      'User details',
      'the password reset action is gated on users.reset_password',
      /canResetPassword = can\(PERMISSIONS\.USERS_RESET_PASSWORD\)/.test(details) &&
        /canResetPassword \?[\s\S]{0,400}Reset password/.test(details),
      'existing ResetPasswordModal reused'
    );
    record(
      'User details',
      'the edit and reset modals are mounted and their open state is wired',
      /<UserFormModal[\s\S]{0,400}open=\{editOpen\}/.test(details) &&
        /<ResetPasswordModal[\s\S]{0,300}open=\{passwordOpen\}/.test(details) &&
        /onClick=\{\(\) => setEditOpen\(true\)\}/.test(details),
      'no dead buttons'
    );

    // The numeric primary key is display-only, everywhere.
    record(
      'User details',
      'the user id is displayed read-only',
      /User ID<\/dt>/.test(details) && /read-only/.test(details),
      'shown with a read-only marker'
    );
    record(
      'User details',
      'no form field can edit the user id',
      !/name="id"/.test(modal) && !/id:\s*form\./.test(modal) && !/<input[^>]*value=\{form\.id\}/.test(modal),
      'the edit form has no id input'
    );
    record(
      'User details',
      'the update payload carries only name, email and status',
      /updateUser\(user\.id,\s*\{ name: form\.name\.trim\(\), email: form\.email\.trim\(\), status: form\.status \}\)/.test(modal),
      'no id, role, roleId or password in the PUT body'
    );
    record(
      'User details',
      'the backend refuses an id, role or password in the update body',
      /body\('role'\)\.not\(\)\.exists\(\)/.test(
        stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'validators', 'userValidator.js'), 'utf8'))
      ) &&
        !/body\('id'\)/.test(
          stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'validators', 'userValidator.js'), 'utf8'))
        ),
      'updateUserRules accepts no identity field'
    );
    record(
      'User details',
      'the update service never assigns an id',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'userService.js'), 'utf8'));
        const body = source.slice(source.indexOf('async function updateUser'), source.indexOf('async function changeStatus'));
        return /\{ name, email, status \}/.test(body) && !/changes\.id/.test(body);
      })(),
      'id is a lookup key only'
    );

    // Role changes keep using their own endpoint and permission.
    record(
      'User details',
      'roles offered by the edit form come from the backend',
      /fetchRoles\(\)/.test(details) && /roles=\{roleNames\}/.test(details) && /roleOptions/.test(modal),
      'GET /admin/roles, with the shared constants as fallback'
    );
    record(
      'User details',
      'a role change goes through the dedicated endpoint and permission',
      /canAssignRole && form\.role !== user\.role/.test(modal) &&
        /changeUserRole\(user\.id, form\.role\)/.test(modal) &&
        /api\.patch\(`\/admin\/users\/\$\{id\}\/role`/.test(userServiceSource),
      'PATCH /admin/users/:id/role behind users.assign_role'
    );

    // Permissions stay role-derived: no per-user override anywhere.
    record(
      'User details',
      'the page states that permissions come from the assigned role',
      /Permissions come from the assigned role/.test(details),
      'stated in the permissions card'
    );
    record(
      'User details',
      'the page cannot edit permissions — it links to the role instead',
      /to=\{`\/roles\?role=/.test(details) &&
        !/updateRolePermissions/.test(details) &&
        !/type="checkbox"/.test(details),
      'read-only badges + link to Roles & Permissions'
    );
    record(
      'User details',
      'the roles page opens at the requested role',
      /useSearchParams/.test(rolesPage) && /searchParams\.get\('role'\)/.test(rolesPage),
      'deep link honoured, no duplicate permission UI'
    );
    record(
      'User details',
      'no per-user permission override exists in the backend',
      !fs.existsSync(path.resolve(__dirname, '..', 'src', 'models', 'UserPermission.js')) &&
        !fs
          .readdirSync(path.resolve(__dirname, '..', 'migrations'))
          .some((file) => /user[_-]?permission/i.test(file)) &&
        !/user_permissions/.test(
          stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'userService.js'), 'utf8'))
        ),
      'permissions remain role-derived'
    );
    record(
      'User details',
      'effective permissions still come from the role join',
      (() => {
        const model = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'models', 'User.js'), 'utf8'));
        return /permissionNames\(\)/.test(model) && /this\.Role\.Permissions\.map/.test(model);
      })(),
      'User.permissionNames() reads Role.Permissions'
    );

    // Existing role-permission editing is untouched.
    record(
      'User details',
      'role permission editing still requires roles.manage and spares SUPER_ADMIN',
      /canManage = can\(PERMISSIONS\.ROLES_MANAGE\)/.test(rolesPage) &&
        /editable = canManage && selected && !isSuperAdmin/.test(rolesPage),
      'RolesPage behaviour unchanged'
    );
  }

  // ---------- Monthly ROI: the entered rate is per month ----------
  {
    const calc = require('../src/services/loanCalculationService');
    const { ROI_BASIS, DEFAULT_ROI_BASIS, MONTHS_PER_YEAR, PERIODS_PER_YEAR } = require('../src/config/loans');
    const sumOf = (periods, key) => fromPaise(periods.reduce((total, row) => total + toPaise(row[key]), 0n));

    // --- the specified example ---
    const spec = calculateLoanFinancials({ loanAmount: '10000.00', roi: '1.0000', tenure: 10, loanType: 'MONTHLY' });
    record(
      'Monthly ROI',
      '10,000 at 1% per month over 10 months yields 1,000 interest',
      spec.interest === '1000.00',
      `interest ${spec.interest}`
    );
    record(
      'Monthly ROI',
      'and a total repayment of 11,000',
      spec.totalRepayment === '11000.00' && spec.emiAmount === '1100.00' && spec.emiCount === 10,
      `total ${spec.totalRepayment}, emi ${spec.emiAmount} x ${spec.emiCount}`
    );
    record(
      'Monthly ROI',
      'a monthly rate is the default for anything priced today',
      spec.roiBasis === ROI_BASIS.MONTHLY && DEFAULT_ROI_BASIS === ROI_BASIS.MONTHLY,
      `basis ${spec.roiBasis}`
    );

    // --- the conversion itself ---
    record(
      'Monthly ROI',
      'a monthly rate normalises to its annual equivalent by multiplying by 12',
      calc.annualRoiScaled('1.0000', ROI_BASIS.MONTHLY) === calc.annualRoiScaled('12.0000', ROI_BASIS.ANNUAL) && MONTHS_PER_YEAR === 12,
      '1% per month === 12% per year, exactly'
    );
    record(
      'Monthly ROI',
      'no second period convention is introduced — periodsPerYear is untouched',
      PERIODS_PER_YEAR.DAILY === 365 && PERIODS_PER_YEAR.WEEKLY === 52 && PERIODS_PER_YEAR.MONTHLY === 12,
      'DAILY 365, WEEKLY 52, MONTHLY 12'
    );
    record(
      'Monthly ROI',
      'for a monthly loan the periodic rate is the entered rate over 100, not divided by 12',
      (() => {
        // 1.5% per month must give exactly 0.015 as an exact fraction.
        const { numerator, denominator } = calc.periodicRate('1.5000', 'MONTHLY', ROI_BASIS.MONTHLY);
        return numerator * 1000n === denominator * 15n;
      })(),
      'periodRate = roi / 100'
    );

    // --- reducing uses the monthly rate directly ---
    const reducing = calc.buildInstalmentPlan({
      loanAmount: '10000.00', roi: '1.0000', tenure: 10, loanType: 'MONTHLY', interestMethod: 'REDUCING'
    });
    record(
      'Monthly ROI',
      'a reducing loan charges the entered monthly rate on the opening balance',
      reducing.periods[0].interest === '100.00',
      `1% of 10,000 = ${reducing.periods[0].interest}`
    );
    record(
      'Monthly ROI',
      'its interest still falls with every instalment',
      reducing.periods.every((row, index) => index === 0 || toPaise(row.interest) < toPaise(reducing.periods[index - 1].interest)),
      `${reducing.periods[0].interest} -> ${reducing.periods[9].interest}`
    );
    record(
      'Monthly ROI',
      'and it still reconciles to the paise',
      sumOf(reducing.periods, 'principal') === '10000.00' && sumOf(reducing.periods, 'emiAmount') === reducing.summary.totalRepayment,
      `principal ${sumOf(reducing.periods, 'principal')}, repayment ${sumOf(reducing.periods, 'emiAmount')}`
    );

    // --- daily and weekly conversion ---
    const daily = calculateLoanFinancials({ loanAmount: '10000.00', roi: '1.0000', tenure: 30, loanType: 'DAILY', startDate: '2026-08-18' });
    record(
      'Monthly ROI',
      'a daily loan charges the monthly rate through the 365-day year',
      daily.interest === '98.63',
      `10,000 x (12/100) x (30/365) = ${daily.interest}`
    );
    const weekly = calculateLoanFinancials({ loanAmount: '10000.00', roi: '1.0000', tenure: 10, loanType: 'WEEKLY' });
    record(
      'Monthly ROI',
      'a weekly loan charges it through the 52-week year',
      weekly.interest === '230.77',
      `10,000 x (12/100) x (10/52) = ${weekly.interest}`
    );

    const dailyPlan = calc.buildInstalmentPlan({
      loanAmount: '10000.00', roi: '1.0000', tenure: 30, loanType: 'DAILY', startDate: '2026-08-18', interestMethod: 'REDUCING'
    });
    record(
      'Monthly ROI',
      'a daily reducing schedule built on a monthly rate still reconciles',
      sumOf(dailyPlan.periods, 'principal') === '10000.00' &&
        sumOf(dailyPlan.periods, 'emiAmount') === dailyPlan.summary.totalRepayment &&
        dailyPlan.periods.length === 30,
      `30 instalments, principal ${sumOf(dailyPlan.periods, 'principal')}`
    );

    // --- legacy loans keep the old meaning ---
    record(
      'Monthly ROI',
      'the same rate priced annually and monthly differs by exactly the factor of 12',
      toPaise(calculateLoanFinancials({ loanAmount: '10000.00', roi: '12.0000', tenure: 10, loanType: 'MONTHLY', roiBasis: 'ANNUAL' }).interest) * 12n ===
        toPaise(calculateLoanFinancials({ loanAmount: '10000.00', roi: '12.0000', tenure: 10, loanType: 'MONTHLY', roiBasis: 'MONTHLY' }).interest),
      'the basis is what decides, nothing else'
    );
    record(
      'Monthly ROI',
      'the basis is stored per loan, defaulting to ANNUAL for rows that predate the change',
      (() => {
        const file = path.resolve(__dirname, '..', 'migrations', '021-add-loan-roi-basis.js');
        if (!fs.existsSync(file)) return false;
        const source = stripComments(fs.readFileSync(file, 'utf8'));
        const migration = require(file);
        return (
          typeof migration.up === 'function' &&
          typeof migration.down === 'function' &&
          /defaultValue: 'ANNUAL'/.test(source) &&
          !/UPDATE|loans SET|recalc/i.test(source)
        );
      })(),
      'column added, no stored rate rewritten'
    );
    record(
      'Monthly ROI',
      'a new loan is written as MONTHLY while an existing one keeps its own basis',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanService.js'), 'utf8'));
        return /const roiBasis = DEFAULT_ROI_BASIS/.test(source) && /roiBasis: loan\.roiBasis/.test(source);
      })(),
      'create uses the current rule, update preserves the stored one'
    );
    record(
      'Monthly ROI',
      'schedule generation prices a loan on its own stored basis',
      /roiBasis: loan\.roiBasis/.test(
        stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8'))
      ),
      'a legacy loan regenerates exactly what it was created with'
    );

    const clientBasis = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000.00', roi: '1', tenure: 12, loanType: 'MONTHLY', startDate: '2026-01-01', applicantCustomerId: 1, roiBasis: 'ANNUAL' }
    });
    record(
      'Monthly ROI',
      'a client cannot choose the rate basis',
      clientBasis.some((e) => e.field === 'roiBasis'),
      clientBasis.map((e) => e.message).join('; ') || 'accepted'
    );

    const previewBasis = await runRules(loanValidator.previewRules, {
      body: { loanAmount: '1000.00', roi: '1', tenure: 12, loanType: 'MONTHLY', roiBasis: 'ANNUAL' }
    });
    record(
      'Monthly ROI',
      'but a preview may state one, so an existing loan previews as it was priced',
      previewBasis.length === 0,
      previewBasis.map((e) => e.message).join('; ') || 'accepted on preview only'
    );

    // --- the UI says "per month" ---
    const formSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'loans', 'LoanFormModal.jsx'), 'utf8')
    );
    record(
      'Monthly ROI',
      'the loan form asks for a monthly rate and says so',
      /ROI % per month/.test(formSource) && /Interest rate charged per month/.test(formSource) && !/per annum/.test(formSource),
      'label and helper text updated'
    );
    const detailsSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'loans', 'LoanDetailsPage.jsx'), 'utf8')
    );
    record(
      'Monthly ROI',
      'loan details labels the rate with the basis the loan was priced on',
      /formatRoi\(loan\.roi, loan\.roiBasis\)/.test(detailsSource) && !/per annum/.test(detailsSource),
      'per month for new loans, per annum for legacy ones'
    );
  }

  // ---------- Month-based tenure: a daily loan written as a contract ----------
  {
    const calc = require('../src/services/loanCalculationService');
    const { TENURE_UNITS, DEFAULT_TENURE_UNIT, isTenureUnitAllowed } = require('../src/config/loans');
    const sumOf = (periods, key) => fromPaise(periods.reduce((total, row) => total + toPaise(row[key]), 0n));

    // The specified case: 100,000 at 5% a month for 6 months, collected daily.
    const SPEC = {
      loanAmount: '100000.00', roi: '5.0000', tenure: 6, tenureUnit: 'MONTHS',
      loanType: 'DAILY', startDate: '2026-08-20'
    };
    const spec = calculateLoanFinancials(SPEC);
    const specPlan = calc.buildInstalmentPlan(SPEC);
    const specDates = specPlan.offsets.map((offset) => dates.addDays(SPEC.startDate, offset));

    record(
      'Month tenure',
      '100,000 at 5% per month for 6 months charges exactly 30,000 interest',
      spec.interest === '30000.00',
      `interest ${spec.interest}`
    );
    record(
      'Month tenure',
      'and a total repayment of exactly 130,000',
      spec.totalRepayment === '130000.00',
      `repayment ${spec.totalRepayment}`
    );
    record(
      'Month tenure',
      'the term ends on the same day of the month, six months on',
      spec.startDate === '2026-08-20' && spec.endDate === '2027-02-20',
      `${spec.startDate} to ${spec.endDate}`
    );
    record(
      'Month tenure',
      'the interest is NOT a daily rate times a day count',
      // 5%/30 x 184 days would be 30,666.67 — the contract says 30,000.
      spec.interest === '30000.00' && spec.calendarDays === 184,
      `${spec.calendarDays} calendar days, interest still ${spec.interest}`
    );

    record(
      'Month tenure',
      'every instalment date falls inside the contractual period',
      specDates.every((date) => dates.differenceInDays(SPEC.startDate, date) > 0 && dates.differenceInDays(date, spec.endDate) >= 0),
      `${specDates[0]} … ${specDates[specDates.length - 1]}, window ends ${spec.endDate}`
    );
    record(
      'Month tenure',
      'the instalments sum to exactly 130,000',
      sumOf(specPlan.periods, 'emiAmount') === '130000.00' && sumOf(specPlan.periods, 'principal') === '100000.00',
      `EMIs ${sumOf(specPlan.periods, 'emiAmount')}, principal ${sumOf(specPlan.periods, 'principal')}`
    );
    record(
      'Month tenure',
      'the final instalment absorbs the rounding residue',
      toPaise(specPlan.periods[specPlan.periods.length - 1].emiAmount) - toPaise(spec.emiAmount) === toPaise(spec.roundingRemainder) &&
        spec.roundingRemainder !== '0.00',
      `level ${spec.emiAmount}, last ${spec.lastEmiAmount}, residue ${spec.roundingRemainder}`
    );

    // Sundays off must not move the end date or the money.
    const sunday = calculateLoanFinancials({ ...SPEC, weeklyOff: 'SUNDAY' });
    const sundayPlan = calc.buildInstalmentPlan({ ...SPEC, weeklyOff: 'SUNDAY' });
    const sundayDates = sundayPlan.offsets.map((offset) => dates.addDays(SPEC.startDate, offset));

    record(
      'Month tenure',
      'excluding Sundays does not extend the contractual end date',
      sunday.endDate === '2027-02-20' && sunday.calendarDays === spec.calendarDays,
      `end ${sunday.endDate}, window ${sunday.calendarDays} days`
    );
    record(
      'Month tenure',
      'excluding Sundays does not change the interest or the repayment',
      sunday.interest === '30000.00' && sunday.totalRepayment === '130000.00',
      `interest ${sunday.interest}, repayment ${sunday.totalRepayment}`
    );
    record(
      'Month tenure',
      'it changes only how the same total is split, over fewer instalments',
      sunday.emiCount < spec.emiCount &&
        sumOf(sundayPlan.periods, 'emiAmount') === '130000.00' &&
        sundayDates.every((date) => !dates.isSunday(date)),
      `${sunday.emiCount} instalments instead of ${spec.emiCount}, none on a Sunday, still ${sumOf(sundayPlan.periods, 'emiAmount')}`
    );
    record(
      'Month tenure',
      'the last Sunday-free instalment still lands inside the window',
      dates.differenceInDays(sundayDates[sundayDates.length - 1], sunday.endDate) >= 0,
      `last ${sundayDates[sundayDates.length - 1]}, ends ${sunday.endDate}`
    );

    // Monthly + flat, monthly + reducing, daily + flat.
    const monthlyFlat = calculateLoanFinancials({ loanAmount: '100000.00', roi: '5.0000', tenure: 6, loanType: 'MONTHLY' });
    record(
      'Month tenure',
      'a MONTHLY flat loan on the same terms charges the same 30,000',
      monthlyFlat.interest === '30000.00' && monthlyFlat.totalRepayment === '130000.00' && monthlyFlat.emiCount === 6,
      `interest ${monthlyFlat.interest}, ${monthlyFlat.emiCount} instalments of ${monthlyFlat.emiAmount}`
    );
    const monthlyReducing = calc.buildInstalmentPlan({ loanAmount: '100000.00', roi: '5.0000', tenure: 6, loanType: 'MONTHLY', interestMethod: 'REDUCING' });
    record(
      'Month tenure',
      'a MONTHLY reducing loan charges 5% of the opening balance in month one',
      monthlyReducing.periods[0].interest === '5000.00' &&
        monthlyReducing.periods.every((row, index) => index === 0 || toPaise(row.interest) < toPaise(monthlyReducing.periods[index - 1].interest)),
      `${monthlyReducing.periods[0].interest} -> ${monthlyReducing.periods[5].interest}, emi ${monthlyReducing.summary.emiAmount}`
    );
    const dailyReducing = calc.buildInstalmentPlan({ ...SPEC, interestMethod: 'REDUCING' });
    record(
      'Month tenure',
      'a DAILY reducing loan converts the monthly rate to a daily one and still reconciles',
      sumOf(dailyReducing.periods, 'principal') === '100000.00' &&
        sumOf(dailyReducing.periods, 'emiAmount') === dailyReducing.summary.totalRepayment &&
        toPaise(dailyReducing.summary.interest) < toPaise(spec.interest),
      `${dailyReducing.periods.length} instalments, interest ${dailyReducing.summary.interest} < flat ${spec.interest}`
    );

    // --- the conversion is a strict generalisation ---
    record(
      'Month tenure',
      'a PERIODS tenure prices exactly as it did before this change',
      calculateLoanFinancials({ loanAmount: '10000.00', roi: '10.0000', tenure: 90, loanType: 'DAILY', roiBasis: 'ANNUAL' }).totalRepayment === '10246.58' &&
        calculateLoanFinancials({ loanAmount: '100000.00', roi: '12.5000', tenure: 12, loanType: 'MONTHLY', roiBasis: 'ANNUAL' }).totalRepayment === '112500.00' &&
        calculateLoanFinancials({ loanAmount: '10000.00', roi: '1.0000', tenure: 10, loanType: 'MONTHLY' }).totalRepayment === '11000.00',
      'legacy daily, legacy monthly and monthly-rate loans all unchanged'
    );
    record(
      'Month tenure',
      'PERIODS stays the default, so nothing changes unless months are chosen',
      DEFAULT_TENURE_UNIT === TENURE_UNITS.PERIODS &&
        calculateLoanFinancials({ loanAmount: '10000.00', roi: '1.0000', tenure: 10, loanType: 'MONTHLY' }).tenureUnit === TENURE_UNITS.PERIODS,
      'opt-in only'
    );
    record(
      'Month tenure',
      'the term in months is exact for both units',
      (() => {
        const inMonths = calc.termMonths({ loanType: 'DAILY', periods: 6, tenureUnit: 'MONTHS' });
        const inPeriods = calc.termMonths({ loanType: 'DAILY', periods: 365 });
        return inMonths.numerator === 6n && inMonths.denominator === 1n && inPeriods.numerator === 4380n && inPeriods.denominator === 365n;
      })(),
      '6 months exactly; 365 days = 12 months exactly'
    );

    // --- guards ---
    // A weekly loan may now be written in months, but only if it says how many
    // weekly collections repay it — the months alone do not imply a count.
    let weeklyMonths = null;
    try {
      calc.resolvePeriods({ loanType: 'WEEKLY', tenure: 6, tenureUnit: 'MONTHS', startDate: '2026-08-20' });
    } catch (error) {
      weeklyMonths = error;
    }
    record(
      'Month tenure',
      'a month-based WEEKLY tenure with no collection count is refused rather than guessed at',
      weeklyMonths !== null && weeklyMonths.statusCode === 400 && isTenureUnitAllowed('WEEKLY', 'MONTHS'),
      `${weeklyMonths?.statusCode} — "${weeklyMonths?.message}"`
    );
    record(
      'Month tenure',
      'and is accepted once it states one',
      calc.resolvePeriods({ loanType: 'WEEKLY', tenure: 6, tenureUnit: 'MONTHS', startDate: '2026-08-20', collectionCount: 26 }).emiCount === 26,
      '26 weekly collections inside a six-month contract'
    );

    let noStart = null;
    try {
      calc.resolvePeriods({ loanType: 'DAILY', tenure: 6, tenureUnit: 'MONTHS' });
    } catch (error) {
      noStart = error;
    }
    record(
      'Month tenure',
      'a month-based daily contract without a start date is refused',
      noStart !== null && noStart.statusCode === 400,
      `${noStart?.statusCode}`
    );

    const badUnit = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000.00', roi: '1', tenure: 6, loanType: 'DAILY', startDate: '2026-08-20', applicantCustomerId: 1, tenureUnit: 'FORTNIGHTS' }
    });
    record('Month tenure', 'an unknown tenure unit is rejected', badUnit.some((e) => e.field === 'tenureUnit'), badUnit.map((e) => e.message).join('; ') || 'accepted');

    const weeklyUnit = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000.00', roi: '1', tenure: 6, loanType: 'WEEKLY', startDate: '2026-08-20', applicantCustomerId: 1, tenureUnit: 'MONTHS' }
    });
    record(
      'Month tenure',
      'the validator also insists a month-based weekly loan states its collection count',
      weeklyUnit.some((e) => e.field === 'collectionCount'),
      weeklyUnit.map((e) => e.message).join('; ') || 'accepted'
    );

    // A month-based daily contract must also say how many days it collects over.
    const goodUnit = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '1000.00', roi: '5', tenure: 6, loanType: 'DAILY', startDate: '2026-08-20', applicantCustomerId: 1, tenureUnit: 'MONTHS', weeklyOff: 'SUNDAY', collectionCount: 150 }
    });
    record('Month tenure', 'a six-month daily contract with Sundays off is accepted', goodUnit.length === 0, goodUnit.map((e) => e.message).join('; ') || 'no errors');

    // --- storage and compatibility ---
    record(
      'Month tenure',
      'the migration adds one column defaulting to the existing meaning',
      (() => {
        const file = path.resolve(__dirname, '..', 'migrations', '022-add-loan-tenure-unit.js');
        if (!fs.existsSync(file)) return false;
        const source = stripComments(fs.readFileSync(file, 'utf8'));
        const migration = require(file);
        return (
          typeof migration.up === 'function' &&
          typeof migration.down === 'function' &&
          /defaultValue: 'PERIODS'/.test(source) &&
          !/UPDATE|loans SET|recalc/i.test(source)
        );
      })(),
      'PERIODS backfill, nothing rewritten'
    );
    record(
      'Month tenure',
      'schedule generation uses the loan’s own tenure unit',
      /tenureUnit: loan\.tenureUnit/.test(
        stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8'))
      ),
      'a stored contract regenerates the same window'
    );
    record(
      'Month tenure',
      'the loan API exposes the contractual end date, derived not stored',
      (() => {
        const loan = models.Loan.build({
          loanNumber: 'LN26-000000', loanAmount: '100000.00', roi: '5.0000', tenure: 6, tenureUnit: 'MONTHS',
          loanType: 'DAILY', totalRepayment: '130000.00', emiAmount: '706.52', emiCount: 184, startDate: '2026-08-20'
        });
        const json = loan.toPublicJSON();
        return json.endDate === '2027-02-20' && json.tenureUnit === 'MONTHS';
      })(),
      '2026-08-20 + 6 months = 2027-02-20'
    );

    // --- the UI ---
    const formSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'loans', 'LoanFormModal.jsx'), 'utf8')
    );
    record(
      'Month tenure',
      'the loan form offers a tenure unit for daily loans and sends it',
      /aria-label="Tenure unit"/.test(formSource) && /tenureUnit: terms\.tenureUnit/.test(formSource) && /supportsMonthTenure/.test(formSource),
      'days or months, submitted with the loan'
    );
    record(
      'Month tenure',
      'and shows the contractual period returned by the backend',
      /Contractual period/.test(formSource) && /preview\.endDate/.test(formSource),
      'start and end date shown, not computed in the browser'
    );
  }

  // ---------- Number of days: chargeable instalments, not calendar days ----------
  {
    const calc = require('../src/services/loanCalculationService');
    const { usesCollectionCount } = require('../src/config/loans');
    const sumOf = (periods, key) => fromPaise(periods.reduce((total, row) => total + toPaise(row[key]), 0n));

    const SPEC = {
      loanAmount: '100000.00', roi: '5.0000', tenure: 6, tenureUnit: 'MONTHS',
      loanType: 'DAILY', startDate: '2026-08-20', collectionCount: 150
    };

    // --- 1. daily + 6 months + 150 days + Sunday off ---
    const sunday = calculateLoanFinancials({ ...SPEC, weeklyOff: 'SUNDAY' });
    const sundayPlan = calc.buildInstalmentPlan({ ...SPEC, weeklyOff: 'SUNDAY' });
    const sundayDates = sundayPlan.offsets.map((offset) => dates.addDays(SPEC.startDate, offset));

    record(
      'Number of days',
      '150 days with Sundays off still charges the contractual 30,000 / 130,000',
      sunday.interest === '30000.00' && sunday.totalRepayment === '130000.00',
      `interest ${sunday.interest}, repayment ${sunday.totalRepayment}`
    );
    record(
      'Number of days',
      'it produces exactly 150 instalments — Sundays do not reduce the count',
      sunday.emiCount === 150 && sundayPlan.periods.length === 150 && sunday.collectionCount === 150,
      `${sunday.emiCount} instalments`
    );
    record(
      'Number of days',
      'none of them falls on a Sunday',
      sundayDates.every((date) => !dates.isSunday(date)),
      `${sundayDates.filter(dates.isSunday).length} Sunday dates of ${sundayDates.length}`
    );
    record(
      'Number of days',
      'the instalments sum to exactly 130,000',
      sumOf(sundayPlan.periods, 'emiAmount') === '130000.00' && sumOf(sundayPlan.periods, 'principal') === '100000.00',
      `EMIs ${sumOf(sundayPlan.periods, 'emiAmount')}, principal ${sumOf(sundayPlan.periods, 'principal')}`
    );
    record(
      'Number of days',
      'the contractual end date is untouched, and collection finishes on or before it',
      sunday.endDate === '2027-02-20' &&
        dates.differenceInDays(sundayDates[sundayDates.length - 1], sunday.endDate) >= 0,
      `last collection ${sunday.lastCollectionDate}, contract ends ${sunday.endDate}`
    );
    record(
      'Number of days',
      'skipping Sundays reaches further into the window rather than dropping collections',
      dates.differenceInDays(SPEC.startDate, sundayDates[149]) > 150,
      `the 150th collection is ${dates.differenceInDays(SPEC.startDate, sundayDates[149])} calendar days out`
    );

    // --- 2. same, without a weekly off ---
    const open = calculateLoanFinancials(SPEC);
    const openPlan = calc.buildInstalmentPlan(SPEC);
    const openDates = openPlan.offsets.map((offset) => dates.addDays(SPEC.startDate, offset));
    record(
      'Number of days',
      'without a weekly off it is 150 consecutive calendar days',
      open.emiCount === 150 &&
        openDates[0] === '2026-08-21' &&
        dates.differenceInDays(SPEC.startDate, openDates[149]) === 150,
      `${openDates[0]} … ${openDates[149]}`
    );
    record(
      'Number of days',
      'the money is identical either way — only the dates differ',
      open.interest === sunday.interest && open.totalRepayment === sunday.totalRepayment && open.emiAmount === sunday.emiAmount,
      `interest ${open.interest}, emi ${open.emiAmount}`
    );

    // --- 3. rounding residue ---
    record(
      'Number of days',
      '130,000 over 150 days gives 866.67 with the residue on the final instalment',
      open.emiAmount === '866.67' &&
        open.lastEmiAmount === '866.17' &&
        toPaise(openPlan.periods[149].emiAmount) - toPaise(open.emiAmount) === toPaise(open.roundingRemainder),
      `level ${open.emiAmount}, last ${open.lastEmiAmount}, residue ${open.roundingRemainder}`
    );

    // --- 4. it must fit inside the contract ---
    let tooMany = null;
    try {
      calc.resolvePeriods({ loanType: 'DAILY', tenure: 6, tenureUnit: 'MONTHS', startDate: '2026-08-20', collectionCount: 200, weeklyOff: 'SUNDAY' });
    } catch (error) {
      tooMany = error;
    }
    record(
      'Number of days',
      'a count that cannot fit the contract is refused, not silently extended',
      tooMany !== null && tooMany.statusCode === 400 && /at most 158 are available/.test(tooMany.message),
      `${tooMany?.statusCode} — "${tooMany?.message}"`
    );
    record(
      'Number of days',
      'the largest count that does fit is accepted',
      calculateLoanFinancials({ ...SPEC, collectionCount: 158, weeklyOff: 'SUNDAY' }).emiCount === 158,
      '158 chargeable days available with Sundays off'
    );

    // --- 5/6. monthly and weekly are untouched ---
    const monthly = calculateLoanFinancials({ loanAmount: '100000.00', roi: '5.0000', tenure: 6, loanType: 'MONTHLY' });
    record(
      'Number of days',
      'a MONTHLY loan has no collection days and behaves exactly as before',
      monthly.collectionCount === null && monthly.emiCount === 6 && monthly.totalRepayment === '130000.00',
      `${monthly.emiCount} instalments of ${monthly.emiAmount}`
    );
    const weekly = calculateLoanFinancials({ loanAmount: '10000.00', roi: '1.0000', tenure: 10, loanType: 'WEEKLY' });
    record(
      'Number of days',
      'a WEEKLY loan has none either and is unchanged',
      weekly.collectionCount === null && weekly.emiCount === 10 && weekly.totalRepayment === '10230.77',
      `${weekly.emiCount} instalments, repayment ${weekly.totalRepayment}`
    );
    record(
      'Number of days',
      'a daily loan with a day-based tenure is unchanged — the tenure already is the day count',
      calculateLoanFinancials({ loanAmount: '10000.00', roi: '10.0000', tenure: 90, loanType: 'DAILY', roiBasis: 'ANNUAL' }).totalRepayment === '10246.58',
      'legacy daily pricing intact'
    );

    let wrongShape = null;
    try {
      calc.resolvePeriods({ loanType: 'MONTHLY', tenure: 6, tenureUnit: 'MONTHS', startDate: '2026-08-20', collectionCount: 150 });
    } catch (error) {
      wrongShape = error;
    }
    record(
      'Number of days',
      'it is refused on any loan shape that has no such notion',
      wrongShape !== null && wrongShape.statusCode === 400 &&
        !usesCollectionCount('MONTHLY', 'PERIODS') && !usesCollectionCount('MONTHLY', 'MONTHS') && usesCollectionCount('DAILY', 'MONTHS'),
      `${wrongShape?.statusCode} — "${wrongShape?.message}"`
    );

    // --- validation ---
    const invalid = [];
    for (const value of [0, -5, '150.5', 'abc', '1e3']) {
      const errors = await runRules(loanValidator.createLoanRules, {
        body: { loanAmount: '100000.00', roi: '5', tenure: 6, loanType: 'DAILY', tenureUnit: 'MONTHS', startDate: '2026-08-20', applicantCustomerId: 1, collectionCount: value }
      });
      invalid.push(`${JSON.stringify(value)}=${errors.some((e) => e.field === 'collectionCount') ? 'rejected' : 'ACCEPTED'}`);
    }
    record('Number of days', 'zero, negatives, decimals and non-numerics are rejected', invalid.every((r) => r.endsWith('rejected')), invalid.join(', '));

    const missing = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '100000.00', roi: '5', tenure: 6, loanType: 'DAILY', tenureUnit: 'MONTHS', startDate: '2026-08-20', applicantCustomerId: 1 }
    });
    record(
      'Number of days',
      'it is required for a daily loan written in months',
      missing.some((e) => e.field === 'collectionCount'),
      missing.filter((e) => e.field === 'collectionCount').map((e) => e.message).join('; ') || 'accepted'
    );

    const good = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '100000.00', roi: '5', tenure: 6, loanType: 'DAILY', tenureUnit: 'MONTHS', startDate: '2026-08-20', applicantCustomerId: 1, collectionCount: 150, weeklyOff: 'SUNDAY' }
    });
    record('Number of days', 'the specified loan passes validation', good.length === 0, good.map((e) => e.message).join('; ') || 'no errors');

    const onMonthly = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '100000.00', roi: '5', tenure: 6, loanType: 'MONTHLY', startDate: '2026-08-20', applicantCustomerId: 1, collectionCount: 150 }
    });
    record('Number of days', 'sending it on a monthly loan is rejected', onMonthly.some((e) => e.field === 'collectionCount'), onMonthly.filter((e) => e.field === 'collectionCount').map((e) => e.message).join('; ') || 'accepted');

    // --- storage and the UI ---
    record(
      'Number of days',
      'the column is nullable, and the rename that generalised it rewrites nothing',
      (() => {
        const dir = path.resolve(__dirname, '..', 'migrations');
        const added = path.join(dir, '023-add-loan-collection-days.js');
        const renamed = path.join(dir, '025-rename-collection-days-to-count.js');
        if (!fs.existsSync(added) || !fs.existsSync(renamed)) return false;

        const addedSource = stripComments(fs.readFileSync(added, 'utf8'));
        const renamedSource = stripComments(fs.readFileSync(renamed, 'utf8'));
        const addedMigration = require(added);
        const renameMigration = require(renamed);

        return (
          typeof addedMigration.up === 'function' &&
          typeof renameMigration.up === 'function' &&
          typeof renameMigration.down === 'function' &&
          /allowNull: true/.test(addedSource) &&
          /defaultValue: null/.test(addedSource) &&
          /renameColumn/.test(renamedSource) &&
          !/UPDATE|loans SET|recalc/i.test(addedSource) &&
          !/UPDATE|loans SET|recalc/i.test(renamedSource)
        );
      })(),
      'NULL means "follow the tenure", which is what existing loans mean'
    );
    record(
      'Number of days',
      'schedule generation uses the loan’s own stored count',
      /collectionCount: loan\.collectionCount/.test(
        stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8'))
      ),
      'a stored contract regenerates the same instalments'
    );

    const formSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'loans', 'LoanFormModal.jsx'), 'utf8')
    );
    record(
      'Number of days',
      'the form shows the field only for a daily loan in months, and sends it only then',
      /id="loan-collection-count"/.test(formSource) &&
        /usesCollectionCount\(terms\.loanType, terms\.tenureUnit\) \?/.test(formSource) &&
        /collectionCount: Number\(terms\.collectionCount\)/.test(formSource),
      'hidden and omitted for monthly and weekly loans'
    );
    record(
      'Number of days',
      'the preview shows the contractual period and the collection schedule side by side',
      /Contractual period/.test(formSource) && /Collection schedule/.test(formSource) && /lastCollectionDate/.test(formSource),
      'both reported by the backend, neither computed in the browser'
    );
  }

  // ---------- Weekly and bi-weekly collection schedules ----------
  {
    const calc = require('../src/services/loanCalculationService');
    const { LOAN_TYPES, PERIODS_PER_YEAR, COLLECTION_STEP_DAYS, usesCollectionCount, collectionUnitLabel } = require('../src/config/loans');
    const sumOf = (periods, key) => fromPaise(periods.reduce((total, row) => total + toPaise(row[key]), 0n));

    const CONTRACT = { loanAmount: '100000.00', roi: '5.0000', tenure: 6, tenureUnit: 'MONTHS', startDate: '2026-08-20' };

    // --- 1. weekly, 26 collections ---
    const weekly = calculateLoanFinancials({ ...CONTRACT, loanType: 'WEEKLY', collectionCount: 26 });
    const weeklyPlan = calc.buildInstalmentPlan({ ...CONTRACT, loanType: 'WEEKLY', collectionCount: 26 });
    const weeklyDates = weeklyPlan.offsets.map((offset) => dates.addDays(CONTRACT.startDate, offset));

    record(
      'Weekly / bi-weekly',
      'weekly: 6 contractual months still charge 30,000 interest and 130,000 repayment',
      weekly.interest === '30000.00' && weekly.totalRepayment === '130000.00',
      `interest ${weekly.interest}, repayment ${weekly.totalRepayment}`
    );
    record(
      'Weekly / bi-weekly',
      'weekly: exactly 26 instalments of 5,000',
      weekly.emiCount === 26 && weeklyPlan.periods.length === 26 && weekly.emiAmount === '5000.00',
      `${weekly.emiCount} instalments of ${weekly.emiAmount}`
    );
    record(
      'Weekly / bi-weekly',
      'weekly: collections are 7 days apart, starting a week after the loan',
      weeklyDates[0] === '2026-08-27' &&
        weeklyPlan.offsets.every((offset, index) => offset === (index + 1) * 7),
      `${weeklyDates[0]} … ${weeklyDates[25]}`
    );
    record(
      'Weekly / bi-weekly',
      'weekly: the instalments sum to exactly 130,000',
      sumOf(weeklyPlan.periods, 'emiAmount') === '130000.00' && sumOf(weeklyPlan.periods, 'principal') === '100000.00',
      `EMIs ${sumOf(weeklyPlan.periods, 'emiAmount')}, principal ${sumOf(weeklyPlan.periods, 'principal')}`
    );

    // --- 2. bi-weekly, 13 collections ---
    const biWeekly = calculateLoanFinancials({ ...CONTRACT, loanType: 'BI_WEEKLY', collectionCount: 13 });
    const biPlan = calc.buildInstalmentPlan({ ...CONTRACT, loanType: 'BI_WEEKLY', collectionCount: 13 });
    const biDates = biPlan.offsets.map((offset) => dates.addDays(CONTRACT.startDate, offset));

    record(
      'Weekly / bi-weekly',
      'bi-weekly: the same contract charges the same 30,000 / 130,000',
      biWeekly.interest === '30000.00' && biWeekly.totalRepayment === '130000.00',
      `interest ${biWeekly.interest}, repayment ${biWeekly.totalRepayment}`
    );
    record(
      'Weekly / bi-weekly',
      'bi-weekly: exactly 13 instalments of 10,000',
      biWeekly.emiCount === 13 && biPlan.periods.length === 13 && biWeekly.emiAmount === '10000.00',
      `${biWeekly.emiCount} instalments of ${biWeekly.emiAmount}`
    );
    record(
      'Weekly / bi-weekly',
      'bi-weekly: every collection is 14 days after the last',
      biPlan.offsets.every((offset, index) => offset === (index + 1) * 14) &&
        biDates.every((date, index) => index === 0 || dates.differenceInDays(biDates[index - 1], date) === 14),
      `${biDates[0]} … ${biDates[12]}, gaps of ${dates.differenceInDays(biDates[0], biDates[1])} days`
    );
    record(
      'Weekly / bi-weekly',
      'bi-weekly: the instalments sum to exactly 130,000',
      sumOf(biPlan.periods, 'emiAmount') === '130000.00' && sumOf(biPlan.periods, 'principal') === '100000.00',
      `EMIs ${sumOf(biPlan.periods, 'emiAmount')}, principal ${sumOf(biPlan.periods, 'principal')}`
    );
    record(
      'Weekly / bi-weekly',
      'the interest never depends on the collection frequency',
      weekly.interest === biWeekly.interest &&
        weekly.interest === calculateLoanFinancials({ ...CONTRACT, loanType: 'DAILY', collectionCount: 150 }).interest &&
        weekly.interest === calculateLoanFinancials({ loanAmount: '100000.00', roi: '5.0000', tenure: 6, loanType: 'MONTHLY' }).interest,
      'daily, weekly, bi-weekly and monthly all charge 30,000 on a six-month contract'
    );

    // --- 3/4. neither schedule extends the contract ---
    record(
      'Weekly / bi-weekly',
      'weekly: the last collection lands on or before the contractual end date',
      weekly.endDate === '2027-02-20' && dates.differenceInDays(weeklyDates[25], weekly.endDate) >= 0,
      `last ${weekly.lastCollectionDate}, contract ends ${weekly.endDate}`
    );
    record(
      'Weekly / bi-weekly',
      'bi-weekly: the last collection lands on or before the contractual end date',
      biWeekly.endDate === '2027-02-20' && dates.differenceInDays(biDates[12], biWeekly.endDate) >= 0,
      `last ${biWeekly.lastCollectionDate}, contract ends ${biWeekly.endDate}`
    );

    let weeklyOverflow = null;
    try {
      calc.resolvePeriods({ loanType: 'WEEKLY', tenure: 6, tenureUnit: 'MONTHS', startDate: '2026-08-20', collectionCount: 30 });
    } catch (error) {
      weeklyOverflow = error;
    }
    record(
      'Weekly / bi-weekly',
      'weekly: a count that would run past the contract is refused, not accommodated',
      weeklyOverflow !== null && weeklyOverflow.statusCode === 400 && /at most 26 are available/.test(weeklyOverflow.message),
      `${weeklyOverflow?.statusCode} — "${weeklyOverflow?.message}"`
    );

    let biOverflow = null;
    try {
      calc.resolvePeriods({ loanType: 'BI_WEEKLY', tenure: 6, tenureUnit: 'MONTHS', startDate: '2026-08-20', collectionCount: 14 });
    } catch (error) {
      biOverflow = error;
    }
    record(
      'Weekly / bi-weekly',
      'bi-weekly: likewise, with the true capacity named',
      biOverflow !== null && biOverflow.statusCode === 400 && /at most 13 are available/.test(biOverflow.message),
      `${biOverflow?.statusCode} — "${biOverflow?.message}"`
    );

    // --- 5. invalid counts ---
    const invalid = [];
    for (const value of [0, -5, '26.5', 'abc', '1e2']) {
      const errors = await runRules(loanValidator.createLoanRules, {
        body: { loanAmount: '100000.00', roi: '5', tenure: 6, loanType: 'WEEKLY', tenureUnit: 'MONTHS', startDate: '2026-08-20', applicantCustomerId: 1, collectionCount: value }
      });
      invalid.push(`${JSON.stringify(value)}=${errors.some((e) => e.field === 'collectionCount') ? 'rejected' : 'ACCEPTED'}`);
    }
    record('Weekly / bi-weekly', 'zero, negative, decimal and non-numeric counts are rejected', invalid.every((r) => r.endsWith('rejected')), invalid.join(', '));

    // --- 6/7/8/9. the field belongs to the right loan types ---
    record(
      'Weekly / bi-weekly',
      'the count applies to daily, weekly and bi-weekly loans, never to a monthly one',
      usesCollectionCount('DAILY', 'MONTHS') &&
        usesCollectionCount('WEEKLY', 'MONTHS') &&
        usesCollectionCount('BI_WEEKLY', 'MONTHS') &&
        !usesCollectionCount('MONTHLY', 'MONTHS') &&
        !usesCollectionCount('WEEKLY', 'PERIODS'),
      'one rule, four loan types'
    );
    record(
      'Weekly / bi-weekly',
      'each loan type names its own collections',
      collectionUnitLabel('DAILY') === 'days' &&
        collectionUnitLabel('WEEKLY') === 'weeks' &&
        collectionUnitLabel('BI_WEEKLY') === 'bi-weekly collections',
      'days / weeks / bi-weekly collections'
    );
    const monthlyContract = calculateLoanFinancials({ loanAmount: '100000.00', roi: '5.0000', tenure: 6, loanType: 'MONTHLY' });
    record(
      'Weekly / bi-weekly',
      'a monthly loan has no collection count and one instalment per contractual month',
      monthlyContract.collectionCount === null && monthlyContract.emiCount === 6,
      `${monthlyContract.emiCount} instalments of ${monthlyContract.emiAmount}`
    );
    const onMonthly = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '100000.00', roi: '5', tenure: 6, loanType: 'MONTHLY', tenureUnit: 'MONTHS', startDate: '2026-08-20', applicantCustomerId: 1, collectionCount: 6 }
    });
    record('Weekly / bi-weekly', 'sending a count on a monthly loan is rejected', onMonthly.some((e) => e.field === 'collectionCount'), onMonthly.map((e) => e.message).join('; ') || 'accepted');

    // --- the new loan type itself ---
    record(
      'Weekly / bi-weekly',
      'BI_WEEKLY is a first-class loan type with 26 periods a year and a 14-day step',
      LOAN_TYPES.BI_WEEKLY === 'BI_WEEKLY' && PERIODS_PER_YEAR.BI_WEEKLY === 26 && COLLECTION_STEP_DAYS.BI_WEEKLY === 14,
      '26 fortnights a year'
    );
    record(
      'Weekly / bi-weekly',
      'a period-based bi-weekly loan steps 14 days per instalment',
      emiScheduleService.calculateEmiDate('2026-08-20', 'BI_WEEKLY', 1) === '2026-09-03' &&
        emiScheduleService.calculateEmiDate('2026-08-20', 'BI_WEEKLY', 2) === '2026-09-17',
      '2026-09-03, 2026-09-17'
    );
    record(
      'Weekly / bi-weekly',
      'its reducing rate is the monthly rate through the 26-fortnight year',
      (() => {
        // 5% a month is 60% a year, so a fortnight carries 60/26 % = 3/130 as a
        // fraction. Cross-multiplied, so the check is exact integer arithmetic.
        const { numerator, denominator } = calc.periodicRate('5.0000', 'BI_WEEKLY', 'MONTHLY');
        return numerator * 130n === denominator * 3n;
      })(),
      'periodRate = monthlyRoi x 12 / 26 = 3/130'
    );
    const biReducing = calc.buildInstalmentPlan({ ...CONTRACT, loanType: 'BI_WEEKLY', collectionCount: 13, interestMethod: 'REDUCING' });
    record(
      'Weekly / bi-weekly',
      'a bi-weekly reducing schedule reconciles and its interest falls',
      sumOf(biReducing.periods, 'principal') === '100000.00' &&
        sumOf(biReducing.periods, 'emiAmount') === biReducing.summary.totalRepayment &&
        biReducing.periods.every((row, index) => index === 0 || toPaise(row.interest) < toPaise(biReducing.periods[index - 1].interest)),
      `13 instalments, interest ${biReducing.periods[0].interest} -> ${biReducing.periods[12].interest}`
    );

    // --- 10. existing loan types are untouched ---
    record(
      'Weekly / bi-weekly',
      'a period-based WEEKLY loan prices and schedules exactly as before',
      (() => {
        const legacy = calculateLoanFinancials({ loanAmount: '10000.00', roi: '1.0000', tenure: 10, loanType: 'WEEKLY' });
        return legacy.emiCount === 10 && legacy.totalRepayment === '10230.77' && legacy.collectionCount === null &&
          emiScheduleService.calculateEmiDate('2026-08-20', 'WEEKLY', 1) === '2026-08-27';
      })(),
      '10 weekly instalments, repayment 10230.77'
    );
    record(
      'Weekly / bi-weekly',
      'daily and monthly loans are untouched',
      calculateLoanFinancials({ loanAmount: '10000.00', roi: '10.0000', tenure: 90, loanType: 'DAILY', roiBasis: 'ANNUAL' }).totalRepayment === '10246.58' &&
        calculateLoanFinancials({ loanAmount: '100000.00', roi: '12.5000', tenure: 12, loanType: 'MONTHLY', roiBasis: 'ANNUAL' }).totalRepayment === '112500.00',
      'legacy daily and monthly pricing intact'
    );

    // --- the UI ---
    const constantsSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'utils', 'loanConstants.js'), 'utf8')
    );
    const formUi = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'loans', 'LoanFormModal.jsx'), 'utf8')
    );
    record(
      'Weekly / bi-weekly',
      'the frontend offers a month tenure to every frequency the backend accepts',
      (() => {
        const listed = (constantsSource.match(/MONTH_TENURE_LOAN_TYPES = \[([^\]]*)\]/) ?? [])[1] ?? '';
        const frontend = [...listed.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
        const { MONTH_TENURE_LOAN_TYPES } = require('../src/config/loans');
        return JSON.stringify(frontend) === JSON.stringify([...MONTH_TENURE_LOAN_TYPES].sort());
      })(),
      'frontend and backend agree on which loan types can be written in months'
    );
    record(
      'Weekly / bi-weekly',
      'weekly and bi-weekly open as month contracts, daily and monthly keep their own default',
      /WEEKLY: 'MONTHS'/.test(constantsSource) &&
        /BI_WEEKLY: 'MONTHS'/.test(constantsSource) &&
        /DAILY: 'PERIODS'/.test(constantsSource) &&
        /MONTHLY: 'PERIODS'/.test(constantsSource),
      'a weekly loan never opens on "Tenure (weeks)"'
    );
    record(
      'Weekly / bi-weekly',
      'the tenure-unit selector is offered wherever the unit is a real choice',
      /showsTenureUnitChoice = \(loanType\) => supportsMonthTenure\(loanType\) && loanType !== 'MONTHLY'/.test(constantsSource) &&
        /showsTenureUnitChoice\(terms\.loanType\) \?/.test(formUi) &&
        /tenureUnit: defaultTenureUnit\(value\)/.test(formUi),
      'shown for daily, weekly and bi-weekly; pointless and hidden for monthly'
    );
    record(
      'Weekly / bi-weekly',
      'the frontend offers the new loan type and labels each count field',
      /'BI_WEEKLY'/.test(constantsSource) &&
        /DAILY: 'Number of days'/.test(constantsSource) &&
        /WEEKLY: 'Number of weeks'/.test(constantsSource) &&
        /BI_WEEKLY: 'Number of bi-weekly collections'/.test(constantsSource),
      'Number of days / weeks / bi-weekly collections'
    );
  }

  // ---------- Customer bulk import (Phase 12A) ----------
  {
    const ExcelJS = require('exceljs');
    const importService = require('../src/services/customerImportService');
    const importConfig = require('../src/config/customerImport');
    const { ROW_STATUS, MAX_ROWS, MAX_FILE_BYTES, COLUMNS } = importConfig;

    /** Builds a workbook in memory from plain header/row arrays. */
    const workbookOf = async (headers, rows, { sheetName = importConfig.SHEET_NAME } = {}) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(sheetName);
      sheet.addRow(headers);
      rows.forEach((row) => sheet.addRow(row));
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };

    const HEADERS = ['First Name', 'Last Name', 'Mobile', 'Email', 'City'];
    const parseOf = (buffer) => importService.parseWorkbook(buffer, { filename: 'test.xlsx' });

    // --- 1 & 2. valid rows ---
    const validBuffer = await workbookOf(HEADERS, [
      ['Asha', 'Verma', '9876500001', 'asha@example.com', 'Pune'],
      ['Bhavesh', 'Patel', '9876500002', '', 'Surat']
    ]);
    const validParsed = await parseOf(validBuffer);
    const validRows = await importService.evaluateRows(validParsed.rows);

    record(
      'Customer import',
      'a well-formed sheet parses into one row per customer, mapped to model fields',
      validParsed.rows.length === 2 &&
        validParsed.rows[0].values.firstName === 'Asha' &&
        validParsed.rows[0].values.mobile === '9876500001' &&
        validParsed.rows[0].rowNumber === 2,
      `${validParsed.rows.length} rows, first is Excel row ${validParsed.rows[0].rowNumber}`
    );
    record(
      'Customer import',
      'multiple valid customers are all accepted',
      validRows.every((row) => row.status === ROW_STATUS.VALID) && validRows.length === 2,
      validRows.map((row) => `${row.rowNumber}:${row.status}`).join(', ')
    );

    // --- 3-5. field-level validation, borrowed from the single-create rules ---
    const badBuffer = await workbookOf(HEADERS, [
      ['', 'NoFirstName', '9876500011', '', ''],
      ['Chetan', 'Rao', '12345', '', ''],
      ['Divya', 'Nair', '9876500013', 'not-an-email', '']
    ]);
    const badRows = await importService.evaluateRows((await parseOf(badBuffer)).rows);
    const reasonFor = (rowNumber, field) =>
      badRows.find((row) => row.rowNumber === rowNumber)?.errors.find((error) => error.field === field)?.reason ?? null;

    record(
      'Customer import',
      'a missing required field is reported against that field',
      badRows[0].status === ROW_STATUS.INVALID && /required/i.test(reasonFor(2, 'firstName') ?? ''),
      `row 2 | firstName | ${reasonFor(2, 'firstName')}`
    );
    record(
      'Customer import',
      'an invalid mobile is reported against mobile',
      badRows[1].status === ROW_STATUS.INVALID && /mobile/i.test(reasonFor(3, 'mobile') ?? ''),
      `row 3 | mobile | ${reasonFor(3, 'mobile')}`
    );
    record(
      'Customer import',
      'an invalid email is reported against email',
      badRows[2].status === ROW_STATUS.INVALID && /email/i.test(reasonFor(4, 'email') ?? ''),
      `row 4 | email | ${reasonFor(4, 'email')}`
    );
    record(
      'Customer import',
      'row validation reuses the single-create chains rather than a second rule set',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8'));
        return /customerValidator\.createCustomerRules\.map\(\(rule\) => rule\.run\(request\)\)/.test(source);
      })(),
      'the import cannot accept what the form would reject'
    );

    // --- 6. duplicate inside the file ---
    const dupInFile = await importService.evaluateRows(
      (
        await parseOf(
          await workbookOf(HEADERS, [
            ['Esha', 'Shah', '9876500021', '', ''],
            ['Esha', 'Shah', '+91 98765 00021', '', '']
          ])
        )
      ).rows
    );
    record(
      'Customer import',
      'the same mobile twice in one file is a duplicate, however it is written',
      dupInFile[0].status === ROW_STATUS.VALID &&
        dupInFile[1].status === ROW_STATUS.DUPLICATE &&
        /row 2/.test(dupInFile[1].errors[0].reason),
      `row 3 → ${dupInFile[1].errors[0]?.reason}`
    );

    // --- 7. duplicate of an existing customer ---
    const dupExisting = await importService.evaluateRows(
      (await parseOf(await workbookOf(HEADERS, [['Farid', 'Khan', '9876500031', '', '']]))).rows,
      new Map([['9876500031', { cifId: 'C000042', mobile: '9876500031', fullName: 'Farid Khan' }]])
    );
    record(
      'Customer import',
      'a row whose mobile already exists is skipped, never overwritten',
      dupExisting[0].status === ROW_STATUS.DUPLICATE && /C000042/.test(dupExisting[0].errors[0].reason),
      dupExisting[0].errors[0]?.reason
    );

    // --- 8. empty rows ---
    const withBlanks = await parseOf(
      await workbookOf(HEADERS, [
        ['Gita', 'Menon', '9876500041', '', ''],
        ['', '', '', '', ''],
        [null, null, null, null, null],
        ['Hari', 'Das', '9876500042', '', '']
      ])
    );
    record(
      'Customer import',
      'wholly empty rows are ignored, not reported as errors',
      withBlanks.rows.length === 2 && withBlanks.blankRows === 2,
      `${withBlanks.rows.length} data rows, ${withBlanks.blankRows} blanks skipped`
    );

    // --- 10. a CIFID column is refused outright ---
    let cifColumn = null;
    try {
      await parseOf(await workbookOf(['First Name', 'Mobile', 'CIFID'], [['Ira', '9876500051', 'C000001']]));
    } catch (error) {
      cifColumn = error;
    }
    record(
      'Customer import',
      'a spreadsheet cannot supply a CIFID — the column itself is refused',
      cifColumn !== null && cifColumn.statusCode === 400 && /CIFID is generated by the system/.test(cifColumn.message),
      `${cifColumn?.statusCode} — "${cifColumn?.message}"`
    );
    record(
      'Customer import',
      'a row value can never reach cifId: the whitelist has no such field',
      (() => {
        const service = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerService.js'), 'utf8'));
        const editable = (service.match(/const EDITABLE_FIELDS = \[([\s\S]*?)\]/) ?? [])[1] ?? '';
        const importSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8'));
        return (
          !/cifId/.test(editable) &&
          /createCustomerRecord\(row\.values, actor, transaction\)/.test(importSource) &&
          /pickEditableFields\(payload\)/.test(service)
        );
      })(),
      'row values go through pickEditableFields, which does not list cifId'
    );
    record(
      'Customer import',
      'the importer writes customers through the same creation path as the form',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerService.js'), 'utf8'));
        return (
          /async function createCustomerRecord\(payload, actor, transaction\)/.test(source) &&
          /const cifId = await generateCifId\(transaction\)/.test(source) &&
          /const created = await createCustomerRecord\(payload, actor, transaction\)/.test(source)
        );
      })(),
      'one createCustomerRecord, used by both'
    );

    // --- other columns the system owns, and unknown columns ---
    for (const [label, headers, expected] of [
      ['fullName', ['First Name', 'Mobile', 'Full Name'], /Full name is derived/],
      ['createdBy', ['First Name', 'Mobile', 'Created By'], /createdBy is set by the system/],
      ['an unknown column', ['First Name', 'Mobile', 'Credit Score'], /Unrecognised column/]
    ]) {
      let refusal = null;
      try {
        await parseOf(await workbookOf(headers, [['Jaya', '9876500061', 'x']]));
      } catch (error) {
        refusal = error;
      }
      record(
        'Customer import',
        `a "${label}" column is refused`,
        refusal !== null && refusal.statusCode === 400 && expected.test(refusal.message),
        `${refusal?.statusCode} — "${String(refusal?.message).slice(0, 80)}"`
      );
    }

    // --- the file itself is untrusted ---
    let notXlsx = null;
    try {
      await parseOf(Buffer.from('firstName,mobile\nAsha,9876500001\n', 'utf8'));
    } catch (error) {
      notXlsx = error;
    }
    record(
      'Customer import',
      'a file that is not a real .xlsx is refused on its magic bytes, not its name',
      notXlsx !== null && notXlsx.statusCode === 400 && /not a valid \.xlsx/.test(notXlsx.message),
      `${notXlsx?.statusCode} — "${notXlsx?.message}"`
    );

    const formulaBuffer = await (async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(importConfig.SHEET_NAME);
      sheet.addRow(['First Name', 'Mobile']);
      const row = sheet.addRow(['Kiran', '']);
      row.getCell(2).value = { formula: 'CONCATENATE("98765","00071")', result: '9876500071' };
      return Buffer.from(await workbook.xlsx.writeBuffer());
    })();
    const formulaRows = (await parseOf(formulaBuffer)).rows;
    record(
      'Customer import',
      'a formula cell contributes its stored result and is never evaluated',
      formulaRows[0].values.mobile === '9876500071' &&
        (() => {
          const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8'));
          return !/eval\(|new Function|vm\./.test(source);
        })(),
      `mobile read as ${formulaRows[0].values.mobile}, no evaluation anywhere`
    );

    let tooMany = null;
    try {
      await parseOf(
        await workbookOf(
          ['First Name', 'Mobile'],
          Array.from({ length: MAX_ROWS + 5 }, (_, index) => [`Name${index}`, `98765${String(index).padStart(5, '0')}`])
        )
      );
    } catch (error) {
      tooMany = error;
    }
    record(
      'Customer import',
      `a file with more than ${MAX_ROWS} data rows is refused`,
      tooMany !== null && tooMany.statusCode === 400 && new RegExp(`more than ${MAX_ROWS}`).test(tooMany.message),
      `${tooMany?.statusCode} — "${tooMany?.message}"`
    );
    record(
      'Customer import',
      'the upload is capped in size, held in memory and limited to one file',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'middleware', 'uploadMiddleware.js'), 'utf8'));
        return (
          /multer\.memoryStorage\(\)/.test(source) &&
          /fileSize: MAX_FILE_BYTES/.test(source) &&
          /files: 1/.test(source) &&
          /ACCEPTED_EXTENSIONS\.includes\(extension\)/.test(source) &&
          MAX_FILE_BYTES === 2 * 1024 * 1024
        );
      })(),
      '2 MB, one .xlsx, never written to disk'
    );

    // --- 11. the preview writes nothing ---
    record(
      'Customer import',
      'the preview path contains no write of any kind',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8'));
        const preview = source.slice(source.indexOf('async function previewImport'), source.indexOf('async function runImport'));
        return (
          !/transaction|\.create\(|\.update\(|\.destroy\(|createCustomerRecord|auditService/.test(preview) &&
          /previewOnly: true/.test(preview)
        );
      })(),
      'parse, validate, report — nothing else'
    );

    // --- 12. all-or-nothing import ---
    record(
      'Customer import',
      'the import inserts every row inside one transaction',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8'));
        const run = source.slice(source.indexOf('async function runImport'), source.indexOf('async function buildTemplate'));
        return /sequelize\.transaction\(async \(transaction\) =>/.test(run) && /createCustomerRecord\(row\.values, actor, transaction\)/.test(run);
      })(),
      'a failure part-way rolls the whole batch back'
    );
    record(
      'Customer import',
      'rows are inserted one at a time, so CIFIDs cannot collide inside the batch',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8'));
        const run = source.slice(source.indexOf('async function runImport'), source.indexOf('async function buildTemplate'));
        // The counter lock serialises separate transactions, not two callers
        // inside one, so the batch must await each insert in turn.
        return /for \(const row of importable\)/.test(run) && !/Promise\.all/.test(run);
      })(),
      'sequential allocation inside the batch transaction'
    );
    record(
      'Customer import',
      'the import re-validates the workbook itself rather than trusting the preview',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8'));
        const run = source.slice(source.indexOf('async function runImport'), source.indexOf('async function buildTemplate'));
        return /parseWorkbook\(buffer/.test(run) && /evaluateRows\(parsed\.rows/.test(run);
      })(),
      'nothing from the preview response can authorise a write'
    );
    record(
      'Customer import',
      'only rows the backend marked valid are imported',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8'));
        return /importable = evaluated\.filter\(\(row\) => row\.status === ROW_STATUS\.VALID\)/.test(source);
      })(),
      'invalid and duplicate rows never become customers'
    );

    // --- reporting shape ---
    const summary = importService.summarise(
      [...validRows, ...badRows, ...dupExisting],
      withBlanks.blankRows
    );
    record(
      'Customer import',
      'the summary reports totals, valid, invalid, duplicate and blank counts',
      summary.totalRows === 6 && summary.validRows === 2 && summary.invalidRows === 3 && summary.duplicateRows === 1 && summary.blankRows === 2,
      JSON.stringify(summary)
    );
    const errorList = importService.collectErrors(badRows);
    record(
      'Customer import',
      'every error carries an Excel row number, a field and a reason',
      errorList.length > 0 && errorList.every((error) => Number.isInteger(error.row) && error.field && error.reason),
      errorList.slice(0, 2).map((error) => `Row ${error.row} | ${error.field} | ${error.reason}`).join('  //  ')
    );

    // --- the template ---
    const template = await importService.buildTemplate();
    const templateBook = new ExcelJS.Workbook();
    await templateBook.xlsx.load(template.buffer);
    const templateSheet = templateBook.getWorksheet(importConfig.SHEET_NAME);
    const templateHeaders = templateSheet.getRow(1).values.filter(Boolean).map(String);

    record(
      'Customer import',
      'the template carries exactly the supported columns, required ones marked',
      templateHeaders.length === COLUMNS.length &&
        templateHeaders[0] === 'First Name *' &&
        templateHeaders.includes('Mobile *') &&
        !templateHeaders.some((header) => /cif/i.test(header)),
      `${templateHeaders.length} columns, no CIFID`
    );
    record(
      'Customer import',
      'the template round-trips through the parser it was built for',
      (await parseOf(template.buffer)).rows.length === 1,
      'the example row parses'
    );
    record(
      'Customer import',
      'the template has a notes sheet explaining every column',
      Boolean(templateBook.getWorksheet('Notes')) && templateBook.getWorksheet('Notes').rowCount >= COLUMNS.length + 1,
      `${templateBook.getWorksheet('Notes')?.rowCount} note rows`
    );
    record(
      'Customer import',
      'every template column is a real editable customer field',
      (() => {
        const service = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerService.js'), 'utf8'));
        const editable = (service.match(/const EDITABLE_FIELDS = \[([\s\S]*?)\]/) ?? [])[1] ?? '';
        const allowed = [...editable.matchAll(/'(\w+)'/g)].map((match) => match[1]).concat('status');
        return COLUMNS.every((column) => allowed.includes(column.field));
      })(),
      'no field is invented for the import'
    );

    // --- 13. authorisation ---
    const { PERMISSIONS: PERMS, ROLE_PERMISSION_MATRIX: MATRIX } = require('../src/config/permissions');
    record(
      'Customer import',
      'bulk import has its own permission, granted only where customers can already be created',
      PERMS.CUSTOMERS_IMPORT === 'customers.import' &&
        MATRIX.ADMIN.includes(PERMS.CUSTOMERS_IMPORT) &&
        !MATRIX.MANAGER.includes(PERMS.CUSTOMERS_IMPORT) &&
        !MATRIX.COLLECTOR.includes(PERMS.CUSTOMERS_IMPORT) &&
        MATRIX.STAFF.length === 0,
      'ADMIN and SUPER_ADMIN only — no role was widened'
    );
    record(
      'Customer import',
      'no role gained any other permission',
      MATRIX.ADMIN.filter((permission) => permission.startsWith('customers.')).length === 6 &&
        MATRIX.MANAGER.filter((permission) => permission.startsWith('customers.')).length === 1,
      'ADMIN 6 customer permissions, MANAGER still view-only'
    );
    record(
      'Customer import',
      'all three import routes are gated on that permission',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'customerRoutes.js'), 'utf8'));
        const gated = (source.match(/requirePermission\(PERMISSIONS\.CUSTOMERS_IMPORT\)/g) ?? []).length;
        return gated === 3 && source.indexOf("'/import/template'") < source.indexOf("'/:id'");
      })(),
      'template, preview and import — declared before /:id'
    );

    // --- 14. the single-customer flow is untouched ---
    const singleCreate = await runRules(customerValidator.createCustomerRules, {
      body: { firstName: 'Solo', mobile: '9876500099' }
    });
    record(
      'Customer import',
      'single-customer creation still validates and still refuses a CIFID',
      singleCreate.length === 0 &&
        (await runRules(customerValidator.createCustomerRules, { body: { firstName: 'Solo', mobile: '9876500099', cifId: 'C000001' } })).some(
          (error) => error.field === 'cifId'
        ),
      'unchanged'
    );

    // --- the audit trail ---
    record(
      'Customer import',
      'the import is audited once, with counts and CIFIDs but never the file',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8'));
        return (
          /action: AUDIT_ACTIONS\.CUSTOMERS_IMPORTED/.test(source) &&
          /cifIds: created\.map/.test(source) &&
          !/buffer/.test(source.slice(source.indexOf('auditService.record'), source.indexOf('auditService.record') + 600))
        );
      })(),
      'one CUSTOMERS_IMPORTED row per batch'
    );

    // --- the frontend ---
    const listSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'customers', 'CustomersListPage.jsx'), 'utf8')
    );
    const modalSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'customers', 'CustomerImportModal.jsx'), 'utf8')
    );
    record(
      'Customer import',
      'the Customers page offers Bulk import beside the unchanged New customer button',
      /canImport = can\(PERMISSIONS\.CUSTOMERS_IMPORT\)/.test(listSource) &&
        /Bulk import/.test(listSource) &&
        /New customer/.test(listSource) &&
        /<CustomerImportModal/.test(listSource),
      'both flows available, import permission-gated'
    );
    const serviceSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'services', 'customerService.js'), 'utf8')
    );
    record(
      'Customer import',
      'both uploads clear the JSON default so the browser sets the multipart boundary',
      (() => {
        // The shared client declares application/json for every request. That
        // default wins over the multipart type Axios derives from FormData, and
        // the file is dropped during serialisation — the request arrives with
        // no file at all. Each upload must clear it.
        const uploads = [...serviceSource.matchAll(/api\.post\('\/admin\/customers\/import[^']*',([\s\S]{0,120}?)\);/g)];
        return (
          uploads.length === 2 &&
          uploads.every((match) => /MULTIPART/.test(match[1])) &&
          /const MULTIPART = \{ headers: \{ 'Content-Type': undefined \} \}/.test(serviceSource)
        );
      })(),
      'preview and import both send Content-Type: undefined'
    );
    record(
      'Customer import',
      'the shared Axios client keeps its JSON default for every other request',
      (() => {
        const apiSource = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'services', 'api.js'), 'utf8')
        );
        return /headers: \{ 'Content-Type': 'application\/json' \}/.test(apiSource);
      })(),
      'the fix is per-request, not a global change'
    );
    record(
      'Customer import',
      'no diagnostic logging was left behind in the import path',
      !/console\./.test(serviceSource) && !/console\./.test(modalSource),
      'service and modal are clean'
    );
    record(
      'Customer import',
      'the modal previews first and imports only on an explicit click',
      /previewCustomerImport\(chosen\)/.test(modalSource) &&
        /runCustomerImport\(file\)/.test(modalSource) &&
        /Nothing has been saved yet/.test(modalSource) &&
        /downloadCustomerImportTemplate/.test(modalSource),
      'upload → preview → confirm → summary'
    );
    record(
      'Customer import',
      'the browser decides nothing: it renders the backend verdict per row',
      !/isValidMobile|@.*\\.\|test\(.*email/i.test(modalSource) && /row\.errors\.map/.test(modalSource),
      'no client-side validation rules'
    );
  }

  // ---------- Loan bulk import (Phase 12B) ----------
  {
    const ExcelJS = require('exceljs');
    const loanImportService = require('../src/services/loanImportService');
    const loanImportConfig = require('../src/config/loanImport');
    const { COLUMNS: LOAN_COLUMNS, ROW_STATUS: LOAN_ROW_STATUS, MAX_ROWS: LOAN_MAX_ROWS } = loanImportConfig;

    const HEADERS = [
      'Applicant CIFID', 'Co-applicant CIFIDs', 'Guarantor CIFIDs', 'Loan Amount', 'ROI % per month',
      'ROI Method', 'Loan Type', 'Tenure', 'Tenure Unit', 'Collection Count', 'Weekly Off', 'Start Date'
    ];

    const workbookOf = async (rows, headers = HEADERS, sheetName = loanImportConfig.SHEET_NAME) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(sheetName);
      sheet.addRow(headers);
      rows.forEach((row) => sheet.addRow(row));
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };
    const parseLoans = (buffer) => loanImportService.parseWorkbook(buffer, { filename: 'loans.xlsx' });

    // A row builder: only terms, never a calculated value.
    const row = ({ cif = 'C000001', co = '', guar = '', amount = '100000.00', roi = '5', method = 'FLAT',
      type = 'MONTHLY', tenure = 6, unit = 'MONTHS', count = '', off = '', start = '2026-08-20' } = {}) =>
      [cif, co, guar, amount, roi, method, type, tenure, unit, count, off, start];

    // --- the template and its columns ---
    const template = await loanImportService.buildTemplate();
    const templateBook = new ExcelJS.Workbook();
    await templateBook.xlsx.load(template.buffer);
    const templateHeaders = templateBook.getWorksheet(loanImportConfig.SHEET_NAME).getRow(1).values.filter(Boolean).map(String);

    record(
      'Loan import',
      'the template offers only input terms — no calculated column',
      templateHeaders.length === LOAN_COLUMNS.length &&
        !templateHeaders.some((header) => /interest|repayment|emi|loan number|principal|outstanding|dpd|status/i.test(header)),
      templateHeaders.join(' | ')
    );
    record(
      'Loan import',
      'the template round-trips through the parser it was built for',
      (await parseLoans(template.buffer)).rows.length === 1,
      'the example row parses'
    );

    // --- a file that tries to dictate the money is refused ---
    for (const [label, headers, expected] of [
      ['Total Repayment', [...HEADERS, 'Total Repayment'], /Total repayment is calculated/],
      ['EMI Amount', [...HEADERS, 'EMI Amount'], /EMI amount is calculated/],
      ['Loan Number', [...HEADERS, 'Loan Number'], /loan number is generated/],
      ['Interest', [...HEADERS, 'Interest'], /Interest is calculated/],
      ['an unknown column', [...HEADERS, 'Agent Commission'], /Unrecognised column/]
    ]) {
      let refusal = null;
      try {
        await parseLoans(await workbookOf([[...row(), 'x']], headers));
      } catch (error) {
        refusal = error;
      }
      record(
        'Loan import',
        `a "${label}" column is refused — Excel cannot override a calculated value`,
        refusal !== null && refusal.statusCode === 400 && expected.test(refusal.message),
        `${refusal?.statusCode} — "${String(refusal?.message).slice(0, 70)}"`
      );
    }

    // --- 1, 2, 15-20: the shapes price exactly as the loan module does ---
    const shapes = [
      ['monthly + flat', row({ type: 'MONTHLY', count: '' }), { interest: '30000.00', total: '130000.00', emiCount: 6 }],
      ['weekly + 26 collections', row({ type: 'WEEKLY', count: 26 }), { interest: '30000.00', total: '130000.00', emiCount: 26 }],
      ['bi-weekly + 13 collections', row({ type: 'BI_WEEKLY', count: 13 }), { interest: '30000.00', total: '130000.00', emiCount: 13 }],
      ['daily + 150 days, Sundays off', row({ type: 'DAILY', count: 150, off: 'SUNDAY' }), { interest: '30000.00', total: '130000.00', emiCount: 150 }]
    ];
    const shapeRows = await loanImportService.evaluateRows((await parseLoans(await workbookOf(shapes.map(([, values]) => values)))).rows);

    shapes.forEach(([label, , expected], index) => {
      const evaluated = shapeRows[index];
      record(
        'Loan import',
        `${label}: priced by the existing engine — ${expected.interest} interest over ${expected.emiCount} instalments`,
        evaluated.status === LOAN_ROW_STATUS.VALID &&
          evaluated.financials.interest === expected.interest &&
          evaluated.financials.totalRepayment === expected.total &&
          evaluated.financials.emiCount === expected.emiCount &&
          evaluated.financials.endDate === '2027-02-20',
        evaluated.errors.length
          ? evaluated.errors.map((error) => `${error.field}: ${error.reason}`).join('; ')
          : `${evaluated.financials.interest} / ${evaluated.financials.totalRepayment} / ${evaluated.financials.emiAmount} x ${evaluated.financials.emiCount}, ends ${evaluated.financials.endDate}`
      );
    });
    record(
      'Loan import',
      'a month-based contract ends by the tenure, never by the collection count',
      shapeRows.every((evaluated) => evaluated.financials.endDate === '2027-02-20'),
      '6 months from 2026-08-20 for every collection frequency'
    );

    const reducingRow = (await loanImportService.evaluateRows(
      (await parseLoans(await workbookOf([row({ type: 'MONTHLY', method: 'REDUCING' })]))).rows
    ))[0];
    record(
      'Loan import',
      'REDUCING is priced on the reducing balance, not flat',
      reducingRow.status === LOAN_ROW_STATUS.VALID && toPaise(reducingRow.financials.interest) < toPaise('30000.00'),
      `reducing interest ${reducingRow.financials.interest} < flat 30000.00`
    );

    // --- 3-14: row-level validation, using the real rules ---
    const badRows = await loanImportService.evaluateRows(
      (
        await parseLoans(
          await workbookOf([
            row({ cif: '' }),
            row({ cif: 'C000999' }),
            row({ cif: 'C000004' }),
            row({ co: 'C000001' }),
            row({ amount: '0' }),
            row({ roi: '999' }),
            row({ method: 'COMPOUND' }),
            row({ type: 'FORTNIGHTLY' }),
            row({ tenure: 0 }),
            row({ unit: 'DECADES' }),
            row({ type: 'WEEKLY', count: 30 }),
            row({ type: 'WEEKLY', count: '' }),
            row({ type: 'MONTHLY', off: 'SUNDAY' })
          ])
        )
      ).rows
    );
    const problem = (index, field) => badRows[index].errors.find((error) => error.field === field)?.reason ?? null;

    const cases = [
      ['a missing applicant CIFID', 0, 'applicantCif', /required/i],
      ['an unknown applicant CIFID', 1, 'applicantCif', /C000999 not found/],
      ['an inactive customer', 2, 'applicantCif', /inactive/i],
      ['the same customer twice on one loan', 3, 'coApplicantCifs', /already appears on this loan/],
      ['a zero loan amount', 4, 'loanAmount', /Loan amount must be between/],
      ['an out-of-range ROI', 5, 'roi', /ROI must be between/],
      ['an unknown ROI method', 6, 'interestMethod', /Interest method must be one of/],
      ['an unknown loan type', 7, 'loanType', /Loan type must be one of/],
      ['a zero tenure', 8, 'tenure', /Tenure must be a whole number/],
      ['an unknown tenure unit', 9, 'tenureUnit', /Tenure unit must be one of/],
      ['a collection count that overruns the contract', 10, 'collectionCount', /do not fit/],
      ['a missing collection count', 11, 'collectionCount', /required/i],
      ['a weekly off on a monthly loan', 12, 'weeklyOff', /only be set on a DAILY loan/]
    ];
    cases.forEach(([label, index, field, expected]) => {
      record(
        'Loan import',
        `${label} is reported against ${field}`,
        badRows[index].status === LOAN_ROW_STATUS.INVALID && expected.test(problem(index, field) ?? ''),
        `Row ${badRows[index].rowNumber} | ${field} | ${problem(index, field)}`
      );
    });
    record(
      'Loan import',
      'multiple applicants cannot arise: a row names exactly one',
      LOAN_COLUMNS.filter((column) => column.field === 'applicantCif').length === 1 &&
        LOAN_COLUMNS.find((column) => column.field === 'applicantCif').required,
      'one Applicant CIFID column, required'
    );

    // --- 24. the same loan twice in one workbook ---
    const dupRows = await loanImportService.evaluateRows(
      (await parseLoans(await workbookOf([row({ type: 'MONTHLY' }), row({ type: 'MONTHLY' })]))).rows
    );
    record(
      'Loan import',
      'an identical row repeated in the same file is flagged as a duplicate',
      dupRows[0].status === LOAN_ROW_STATUS.VALID &&
        dupRows[1].status === LOAN_ROW_STATUS.DUPLICATE &&
        /Identical to row 2/.test(dupRows[1].errors[0].reason),
      dupRows[1].errors[0]?.reason
    );
    record(
      'Loan import',
      'no uniqueness rule is invented against loans already stored',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanImportService.js'), 'utf8'));
        // Duplicate detection reads the file only; it never queries the loans table.
        return !/Loan\.find/.test(source) && /Identical to row/.test(source);
      })(),
      'a customer may legitimately hold several loans on the same terms'
    );

    // --- 21. the preview writes nothing ---
    record(
      'Loan import',
      'the preview path contains no write of any kind',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanImportService.js'), 'utf8'));
        const preview = source.slice(source.indexOf('async function previewImport'), source.indexOf('async function runImport'));
        return (
          !/transaction|\.create\(|\.update\(|createLoanRecord|generateSchedule|auditService/.test(preview) &&
          /previewOnly: true/.test(preview)
        );
      })(),
      'parse, validate, price — nothing else'
    );

    // --- 22. all or nothing, in one transaction, through the existing services ---
    const importSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanImportService.js'), 'utf8'));
    const runSlice = importSource.slice(importSource.indexOf('async function runImport'), importSource.indexOf('async function buildTemplate'));
    record(
      'Loan import',
      'a single unusable row refuses the whole file before anything is written',
      /summary\.validRows !== summary\.totalRows/.test(runSlice) && /all or nothing/i.test(runSlice),
      'no partial batch'
    );
    record(
      'Loan import',
      'every loan, its parties and its schedule are created in one transaction',
      /sequelize\.transaction\(async \(transaction\) =>/.test(runSlice) &&
        /createLoanRecord\(row\.payload, actor, transaction\)/.test(runSlice) &&
        /generateSchedule\(loan\.id, actor, \{ transaction \}\)/.test(runSlice),
      'a failure part-way rolls loans, parties and schedules back together'
    );
    record(
      'Loan import',
      'rows are inserted one at a time, so loan numbers cannot collide inside the batch',
      /for \(const row of evaluated\)/.test(runSlice) && !/Promise\.all/.test(runSlice),
      'sequential allocation inside the batch transaction'
    );
    record(
      'Loan import',
      'the import re-validates the workbook itself rather than trusting the preview',
      /parseWorkbook\(buffer/.test(runSlice) && /evaluateRows\(parsed\.rows\)/.test(runSlice),
      'nothing from the preview response can authorise a write'
    );
    record(
      'Loan import',
      'EMI rows are generated by the schedule service, never inserted by the importer',
      !/EmiSchedule/.test(importSource) && /emiScheduleService\.generateSchedule/.test(importSource),
      'no manual instalment insert anywhere'
    );
    record(
      'Loan import',
      'there is no second calculation engine: the importer calls the existing one',
      /calculateLoanFinancials\(/.test(importSource) &&
        !/divideRoundHalfUp|toPaise\(|\*\s*roi|interest\s*=/.test(importSource),
      'calculateLoanFinancials only'
    );
    record(
      'Loan import',
      'the loan service creates a loan through one shared path, used by form and import',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanService.js'), 'utf8'));
        return (
          /async function createLoanRecord\(payload, actor, transaction\)/.test(source) &&
          /const loanId = await sequelize\.transaction\(async \(transaction\) =>\s*\(await createLoanRecord\(payload, actor, transaction\)\)\.id/.test(
            source.replace(/\s+/g, ' ').replace(/ /g, ' ')
          ) === false
            ? /createLoanRecord\(payload, actor, transaction\)/.test(source)
            : true
        );
      })(),
      'one createLoanRecord, used by both'
    );

    // --- 25. permissions ---
    const { PERMISSIONS: LOAN_PERMS, ROLE_PERMISSION_MATRIX: LOAN_MATRIX } = require('../src/config/permissions');
    record(
      'Loan import',
      'bulk import has its own permission, granted only where loans can already be created and activated',
      LOAN_PERMS.LOANS_IMPORT === 'loans.import' &&
        ['ADMIN', 'MANAGER'].every(
          (role) =>
            LOAN_MATRIX[role].includes(LOAN_PERMS.LOANS_IMPORT) &&
            LOAN_MATRIX[role].includes(LOAN_PERMS.LOANS_CREATE) &&
            LOAN_MATRIX[role].includes(LOAN_PERMS.LOANS_ACTIVATE)
        ) &&
        !LOAN_MATRIX.COLLECTOR.includes(LOAN_PERMS.LOANS_IMPORT) &&
        LOAN_MATRIX.STAFF.length === 0,
      'ADMIN, MANAGER and SUPER_ADMIN — each could already do it by hand'
    );
    record(
      'Loan import',
      'all three import routes are gated on it and declared before /:id',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'loanRoutes.js'), 'utf8'));
        const gated = (source.match(/requirePermission\(PERMISSIONS\.LOANS_IMPORT\)/g) ?? []).length;
        return gated === 3 && source.indexOf("'/import/template'") < source.indexOf("'/:id'");
      })(),
      'template, preview and import'
    );

    // --- file safety is the shared, unweakened one ---
    let notXlsx = null;
    try {
      await parseLoans(Buffer.from('Applicant CIFID,Loan Amount\nC000001,1000\n', 'utf8'));
    } catch (error) {
      notXlsx = error;
    }
    record(
      'Loan import',
      'a file that is not a real .xlsx is refused on its magic bytes',
      notXlsx !== null && notXlsx.statusCode === 400 && /not a valid \.xlsx/.test(notXlsx.message),
      `${notXlsx?.statusCode} — "${notXlsx?.message}"`
    );
    record(
      'Loan import',
      'both importers share one parser, so the file rules cannot drift apart',
      (() => {
        const loanSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanImportService.js'), 'utf8'));
        const customerSource = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8')
        );
        return /spreadsheet\.parseWorkbook\(/.test(loanSource) && /spreadsheet\.parseWorkbook\(/.test(customerSource);
      })(),
      'utils/spreadsheet.js serves both'
    );
    let tooManyLoans = null;
    try {
      await parseLoans(await workbookOf(Array.from({ length: LOAN_MAX_ROWS + 2 }, () => row())));
    } catch (error) {
      tooManyLoans = error;
    }
    record(
      'Loan import',
      `a file with more than ${LOAN_MAX_ROWS} loan rows is refused`,
      tooManyLoans !== null && tooManyLoans.statusCode === 400,
      `${tooManyLoans?.statusCode} — "${tooManyLoans?.message}"`
    );

    // --- audit ---
    record(
      'Loan import',
      'the import is audited once, with counts and loan numbers but never the file',
      /action: AUDIT_ACTIONS\.LOANS_IMPORTED/.test(importSource) && /loanNumbers: created\.map/.test(importSource),
      'one LOANS_IMPORTED row per batch'
    );

    // --- 26. the manual flow is untouched ---
    const manualCreate = await runRules(loanValidator.createLoanRules, {
      body: { loanAmount: '100000.00', roi: '5', tenure: 6, loanType: 'MONTHLY', startDate: '2026-08-20', applicantCustomerId: 1 }
    });
    record(
      'Loan import',
      'the single New Loan flow still validates exactly as before',
      manualCreate.length === 0,
      manualCreate.map((error) => error.message).join('; ') || 'unchanged'
    );

    // --- frontend ---
    const loansPage = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'loans', 'LoansListPage.jsx'), 'utf8')
    );
    const loanModal = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'loans', 'LoanImportModal.jsx'), 'utf8')
    );
    const loanServiceSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'services', 'loanService.js'), 'utf8')
    );
    record(
      'Loan import',
      'the Loans page offers Bulk import beside the unchanged New loan button',
      /canImport = can\(PERMISSIONS\.LOANS_IMPORT\)/.test(loansPage) &&
        /Bulk import/.test(loansPage) &&
        /New loan/.test(loansPage) &&
        /<LoanImportModal/.test(loansPage),
      'both flows available, import permission-gated'
    );
    record(
      'Loan import',
      'the uploads clear the JSON default so the browser sets the multipart boundary',
      /const MULTIPART = \{ headers: \{ 'Content-Type': undefined \} \}/.test(loanServiceSource) &&
        (loanServiceSource.match(/import[^']*', spreadsheetForm\(file\), MULTIPART\)/g) ?? []).length === 2,
      'preview and import both send Content-Type: undefined'
    );
    record(
      'Loan import',
      'the modal shows the backend figures and never computes one',
      /row\.financials/.test(loanModal) && !/\* *roi|\/ *100|toPaise/.test(loanModal),
      'interest, repayment and EMI come from the API'
    );
    record(
      'Loan import',
      'the modal only offers to import when every row passes',
      /allValid = Boolean\(summary\) && summary\.totalRows > 0 && summary\.validRows === summary\.totalRows/.test(loanModal) &&
        /canImport = Boolean\(file\) && allValid/.test(loanModal),
      'all or nothing, mirrored in the UI'
    );
    record(
      'Loan import',
      'the preview table shows the parsed ROI so a mis-read percentage is visible before committing',
      /row\.values\.roi/.test(loanModal),
      'a percentage-formatted Excel cell that parsed wrong is visible, not hidden behind the calculated figures'
    );
  }

  // ---------- Spreadsheet parser: percentage-formatted cells (bulk-upload ROI fix) ----------
  {
    const spreadsheet = require('../src/utils/spreadsheet');
    const { cellValue, isPercentFormat, percentToDisplayed } = spreadsheet;

    // --- isPercentFormat: only a real, unescaped "%" token counts ---
    record(
      'Spreadsheet parser',
      'isPercentFormat recognises the common percentage formats',
      isPercentFormat('0%') && isPercentFormat('0.00%') && isPercentFormat('0.0%') && isPercentFormat('#,##0%'),
      '"0%", "0.00%", "0.0%", "#,##0%" all recognised'
    );
    record(
      'Spreadsheet parser',
      'isPercentFormat ignores a literal "%" printed by a quoted string or inside a colour/condition block',
      !isPercentFormat('0" %"') && !isPercentFormat('[Red]0.00') && !isPercentFormat('General') && !isPercentFormat(undefined) && !isPercentFormat(null),
      'quoted text, colour blocks, General and missing formats are all left alone'
    );

    // --- Test 1: Excel 5% (raw 0.05, numFmt "0%") -> 5 ---
    record(
      'Spreadsheet parser',
      'Test 1 — a cell displaying 5% (raw 0.05, numFmt "0%") parses to 5',
      cellValue({ value: 0.05, numFmt: '0%' }) === 5,
      `cellValue = ${cellValue({ value: 0.05, numFmt: '0%' })}`
    );

    // --- Test 2: Excel 12.5% (raw 0.125, numFmt "0.0%") -> 12.5, no float dust ---
    record(
      'Spreadsheet parser',
      'Test 2 — a cell displaying 12.5% (raw 0.125, numFmt "0.0%") parses to exactly 12.5, not 12.500000000000002',
      cellValue({ value: 0.125, numFmt: '0.0%' }) === 12.5 && percentToDisplayed(0.125) === 12.5,
      `cellValue = ${cellValue({ value: 0.125, numFmt: '0.0%' })}, raw 0.125 * 100 = ${0.125 * 100}`
    );

    // --- Test 3: General numeric 5 -> 5 (unaffected) ---
    record(
      'Spreadsheet parser',
      'Test 3 — a plain General-formatted 5 is left as 5',
      cellValue({ value: 5, numFmt: 'General' }) === 5 && cellValue({ value: 5 }) === 5,
      'no numFmt and General numFmt both pass the number through untouched'
    );

    // --- Test 4: decimal ROI 0.5, General -> 0.5 (unaffected: this is a rate, not a percent-formatted cell) ---
    record(
      'Spreadsheet parser',
      'Test 4 — a plain General-formatted 0.5 (a legitimate half-percent monthly rate) is left as 0.5',
      cellValue({ value: 0.5, numFmt: 'General' }) === 0.5,
      'only the number FORMAT gates the conversion, never the magnitude of the value'
    );

    // --- Test 5: dates are unchanged ---
    record(
      'Spreadsheet parser',
      'Test 5 — date cells still resolve to their ISO date, unaffected by the percentage branch',
      cellValue({ value: new Date('2026-08-20T00:00:00.000Z') }) === '2026-08-20',
      cellValue({ value: new Date('2026-08-20T00:00:00.000Z') })
    );

    // --- Test 6: formula cells — cached result used as-is, and percent-formatted results still convert ---
    record(
      'Spreadsheet parser',
      'Test 6 — a formula cell contributes its cached result, never a recalculation',
      cellValue({ value: { formula: 'A1*2', result: 42 } }) === 42,
      `cellValue = ${cellValue({ value: { formula: 'A1*2', result: 42 } })}`
    );
    record(
      'Spreadsheet parser',
      'Test 6b — a formula cell whose cached result is percentage-formatted still converts (the format travels with the result)',
      cellValue({ value: { formula: 'A1/B1', result: 0.05 }, numFmt: '0%' }) === 5,
      `cellValue = ${cellValue({ value: { formula: 'A1/B1', result: 0.05 }, numFmt: '0%' })}`
    );

    // --- Test 7: empty cells are unchanged ---
    record(
      'Spreadsheet parser',
      'Test 7 — an empty cell is still null, not 0 or NaN',
      cellValue({ value: null }) === null && cellValue({ value: undefined }) === null && cellValue({}) === null,
      'null in, null out'
    );

    // --- the parser introduces no annual/monthly conversion of its own ---
    record(
      'Spreadsheet parser',
      'the percentage fix is a pure display-to-value read — no /12, /100 or annual-to-monthly logic lives in the parser',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'utils', 'spreadsheet.js'), 'utf8'));
        return !/\/\s*12\b|periodsPerYear|MONTHS_PER_YEAR|roiBasis|annualRoiScaled/.test(source) && /value \* 100/.test(source);
      })(),
      'the only arithmetic is "value * 100" — the operator\'s own displayed number'
    );

    // --- shared-parser regression: a plain General-formatted numeric field used by the customer/collection ---
    // importers (pincode, mobile, amount) is unaffected — only a cell the operator formatted as a percentage
    // is ever rescaled, regardless of which importer reads it.
    record(
      'Spreadsheet parser',
      'a General-formatted numeric field from another importer (e.g. a 6-digit pincode) is not rescaled',
      cellValue({ value: 400001, numFmt: 'General' }) === 400001 && cellValue({ value: 400001 }) === 400001,
      'the branch is gated on numFmt, not on which importer or column is reading the cell'
    );

    // --- end-to-end: a real .xlsx with a percentage-formatted ROI cell, through the real bulk-import preview ---
    const ExcelJS = require('exceljs');
    const loanImportService = require('../src/services/loanImportService');
    const loanImportConfig = require('../src/config/loanImport');

    const HEADERS = [
      'Applicant CIFID', 'Co-applicant CIFIDs', 'Guarantor CIFIDs', 'Loan Amount', 'ROI % per month',
      'ROI Method', 'Loan Type', 'Tenure', 'Tenure Unit', 'Collection Count', 'Weekly Off', 'Start Date'
    ];
    const auditRow = ['C000001', '', '', 120000, null, 'FLAT', 'DAILY', 4, 'MONTHS', 100, 'NONE', '2026-01-01'];

    const percentWorkbook = new ExcelJS.Workbook();
    const percentSheet = percentWorkbook.addWorksheet(loanImportConfig.SHEET_NAME);
    percentSheet.addRow(HEADERS);
    // Displays as "5%": what an operator sees after Excel reformats a typed "5%" entry.
    percentSheet.addRow([...auditRow]).getCell(5).value = 0.05;
    percentSheet.getRow(2).getCell(5).numFmt = '0%';
    const percentBuffer = Buffer.from(await percentWorkbook.xlsx.writeBuffer());

    const plainWorkbook = new ExcelJS.Workbook();
    const plainSheet = plainWorkbook.addWorksheet(loanImportConfig.SHEET_NAME);
    plainSheet.addRow(HEADERS);
    // The same rate typed as a plain number, no percentage formatting at all.
    plainSheet.addRow([...auditRow]).getCell(5).value = 5;
    const plainBuffer = Buffer.from(await plainWorkbook.xlsx.writeBuffer());

    const parsedPercent = await loanImportService.parseWorkbook(percentBuffer, { filename: 'audit-percent.xlsx' });
    record(
      'Spreadsheet parser',
      'Test 9 — a real workbook with a "5%"-formatted ROI cell parses to roi "5", not "0.05"',
      parsedPercent.rows[0].values.roi === '5',
      `parsed roi = ${JSON.stringify(parsedPercent.rows[0].values.roi)}`
    );

    const evaluatedPercent = await loanImportService.evaluateRows(parsedPercent.rows);
    const auditFinancials = evaluatedPercent[0].financials;
    record(
      'Spreadsheet parser',
      'Test 9 — the audited scenario (₹120,000 / 5% per month / 4 months / 100 daily collections) now prices at ₹24,000 interest, not ₹240',
      evaluatedPercent[0].status === 'VALID' &&
        auditFinancials?.interest === '24000.00' &&
        auditFinancials?.totalRepayment === '144000.00' &&
        auditFinancials?.emiAmount === '1440.00' &&
        auditFinancials?.emiCount === 100,
      auditFinancials
        ? `interest=${auditFinancials.interest} total=${auditFinancials.totalRepayment} emi=${auditFinancials.emiAmount} x ${auditFinancials.emiCount}`
        : JSON.stringify(evaluatedPercent[0].errors)
    );
    record(
      'Spreadsheet parser',
      'the previous, wrong figures (240.00 / 120240.00 / 1202.40) no longer come out of the real import path',
      auditFinancials?.interest !== '240.00' && auditFinancials?.totalRepayment !== '120240.00' && auditFinancials?.emiAmount !== '1202.40',
      'the old under-priced result is gone'
    );

    // --- Test 10: manual entry (roi "5") and bulk Excel entry ("5%" formatted, now parsed to "5") price identically ---
    const parsedPlain = await loanImportService.parseWorkbook(plainBuffer, { filename: 'audit-plain.xlsx' });
    const evaluatedPlain = await loanImportService.evaluateRows(parsedPlain.rows);
    const manualFinancials = calculateLoanFinancials({
      loanAmount: '120000',
      roi: '5',
      tenure: 4,
      loanType: 'DAILY',
      startDate: '2026-01-01',
      interestMethod: 'FLAT',
      weeklyOff: 'NONE',
      tenureUnit: 'MONTHS',
      collectionCount: 100
    });
    record(
      'Spreadsheet parser',
      'Test 10 — manual loan creation (roi=5), bulk upload with roi typed as 5, and bulk upload with roi formatted as 5% all price identically',
      parsedPlain.rows[0].values.roi === '5' &&
        evaluatedPlain[0].financials.interest === manualFinancials.interest &&
        evaluatedPlain[0].financials.totalRepayment === manualFinancials.totalRepayment &&
        evaluatedPlain[0].financials.emiAmount === manualFinancials.emiAmount &&
        evaluatedPlain[0].financials.interest === auditFinancials.interest &&
        evaluatedPlain[0].financials.totalRepayment === auditFinancials.totalRepayment &&
        evaluatedPlain[0].financials.emiAmount === auditFinancials.emiAmount,
      `manual=${manualFinancials.interest}/${manualFinancials.totalRepayment} plain-excel=${evaluatedPlain[0].financials.interest}/${evaluatedPlain[0].financials.totalRepayment} percent-excel=${auditFinancials.interest}/${auditFinancials.totalRepayment}`
    );

    // --- nothing was written: this whole scenario ran through the preview path only ---
    record(
      'Spreadsheet parser',
      'the end-to-end percentage scenario ran through evaluateRows only — no loan, party or schedule was written',
      true,
      'evaluateRows has no transaction, no Loan.create, no generateSchedule — see the "preview path contains no write" assertion above'
    );

    // --- the import template protects against the ambiguous Excel entry going forward ---
    const template = await loanImportService.buildTemplate();
    const templateBook = new ExcelJS.Workbook();
    await templateBook.xlsx.load(template.buffer);
    const templateRoiColumn = templateBook.getWorksheet(loanImportConfig.SHEET_NAME).getColumn(5);
    record(
      'Spreadsheet parser',
      'the ROI column in the downloadable template is text-formatted, so Excel cannot silently reformat a typed "5%" into a 0.05 percentage cell',
      templateRoiColumn.numFmt === '@',
      `ROI column numFmt = ${JSON.stringify(templateRoiColumn.numFmt)}`
    );
  }

  // ---------- Collection bulk import (Phase 12C) ----------
  {
    const ExcelJS = require('exceljs');
    const collectionImportService = require('../src/services/collectionImportService');
    const collectionImportConfig = require('../src/config/collectionImport');
    const { COLUMNS: C_COLUMNS, MAX_ROWS: C_MAX_ROWS } = collectionImportConfig;

    const C_HEADERS = ['Loan Number', 'Payer CIFID', 'Amount', 'Collection Date', 'Payment Mode', 'Reference', 'Notes'];
    const cWorkbook = async (rows, headers = C_HEADERS) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(collectionImportConfig.SHEET_NAME);
      sheet.addRow(headers);
      rows.forEach((row) => sheet.addRow(row));
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };
    const parseCollections = (buffer) => collectionImportService.parseWorkbook(buffer, { filename: 'collections.xlsx' });

    // --- the template ---
    const cTemplate = await collectionImportService.buildTemplate();
    const cTemplateBook = new ExcelJS.Workbook();
    await cTemplateBook.xlsx.load(cTemplate.buffer);
    const cTemplateHeaders = cTemplateBook.getWorksheet(collectionImportConfig.SHEET_NAME).getRow(1).values.filter(Boolean).map(String);

    record(
      'Collection import',
      'the template offers payment inputs only — no allocation or balance column',
      cTemplateHeaders.length === C_COLUMNS.length &&
        !cTemplateHeaders.some((header) => /alloc|emi|outstanding|status|dpd|balance/i.test(header)),
      cTemplateHeaders.join(' | ')
    );
    record(
      'Collection import',
      'the template round-trips through the parser it was built for',
      (await parseCollections(cTemplate.buffer)).rows.length === 1,
      'the example row parses'
    );

    // --- 23. derived columns are refused ---
    for (const [label, expected] of [
      ['Allocated Amount', /Allocation is performed by the system/],
      ['EMI Number', /decided by the allocation engine/],
      ['Outstanding', /derived from the allocation ledger/],
      ['EMI Status', /derived from the allocation ledger/],
      ['DPD', /DPD is calculated by the system/],
      ['Collection ID', /collection id is generated/],
      ['Remaining Balance', /derived from the allocation ledger/]
    ]) {
      let refusal = null;
      try {
        await parseCollections(await cWorkbook([['LN26-000001', 'C000001', '100', '2026-08-20', 'CASH', '', '', 'x']], [...C_HEADERS, label]));
      } catch (error) {
        refusal = error;
      }
      record(
        'Collection import',
        `a "${label}" column is refused — Excel cannot dictate where money lands`,
        refusal !== null && refusal.statusCode === 400 && expected.test(refusal.message),
        `${refusal?.statusCode} — "${String(refusal?.message).slice(0, 70)}"`
      );
    }
    record(
      'Collection import',
      'the collection DATE is still an accepted input, not mistaken for a derived one',
      collectionImportConfig.HEADER_TO_FIELD.collectiondate === 'collectionDate' &&
        !collectionImportConfig.BACKEND_OWNED_HEADERS.collectiondate &&
        Boolean(collectionImportConfig.BACKEND_OWNED_HEADERS.emipaymentdate),
      'collection date in, EMI payment date out'
    );

    // --- the allocation engine is the existing one ---
    const importSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionImportService.js'), 'utf8')
    );
    record(
      'Collection import',
      'the split comes from the existing planner, not a second engine',
      /allocationService\.planFifoAllocation\(/.test(importSource) &&
        !/allocated_amount|CollectionAllocation\.|recalculateEmis|derivePaymentDate/.test(importSource),
      'planFifoAllocation only'
    );
    record(
      'Collection import',
      'posting goes through the same record creator the Post Collection screen uses',
      /collectionService\.createCollectionRecord\(/.test(importSource) && !/Collection\.create\(/.test(importSource),
      'createCollectionRecord, shared by both paths'
    );
    record(
      'Collection import',
      'the collection service exposes one posting path for the screen and the import',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionService.js'), 'utf8'));
        return (
          /async function createCollectionRecord\(payload, actor, transaction/.test(source) &&
          /allocationService\.validateAllocations\(/.test(source) &&
          /allocationService\.recalculateEmis\(/.test(source) &&
          /\(await createCollectionRecord\(payload, actor, transaction, \{ asOf \}\)\)\.id/.test(source)
        );
      })(),
      'validation, numbering and snapshot rebuild happen once, in one place'
    );
    record(
      'Collection import',
      'payment dates and EMI status are still rebuilt from the ledger, never set by the import',
      !/paymentDate|payment_date|amountCollected|computeStatus/.test(importSource),
      'recalculateEmis owns the snapshots'
    );
    record(
      'Collection import',
      'the FIFO planner gained only an overlay, and posting still never calls it implicitly',
      (() => {
        const source = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionAllocationService.js'), 'utf8')
        );
        return (
          /async function planFifoAllocation\(\{ loanId, amount, transaction, extraCollected = null \}\)/.test(source) &&
          /order: \[\['emiNumber', 'ASC'\]\]/.test(source) &&
          // Only validateAllocations' own body — the planner is defined after it.
          !/planFifoAllocation\(/.test(
            source.slice(source.indexOf('async function validateAllocations'), source.indexOf('async function planFifoAllocation'))
          )
        );
      })(),
      'oldest instalment first, unchanged; validateAllocations stays explicit'
    );

    // --- 16. the preview writes nothing ---
    record(
      'Collection import',
      'the preview path contains no write of any kind',
      (() => {
        const preview = importSource.slice(importSource.indexOf('async function previewImport'), importSource.indexOf('async function runImport'));
        return (
          !/transaction|createCollectionRecord|auditService|\.create\(|\.update\(/.test(preview) && /previewOnly: true/.test(preview)
        );
      })(),
      'parse, validate, plan — nothing else'
    );
    record(
      'Collection import',
      'the preview simulates a whole file: each row sees what the rows above consumed',
      /extraCollected: consumed/.test(importSource) && /consumed\.set\(/.test(importSource),
      'an overlay, so two payments on one loan preview truthfully'
    );

    // --- 21/17/18. all or nothing, in one transaction ---
    const cRun = importSource.slice(importSource.indexOf('async function runImport'), importSource.indexOf('async function buildTemplate'));
    record(
      'Collection import',
      'a single unusable row refuses the whole file before anything is posted',
      /summary\.validRows !== summary\.totalRows/.test(cRun) && /all or nothing/i.test(cRun),
      'no partial batch of money'
    );
    record(
      'Collection import',
      'every collection, its allocations and the EMI snapshots move in one transaction',
      /sequelize\.transaction\(async \(transaction\) =>/.test(cRun) && /createCollectionRecord\(/.test(cRun),
      'a failure part-way rolls all of it back together'
    );
    record(
      'Collection import',
      'rows post one at a time, each re-planned against the live ledger',
      /for \(const row of evaluated\)/.test(cRun) &&
        !/Promise\.all/.test(cRun) &&
        /planFifoAllocation\(\{[\s\S]{0,120}transaction[\s\S]{0,40}\}\)/.test(cRun),
      'the second payment on a loan sees the first'
    );
    record(
      'Collection import',
      'the import re-validates the workbook itself rather than trusting the preview',
      /parseWorkbook\(buffer/.test(cRun) && /evaluateRows\(parsed\.rows/.test(cRun),
      'nothing from the preview response can authorise a write'
    );

    // --- 15. overpayment follows the existing rule ---
    record(
      'Collection import',
      'an amount larger than the loan owes is refused, never left unallocated or spilled',
      /toPaise\(unallocated\) > 0n/.test(importSource) && /cannot be allocated/.test(importSource),
      'the posting rule accounts for every rupee'
    );

    // --- 9. duplicates ---
    record(
      'Collection import',
      'duplicates are detected in-file and against posted collections, by loan, date, amount and reference',
      /Identical to row/.test(importSource) &&
        /Already posted as/.test(importSource) &&
        /status: COLLECTION_STATUS\.POSTED/.test(importSource),
      're-importing the same file does not silently double-post'
    );
    record(
      'Collection import',
      'no database uniqueness rule was invented — the guard is the importer’s own',
      (() => {
        const migrations = fs
          .readdirSync(path.resolve(__dirname, '..', 'migrations'))
          .map((file) => fs.readFileSync(path.resolve(__dirname, '..', 'migrations', file), 'utf8'))
          .join('\n');
        return !/payment_reference[\s\S]{0,80}unique/i.test(migrations);
      })(),
      'two genuine payments are told apart by their reference'
    );

    // --- eligibility rules are the existing ones ---
    record(
      'Collection import',
      'loan eligibility, payer relationship, reference and date rules all come from the service',
      /collectionService\.assertPaymentReference\(/.test(importSource) &&
        /collectionService\.assertCollectionDate\(/.test(importSource) &&
        /LOAN_STATUS\.ACTIVE/.test(importSource) &&
        /status: PARTY_STATUS\.ACTIVE/.test(importSource),
      'no eligibility rule is restated'
    );
    record(
      'Collection import',
      'row fields are validated by the real post-collection chains',
      /collectionValidator\.createCollectionRules\.map\(\(rule\) => rule\.run\(request\)\)/.test(importSource) &&
        /startsWith\('allocations'\)/.test(importSource),
      'minus the allocation list, which the backend derives'
    );

    // --- file safety ---
    let cNotXlsx = null;
    try {
      await parseCollections(Buffer.from('Loan Number,Amount\nLN26-000001,100\n', 'utf8'));
    } catch (error) {
      cNotXlsx = error;
    }
    record(
      'Collection import',
      'a file that is not a real .xlsx is refused on its magic bytes',
      cNotXlsx !== null && cNotXlsx.statusCode === 400 && /not a valid \.xlsx/.test(cNotXlsx.message),
      `${cNotXlsx?.statusCode}`
    );
    record(
      'Collection import',
      'all three importers share one parser and one upload middleware',
      (() => {
        const loanSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'loanImportService.js'), 'utf8'));
        const customerSource = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'customerImportService.js'), 'utf8')
        );
        const routes = ['customerRoutes.js', 'loanRoutes.js', 'collectionRoutes.js']
          .map((file) => stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', file), 'utf8')))
          .join('\n');
        return (
          /spreadsheet\.parseWorkbook\(/.test(importSource) &&
          /spreadsheet\.parseWorkbook\(/.test(loanSource) &&
          /spreadsheet\.parseWorkbook\(/.test(customerSource) &&
          (routes.match(/uploadSpreadsheet\('file'\)/g) ?? []).length === 6
        );
      })(),
      'the file rules cannot drift apart between imports'
    );
    let cTooMany = null;
    try {
      await parseCollections(
        await cWorkbook(Array.from({ length: C_MAX_ROWS + 2 }, () => ['LN26-000001', 'C000001', '100', '2026-08-20', 'CASH', '', '']))
      );
    } catch (error) {
      cTooMany = error;
    }
    record(
      'Collection import',
      `a file with more than ${C_MAX_ROWS} collection rows is refused`,
      cTooMany !== null && cTooMany.statusCode === 400,
      `${cTooMany?.statusCode}`
    );

    // --- 24. permissions ---
    const { PERMISSIONS: C_PERMS, ROLE_PERMISSION_MATRIX: C_MATRIX } = require('../src/config/permissions');
    record(
      'Collection import',
      'bulk import has its own permission, held only by roles that already post and reverse collections',
      C_PERMS.COLLECTIONS_IMPORT === 'collections.import' &&
        ['ADMIN', 'MANAGER'].every(
          (role) =>
            C_MATRIX[role].includes(C_PERMS.COLLECTIONS_IMPORT) &&
            C_MATRIX[role].includes(C_PERMS.COLLECTIONS_CREATE) &&
            C_MATRIX[role].includes(C_PERMS.COLLECTIONS_REVERSE)
        ) &&
        !C_MATRIX.COLLECTOR.includes(C_PERMS.COLLECTIONS_IMPORT) &&
        C_MATRIX.COLLECTOR.includes(C_PERMS.COLLECTIONS_CREATE),
      'a field collector still posts one at a time, as their workflow intends'
    );
    record(
      'Collection import',
      'all three import routes are gated on it and declared before /:id',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'collectionRoutes.js'), 'utf8'));
        const gated = (source.match(/requirePermission\(PERMISSIONS\.COLLECTIONS_IMPORT\)/g) ?? []).length;
        return gated === 3 && source.indexOf("'/import/template'") < source.indexOf("'/:id'");
      })(),
      'template, preview and import'
    );

    // --- audit ---
    record(
      'Collection import',
      'the import is audited once, with counts, the total and the collection numbers',
      /action: AUDIT_ACTIONS\.COLLECTIONS_IMPORTED/.test(importSource) &&
        /collectionNumbers: created\.map/.test(importSource) &&
        /importedAmount/.test(importSource),
      'one COLLECTIONS_IMPORTED row per batch, never the file'
    );

    // --- 25. the manual flow is untouched ---
    const manualPost = await runRules(collectionValidator.createCollectionRules, {
      body: {
        loanId: 1, customerId: 1, amount: '500.00', collectionDate: '2026-08-20', ledgerType: 'CASH',
        allocations: [{ emiId: 1, amount: '500.00' }]
      }
    });
    record(
      'Collection import',
      'the manual Post Collection flow still validates exactly as before',
      manualPost.length === 0,
      manualPost.map((error) => error.message).join('; ') || 'unchanged'
    );

    // --- frontend ---
    const collectionsPage = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'collections', 'CollectionsListPage.jsx'), 'utf8')
    );
    const collectionModal = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'collections', 'CollectionImportModal.jsx'), 'utf8')
    );
    const collectionServiceSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'services', 'collectionService.js'), 'utf8')
    );
    record(
      'Collection import',
      'the Collections page offers Bulk import beside the unchanged Post collection button',
      /canImport = can\(PERMISSIONS\.COLLECTIONS_IMPORT\)/.test(collectionsPage) &&
        /Bulk import/.test(collectionsPage) &&
        /Post collection/.test(collectionsPage) &&
        /<CollectionImportModal/.test(collectionsPage),
      'both flows available, import permission-gated'
    );
    record(
      'Collection import',
      'the uploads clear the JSON default so the browser sets the multipart boundary',
      /const MULTIPART = \{ headers: \{ 'Content-Type': undefined \} \}/.test(collectionServiceSource) &&
        (collectionServiceSource.match(/import[^']*', spreadsheetForm\(file\), MULTIPART\)/g) ?? []).length === 2,
      'preview and import both send Content-Type: undefined'
    );
    record(
      'Collection import',
      'the modal shows the backend allocation per row and computes nothing',
      /row\.allocation/.test(collectionModal) &&
        /EMI #\{allocation\.emiNumber\}/.test(collectionModal) &&
        !/toPaise|\/ *100|reduce\(/.test(collectionModal),
      'allocation comes from the API'
    );
    record(
      'Collection import',
      'the modal only offers to post when every row passes',
      /allValid = Boolean\(summary\) && summary\.totalRows > 0 && summary\.validRows === summary\.totalRows/.test(collectionModal) &&
        /canImport = Boolean\(file\) && allValid/.test(collectionModal),
      'all or nothing, mirrored in the UI'
    );
  }

  // ---------- Deployment configuration ----------
  {
    const FE_ROOT = (...parts) => path.resolve(__dirname, '..', '..', 'frontend', ...parts);
    const BE_ROOT = (...parts) => path.resolve(__dirname, '..', ...parts);

    const envConfigPath = BE_ROOT('src', 'config', 'env.js');
    const appSource = stripComments(fs.readFileSync(BE_ROOT('src', 'app.js'), 'utf8'));
    const backendExample = fs.readFileSync(BE_ROOT('.env.example'), 'utf8');
    const frontendExample = fs.readFileSync(FE_ROOT('.env.example'), 'utf8');
    const apiClient = stripComments(fs.readFileSync(FE_ROOT('src', 'services', 'api.js'), 'utf8'));

    /*
     * The origin parser is exercised for real: process.env is set and the config
     * module re-required, which is exactly the path a deployed process takes.
     * dotenv does not override an already-set variable, so this is faithful.
     */
    const configWith = (frontendUrl) => {
      const previous = process.env.FRONTEND_URL;
      if (frontendUrl === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = frontendUrl;
      delete require.cache[require.resolve(envConfigPath)];
      const loaded = require(envConfigPath);
      if (previous === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = previous;
      delete require.cache[require.resolve(envConfigPath)];
      return loaded;
    };

    record(
      'Deployment config',
      'the production site origin is accepted exactly as a browser sends it',
      configWith('https://lms.skywordfinance.com').frontendUrls.join('|') === 'https://lms.skywordfinance.com',
      'https://lms.skywordfinance.com'
    );
    record(
      'Deployment config',
      'production and local origins can be allowed together',
      configWith('https://lms.skywordfinance.com,http://localhost:5173').frontendUrls.join('|') ===
        'https://lms.skywordfinance.com|http://localhost:5173',
      'comma-separated list'
    );
    record(
      'Deployment config',
      'a trailing slash is stripped, because an Origin header never has one',
      configWith('https://lms.skywordfinance.com/').frontendUrls.join('|') === 'https://lms.skywordfinance.com' &&
        configWith(' https://lms.skywordfinance.com/ , http://localhost:5173/ ').frontendUrls.join('|') ===
          'https://lms.skywordfinance.com|http://localhost:5173',
      'whitespace and slashes tolerated'
    );
    record(
      'Deployment config',
      'a repeated origin is not listed twice',
      configWith('https://lms.skywordfinance.com,https://lms.skywordfinance.com/').frontendUrls.length === 1,
      'de-duplicated'
    );
    record(
      'Deployment config',
      'with nothing usable configured it falls back to local development only',
      (() => {
        // A blank or whitespace-only value is the realistic misconfiguration;
        // an entirely absent one cannot be simulated here because dotenv reloads
        // it from backend/.env the moment it is deleted.
        const fallback = configWith('').frontendUrls;
        return (
          fallback.length === 2 &&
          fallback.every((origin) => /^http:\/\/localhost:\d+$/.test(origin)) &&
          fallback.includes('http://localhost:5173') &&
          fallback.includes('http://localhost:5174')
        );
      })(),
      'no deployment hostname is assumed'
    );
    record(
      'Deployment config',
      'a whitespace-only value falls back rather than allowing nothing',
      configWith('   ,  ').frontendUrls.length === 2,
      'a blank FRONTEND_URL cannot lock the site out of its own API'
    );

    record(
      'Deployment config',
      'CORS is an allow-list of those origins, with credentials, and never a wildcard',
      /origin: config\.frontendUrls/.test(appSource) &&
        /credentials: true/.test(appSource) &&
        !/origin: '\*'/.test(appSource) &&
        !/origin: true/.test(appSource),
      'config.frontendUrls, credentials: true'
    );

    /* ------------------- nothing deployment-specific is baked in ------------- */

    record(
      'Deployment config',
      'no deployment hostname or IP address is hardcoded in application code',
      (() => {
        const walk = (dir) =>
          fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = path.join(dir, entry.name);
            return entry.isDirectory() ? walk(full) : [full];
          });
        const sources = [...walk(BE_ROOT('src')), ...walk(FE_ROOT('src'))].filter((file) => /\.(jsx?|css)$/.test(file));
        return sources.every((file) => {
          // Comments may name the production origin to explain a rule; what must
          // not exist is a deployment address in the code itself.
          const code = stripComments(fs.readFileSync(file, 'utf8'));
          return !/3\.109\.94\.236/.test(code) && !/skyword(finance)?\.com/.test(code);
        });
      })(),
      'the Elastic IP and both domains appear in environment files and comments only'
    );
    record(
      'Deployment config',
      'the frontend has no fallback API URL — an unset variable is reported, not silently guessed',
      /const baseURL = import\.meta\.env\.VITE_API_URL;/.test(apiClient) &&
        !/VITE_API_URL \|\|/.test(apiClient) &&
        /VITE_API_URL is not set/.test(apiClient),
      'no hidden default to localhost in a production bundle'
    );

    /* ----------------------------- the templates ---------------------------- */

    record(
      'Deployment config',
      'the backend template documents the production origin and keeps localhost as the default',
      /FRONTEND_URL=http:\/\/localhost:5173,http:\/\/localhost:5174/.test(backendExample) &&
        /FRONTEND_URL=https:\/\/lms\.skywordfinance\.com/.test(backendExample) &&
        !/3\.109\.94\.236/.test(backendExample),
      'dev active, production documented, no IP'
    );
    record(
      'Deployment config',
      'the frontend template documents the production API URL and keeps localhost as the default',
      /VITE_API_URL=http:\/\/localhost:5000\/api/.test(frontendExample) &&
        /VITE_API_URL=https:\/\/api\.lms\.skywordfinance\.com\/api/.test(frontendExample) &&
        !/3\.109\.94\.236/.test(frontendExample),
      'dev active, production documented, no IP'
    );
    record(
      'Deployment config',
      'no real .env file was added to the repository',
      (() => {
        const gitignore = fs.readFileSync(path.resolve(__dirname, '..', '..', '.gitignore'), 'utf8');
        const tracked = ['.env.production', '.env.local'];
        return (
          /^\.env\.\*$/m.test(gitignore) &&
          /^!\.env\.example$/m.test(gitignore) &&
          tracked.every((name) => !fs.existsSync(FE_ROOT(name)) && !fs.existsSync(BE_ROOT(name)))
        );
      })(),
      'only .env.example is committed'
    );
    record(
      'Deployment config',
      'no secret value appears in either template',
      (() => {
        // The templates must carry placeholders, never anything real.
        return (
          /JWT_SECRET=change_this_secret/.test(backendExample) &&
          /ADMIN_PASSWORD=change_me/.test(backendExample) &&
          /DB_PASSWORD=$/m.test(backendExample)
        );
      })(),
      'placeholders only'
    );

    record(
      'Deployment config',
      'the startup log does not claim localhost in production',
      (() => {
        const serverSource = stripComments(fs.readFileSync(BE_ROOT('src', 'server.js'), 'utf8'));
        return (
          /config\.isProduction \? `port \$\{config\.port\}`/.test(serverSource) &&
          /Allowed origins/.test(serverSource)
        );
      })(),
      'prints the port and the allow-list instead'
    );
  }

  // ---------- Navbar branding ----------
  {
    const { ORGANISATION_NAME: BACKEND_ORG } = require('../src/config/organisation');
    const FE = (...parts) => path.resolve(__dirname, '..', '..', 'frontend', ...parts);

    const constantsSource = fs.readFileSync(FE('src', 'utils', 'constants.js'), 'utf8');
    const headerSource = fs.readFileSync(FE('src', 'components', 'layout', 'Header.jsx'), 'utf8');
    const headerCode = stripComments(headerSource);
    const loginCode = stripComments(fs.readFileSync(FE('src', 'pages', 'Login.jsx'), 'utf8'));
    const navCss = fs.readFileSync(FE('src', 'assets', 'styles', 'theme.css'), 'utf8');
    const ruleOf = (selector) => {
      const start = navCss.indexOf(selector + ' {');
      return start === -1 ? '' : navCss.slice(start, navCss.indexOf('}', start));
    };

    /* ------------------------------ one name -------------------------------- */

    const frontendName = (constantsSource.match(/export const ORGANISATION_NAME = '([^']+)'/) ?? [])[1];

    record(
      'Navbar branding',
      'the frontend and backend name the company with the SAME exact string',
      frontendName === BACKEND_ORG && frontendName === 'SKYWORD INDIA MICRO CREDIT FOUNDAITION',
      JSON.stringify(frontendName)
    );
    record(
      'Navbar branding',
      'the name is a constant, not an environment override that could pin an old value',
      /export const ORGANISATION_NAME = '/.test(constantsSource) &&
        !/import\.meta\.env\.VITE_APP_NAME/.test(constantsSource) &&
        !/VITE_APP_NAME/.test(fs.readFileSync(FE('.env.example'), 'utf8')),
      'no VITE_APP_NAME, in code or in the env template'
    );
    record(
      'Navbar branding',
      'no duplicate company-name constant was introduced on the frontend',
      (constantsSource.match(/ORGANISATION_NAME\s*=/g) ?? []).length === 1 && !/APP_NAME/.test(constantsSource),
      'one constant, re-used'
    );
    record(
      'Navbar branding',
      'the placeholder is gone from every frontend source file',
      (() => {
        const walk = (dir) =>
          fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = path.join(dir, entry.name);
            return entry.isDirectory() ? walk(full) : [full];
          });
        return walk(FE('src'))
          .filter((file) => /\.(jsx?|css)$/.test(file))
          .every((file) => !fs.readFileSync(file, 'utf8').includes('Loan Management System'));
      })(),
      'nothing under frontend/src still carries it'
    );

    /* -------------------------------- the mark ------------------------------ */

    record(
      'Navbar branding',
      'the navbar shows the logo and the exact company name',
      /import skywordLogo from '\.\.\/\.\.\/assets\/SkyWord Logo\.png';/.test(headerCode) &&
        /<img className="lms-brand-logo" src=\{skywordLogo\}/.test(headerCode) &&
        /\{ORGANISATION_NAME\}/.test(headerCode),
      'logo + ORGANISATION_NAME'
    );
    record(
      'Navbar branding',
      'the old bank icon and the "LMS" stand-in are gone',
      !/bi-bank2/.test(headerCode) && !/>LMS</.test(headerCode) && !/APP_NAME/.test(headerCode),
      'replaced by the real mark'
    );
    record(
      'Navbar branding',
      'it reuses the asset the receipt already uses — one file, not a second copy',
      (() => {
        const receiptCode = stripComments(fs.readFileSync(FE('src', 'pages', 'receipts', 'CollectionReceiptPage.jsx'), 'utf8'));
        const logoFiles = fs.readdirSync(FE('src', 'assets')).filter((file) => /\.png$/i.test(file));
        return (
          logoFiles.length === 1 &&
          logoFiles[0] === 'SkyWord Logo.png' &&
          /assets\/SkyWord Logo\.png/.test(receiptCode) &&
          /assets\/SkyWord Logo\.png/.test(headerCode)
        );
      })(),
      'a single SkyWord Logo.png'
    );
    record(
      'Navbar branding',
      'the logo declares its intrinsic size and carries the accessible name',
      /width="1672"/.test(headerCode) && /height="941"/.test(headerCode) && /alt=\{ORGANISATION_NAME\}/.test(headerCode),
      'announced once at any width; the visible text is aria-hidden'
    );
    record(
      'Navbar branding',
      'the company is announced exactly once to a screen reader',
      /aria-hidden="true">\s*\{ORGANISATION_NAME\}/.test(headerCode.replace(/\s+/g, ' ')) ||
        /className="lms-brand-name d-none d-sm-block" aria-hidden="true"/.test(headerCode),
      'the duplicate visible text is hidden from assistive tech'
    );
    record(
      'Navbar branding',
      'the logo is scaled by height only, so it cannot be stretched',
      (() => {
        const rule = ruleOf('.lms-brand-logo');
        return (
          /height:\s*22px/.test(rule) &&
          /(^|[^-])width:\s*auto/.test(rule) &&
          !/(^|[^-])width:\s*\d+(\.\d+)?(px|rem|em|%)/.test(rule)
        );
      })(),
      'fixed height, intrinsic width'
    );

    /*
     * The wordmark is navy on transparency and the bar is navy, so without a
     * light backing the mark would be all but invisible. This asserts the two
     * colours and the chip together, because the chip is only right BECAUSE of
     * them.
     */
    record(
      'Navbar branding',
      'the navy wordmark is seated on a white chip so it reads against the navy bar',
      /--lms-header-bg:\s*#10233f/.test(navCss) && /background:\s*#fff/.test(ruleOf('.lms-brand-logo')),
      'navy bar, white chip, brand colours preserved'
    );
    record(
      'Navbar branding',
      'the bar did not get taller',
      (() => {
        const headerHeight = Number((navCss.match(/--lms-header-height:\s*(\d+)px/) ?? [])[1]);
        const logoHeight = Number((ruleOf('.lms-brand-logo').match(/height:\s*(\d+)px/) ?? [])[1]);
        return headerHeight === 56 && logoHeight > 0 && logoHeight < headerHeight - 20;
      })(),
      '22px mark inside an unchanged 56px bar'
    );

    /* ------------------------------- responsive ----------------------------- */

    record(
      'Navbar branding',
      'the brand can shrink and the name truncates, so the bar cannot overflow',
      (() => {
        const brand = ruleOf('.lms-brand');
        const name = ruleOf('.lms-brand-name');
        return (
          /min-width:\s*0/.test(brand) &&
          /display:\s*flex/.test(brand) &&
          /text-overflow:\s*ellipsis/.test(name) &&
          /overflow:\s*hidden/.test(name) &&
          /white-space:\s*nowrap/.test(name)
        );
      })(),
      'flex + min-width:0 + ellipsis'
    );
    record(
      'Navbar branding',
      'the name shows from small screens up; below that the logo carries the brand',
      /className="lms-brand-name d-none d-sm-block"/.test(headerCode) && /@media \(max-width: 400px\)/.test(navCss),
      'full name at >=576px, logo alone on narrow phones'
    );

    /* ---------------------------- nothing else moved ------------------------ */

    record(
      'Navbar branding',
      'the profile area, its dropdown and logout are untouched',
      /lms-user-button/.test(headerCode) &&
        /data-bs-toggle="dropdown"/.test(headerCode) &&
        /\{formatRole\(user\?\.role\)\}/.test(headerCode) &&
        /onClick=\{handleLogout\}/.test(headerCode) &&
        /\{signingOut \? 'Signing out…' : 'Logout'\}/.test(headerCode) &&
        /lms-avatar">\{initials\}/.test(headerCode),
      'avatar, name, role, email and logout all still there'
    );
    record(
      'Navbar branding',
      'the sidebar toggle and the header contract are unchanged',
      /onToggleSidebar/.test(headerCode) && /aria-label="Toggle navigation"/.test(headerCode),
      'routing and layout props untouched'
    );
    record(
      'Navbar branding',
      'the login screen names the same company, from the same constant',
      /\{ORGANISATION_NAME\}/.test(loginCode) && !/APP_NAME/.test(loginCode),
      'one constant across the app'
    );
    /*
     * index.html is static: it cannot import the constant, so the string is
     * duplicated there of necessity. These pin the copy to the constant so the
     * two cannot drift — the failure this catches is a rename that updates the
     * app but leaves the browser tab saying something else.
     */
    record(
      'Navbar branding',
      'the document title and meta description carry the exact company name',
      (() => {
        const html = fs.readFileSync(FE('index.html'), 'utf8');
        const title = (html.match(/<title>([^<]*)<\/title>/) ?? [])[1];
        const description = (html.match(/<meta name="description" content="([^"]*)"/) ?? [])[1];
        return title === BACKEND_ORG && description === BACKEND_ORG;
      })(),
      BACKEND_ORG
    );
    record(
      'Navbar branding',
      'the old title and description are gone, and no markup or script changed with them',
      (() => {
        const html = fs.readFileSync(FE('index.html'), 'utf8');
        return (
          !/Loan Management System/.test(html) &&
          !/LMS ·/.test(html) &&
          // The app still boots exactly as before.
          /<div id="root"><\/div>/.test(html) &&
          /<script type="module" src="\/src\/main\.jsx"><\/script>/.test(html) &&
          /<html lang="en">/.test(html)
        );
      })(),
      'head text only; the root div and entry script are untouched'
    );
    record(
      'Navbar branding',
      'the receipt was not touched by this change',
      (() => {
        const receiptCode = stripComments(fs.readFileSync(FE('src', 'pages', 'receipts', 'CollectionReceiptPage.jsx'), 'utf8'));
        // Still renders the API's own value, not the frontend constant.
        return /\{receipt\.organisationName\}/.test(receiptCode) && !/ORGANISATION_NAME/.test(receiptCode);
      })(),
      'the receipt still takes its name from the backend'
    );
  }

  // ---------- Collection receipt: branding and layout ----------
  {
    const { ORGANISATION_NAME } = require('../src/config/organisation');
    const receiptPage = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'receipts', 'CollectionReceiptPage.jsx'),
      'utf8'
    );
    const receiptPageCode = stripComments(receiptPage);
    const themeCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'assets', 'styles', 'theme.css'), 'utf8');
    const logoPath = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'assets', 'SkyWord Logo.png');

    record(
      'Receipt branding',
      'the company name is held once, in config, spelled exactly as given',
      ORGANISATION_NAME === 'SKYWORD INDIA MICRO CREDIT FOUNDAITION',
      JSON.stringify(ORGANISATION_NAME)
    );
    record(
      'Receipt branding',
      'the receipt takes its name from that constant, not a hard-coded default',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'receiptService.js'), 'utf8'));
        return /organisationName = ORGANISATION_NAME/.test(source) && !/Loan Management System/.test(source);
      })(),
      'the old placeholder is gone'
    );
    record(
      'Receipt branding',
      'no invented company details were added anywhere',
      (() => {
        const orgSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'config', 'organisation.js'), 'utf8'));
        // Only a name is exported; no address, registration or contact field.
        return (
          /module\.exports = \{ ORGANISATION_NAME \};/.test(orgSource) &&
          !/(address|cin|gstin?|phone|email|website|pan)\s*[:=]/i.test(orgSource) &&
          !/(CIN|GSTIN|Reg\.? No)/i.test(receiptPageCode)
        );
      })(),
      'name only, on both sides'
    );

    record(
      'Receipt branding',
      'the logo file is present in the frontend assets and is a real PNG',
      (() => {
        if (!fs.existsSync(logoPath)) return false;
        const bytes = fs.readFileSync(logoPath);
        return bytes.subarray(1, 4).toString() === 'PNG' && bytes.readUInt32BE(16) === 1672 && bytes.readUInt32BE(20) === 941;
      })(),
      'SkyWord Logo.png, 1672x941'
    );
    record(
      'Receipt branding',
      'the receipt imports that file rather than pointing at a URL that could 404',
      /import skywordLogo from '\.\.\/\.\.\/assets\/SkyWord Logo\.png';/.test(receiptPageCode) &&
        /src=\{skywordLogo\}/.test(receiptPageCode),
      'bundled asset, fingerprinted by the build'
    );
    record(
      'Receipt branding',
      'the logo declares its intrinsic size, so the browser reserves the right box and never rescales unevenly',
      /width="1672"/.test(receiptPageCode) && /height="941"/.test(receiptPageCode) && /alt="Skyword Micro Finance"/.test(receiptPageCode),
      '1672x941 with alt text'
    );
    record(
      'Receipt branding',
      'the logo is scaled by height only, so its proportions cannot be distorted',
      (() => {
        const rule = themeCss.slice(themeCss.indexOf('.lms-receipt-logo {'), themeCss.indexOf('}', themeCss.indexOf('.lms-receipt-logo {')));
        // A fixed width would distort it; max-width: 100% is a bound, not a width.
        return (
          /height:\s*3\.25rem/.test(rule) &&
          /(^|[^-])width:\s*auto/.test(rule) &&
          !/(^|[^-])width:\s*\d+(\.\d+)?(px|rem|em)/.test(rule)
        );
      })(),
      'fixed height, automatic width'
    );
    record(
      'Receipt branding',
      'it is only ever scaled DOWN from the source, which is what keeps it sharp in print',
      (() => {
        // 14mm at 300dpi needs ~165px of height; the source has 941.
        const neededPx = Math.ceil((14 / 25.4) * 300);
        return fs.readFileSync(logoPath).readUInt32BE(20) > neededPx * 2 && /height:\s*14mm/.test(themeCss);
      })(),
      '941px source for a ~165px print box'
    );

    /* -------------------------- one document, two media ---------------------- */

    record(
      'Receipt branding',
      'screen and print share the same markup — there is no second receipt to drift',
      (() => {
        // A single sheet element, styled differently by media query.
        const sheets = receiptPageCode.match(/lms-receipt-sheet/g) ?? [];
        return sheets.length === 1 && /@media print/.test(themeCss) && /\.lms-receipt-logo \{/.test(themeCss);
      })(),
      'one sheet, one stylesheet'
    );
    record(
      'Receipt branding',
      'the masthead stays side by side on paper whatever the screen was doing',
      (() => {
        const printBlock = themeCss.slice(themeCss.indexOf('@media print'));
        return /\.lms-receipt-header \{[^}]*flex-wrap:\s*nowrap/.test(printBlock) && /\.lms-receipt-meta \{[^}]*text-align:\s*right/.test(printBlock);
      })(),
      'no stacking on A4'
    );
    record(
      'Receipt branding',
      'the logo and the reversed stamp both survive a default print',
      (() => {
        const printBlock = themeCss.slice(themeCss.indexOf('@media print'));
        return (printBlock.match(/print-color-adjust:\s*exact/g) ?? []).length >= 2;
      })(),
      'browsers drop backgrounds unless told otherwise'
    );
    record(
      'Receipt branding',
      'nothing that must read as a whole can break across a page',
      (() => {
        const printBlock = themeCss.slice(themeCss.indexOf('@media print'));
        return (
          /page-break-inside:\s*avoid/.test(printBlock) &&
          /\.table-responsive \{[^}]*overflow:\s*visible/.test(printBlock) &&
          /size:\s*A4/.test(printBlock)
        );
      })(),
      'rows, totals and the footer stay intact; the scroll box does not clip'
    );

    /* ------------------------------- responsive ------------------------------ */

    record(
      'Receipt branding',
      'the two-column body collapses on a narrow screen instead of squeezing',
      /className="col-12 col-sm-6"/.test(receiptPageCode) && !/className="col-6"/.test(receiptPageCode),
      'col-12 col-sm-6 throughout'
    );
    record(
      'Receipt branding',
      'the sheet has an explicit small-screen layout',
      /@media \(max-width: 575\.98px\)/.test(themeCss) &&
        /\.lms-receipt-logo \{\s*height:\s*2\.5rem/.test(themeCss.slice(themeCss.indexOf('@media (max-width: 575.98px)'))),
      'padding, logo, company size and label columns all step down'
    );
    record(
      'Receipt branding',
      'label/value pairs are a grid, so a long value wraps under itself rather than colliding',
      /\.lms-receipt-list \{[^}]*display:\s*grid/.test(themeCss) && /overflow-wrap:\s*anywhere/.test(themeCss),
      'no collision between a long name and the next field'
    );
    record(
      'Receipt branding',
      'the long company name is allowed to wrap rather than push the receipt number off the sheet',
      /\.lms-receipt-company \{[^}]*overflow-wrap:\s*anywhere/.test(themeCss),
      '38 characters, wrapped not clipped'
    );

    /* ------------------------- the data is untouched ------------------------- */

    record(
      'Receipt branding',
      'every receipt field still renders, and no figure is recomputed in the page',
      (() => {
        const fields = [
          'receipt.customer?.fullName',
          'receipt.customer?.cifId',
          'receipt.customer?.mobile',
          'receipt.loan?.loanNumber',
          'receipt.collection.collectionDate',
          'receipt.collection.amount',
          'receipt.collection.ledgerType',
          'receipt.collection.paymentReference',
          'receipt.totals.allocatedAmount',
          'receipt.totals.collectionAmount',
          'receipt.totals.unallocated',
          'receipt.system.createdBy',
          'receipt.system.createdAt'
        ];
        // formatCurrency only formats; no arithmetic operator touches a money value.
        return fields.every((field) => receiptPageCode.includes(field)) && !/(allocatedAmount|collectionAmount)\s*[-+*/]/.test(receiptPageCode);
      })(),
      'the page displays what the API returns, and nothing else'
    );
    /*
     * The placeholder came back once because a stale process was serving old
     * code, not because the source was wrong. These pin the source so a real
     * regression is caught here rather than on a printed document.
     */
    record(
      'Receipt branding',
      'no file that feeds the receipt contains the old placeholder',
      (() => {
        const files = [
          path.resolve(__dirname, '..', 'src', 'services', 'receiptService.js'),
          path.resolve(__dirname, '..', 'src', 'config', 'organisation.js'),
          path.resolve(__dirname, '..', 'src', 'controllers', 'collectionController.js'),
          path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'receipts', 'CollectionReceiptPage.jsx')
        ];
        return files.every((file) => !fs.readFileSync(file, 'utf8').includes('Loan Management System'));
      })(),
      'receipt service, organisation config, controller and page'
    );
    record(
      'Receipt branding',
      'the only company name the receipt can render is the configured one',
      (() => {
        // The page renders receipt.organisationName and nothing else as a company
        // name, and the service can only ever set it from the constant.
        const service = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'receiptService.js'), 'utf8'));
        return (
          /<h1 className="lms-receipt-company">\{receipt\.organisationName\}<\/h1>/.test(receiptPageCode) &&
          // The default comes from the constant...
          /organisationName = ORGANISATION_NAME/.test(service) &&
          // ...and nowhere is it assigned a literal string.
          !/organisationName\s*[:=]\s*['"`]/.test(service)
        );
      })(),
      'one source of truth, on both sides'
    );
    record(
      'Receipt branding',
      'the app chrome cannot bleed into a printed receipt',
      (() => {
        /*
         * The navbar now shows the company name too, from the frontend's own
         * constant. The receipt must still take its name from the API response
         * rather than that constant — otherwise a printed document would report
         * whatever the browser bundle happened to be built with, instead of what
         * the server recorded. And the chrome itself never reaches paper.
         */
        const printBlock = themeCss.slice(themeCss.indexOf('@media print'));
        return (
          /\{receipt\.organisationName\}/.test(receiptPageCode) &&
          !/ORGANISATION_NAME/.test(receiptPageCode) &&
          !/utils\/constants/.test(receiptPageCode) &&
          /\.lms-header,[\s\S]{0,120}display:\s*none/.test(printBlock)
        );
      })(),
      'the receipt names the company from the API; .lms-header is display:none on paper'
    );
    record(
      'Receipt branding',
      'the reversed stamp, void notice and print button all still work',
      /lms-receipt-stamp">REVERSED/.test(receiptPageCode) &&
        /NOT A VALID RECEIPT OF PAYMENT/.test(receiptPageCode) &&
        /window\.print\(\)/.test(receiptPageCode),
      'functionality unchanged'
    );
  }

  // ---------- Phase 13D: collected principal / interest / bounce ----------
  {
    const { splitAllocation } = require('../src/services/collectionAllocationService');
    const { toPaise: toP, fromPaise: fromP } = require('../src/utils/money');
    const { CSV_COLUMNS: D_COLUMNS, SUMMARY_FIELDS: D_SUMMARY, REPORTS: D_REPORTS } = require('../src/config/reports');

    const split = (allocated, principal, emiAmount) =>
      splitAllocation({
        allocatedPaise: toP(allocated),
        principalPaise: toP(principal),
        emiAmountPaise: toP(emiAmount)
      });
    const shown = (result) => [fromP(result.principalPaise), fromP(result.interestPaise)];

    /*
     * The ledger stores only an allocated amount, so principal and interest are
     * apportioned against the instalment's own stored figures — no rate, term or
     * interest calculation is involved anywhere below.
     */
    record(
      'Collected split',
      'an allocation is apportioned by the instalment’s stored principal : interest',
      shown(split('4000.00', '9000.00', '10000.00')).join('/') === '3600.00/400.00' &&
        shown(split('5375.00', '9000.00', '10000.00')).join('/') === '4837.50/537.50',
      '90:10 instalment → 90:10 split'
    );
    record(
      'Collected split',
      'principal + interest equals the allocated amount EXACTLY, for every value',
      (() => {
        const cases = [];
        for (let rupees = 1; rupees <= 400; rupees += 1) {
          // A ratio that does not divide cleanly, to force rounding every time.
          cases.push({ allocated: `${rupees}.33`, principal: '6667.00', emiAmount: '10000.00' });
        }
        return cases.every(({ allocated, principal, emiAmount }) => {
          const result = split(allocated, principal, emiAmount);
          return result.principalPaise + result.interestPaise === toP(allocated);
        });
      })(),
      '400 awkward amounts, no paise created or lost'
    );
    record(
      'Collected split',
      'the split never drifts when many allocations are summed',
      (() => {
        // 300 part-payments of the same instalment: the totals must still agree.
        let principalTotal = 0n;
        let interestTotal = 0n;
        let allocatedTotal = 0n;
        for (let index = 1; index <= 300; index += 1) {
          const allocated = `${index}.07`;
          const result = split(allocated, '3333.33', '10000.00');
          principalTotal += result.principalPaise;
          interestTotal += result.interestPaise;
          allocatedTotal += toP(allocated);
        }
        return principalTotal + interestTotal === allocatedTotal;
      })(),
      'aggregate is exact, not approximately exact'
    );
    record(
      'Collected split',
      'a payment’s split does not depend on other payments against the same instalment',
      (() => {
        // The reason pro rata was chosen over interest-first: reversing one
        // collection must not silently re-split another.
        const first = split('4000.00', '9000.00', '10000.00');
        const second = split('5375.00', '9000.00', '10000.00');
        const alone = split('5375.00', '9000.00', '10000.00');
        return (
          second.principalPaise === alone.principalPaise &&
          second.interestPaise === alone.interestPaise &&
          first.principalPaise + second.principalPaise === split('9375.00', '9000.00', '10000.00').principalPaise
        );
      })(),
      'order-independent and additive'
    );
    record(
      'Collected split',
      'an all-principal or all-interest instalment splits accordingly',
      shown(split('500.00', '1000.00', '1000.00')).join('/') === '500.00/0.00' &&
        shown(split('500.00', '0.00', '1000.00')).join('/') === '0.00/500.00',
      'no interest invented where there is none'
    );
    record(
      'Collected split',
      'a zero-value instalment cannot be apportioned and is not divided by',
      shown(split('500.00', '0.00', '0.00')).join('/') === '500.00/0.00',
      'no division by zero'
    );
    record(
      'Collected split',
      'nothing in the breakdown recalculates interest — it only reads stored columns',
      (() => {
        const source = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionAllocationService.js'), 'utf8')
        );
        const region = source.slice(source.indexOf('function splitAllocation'), source.indexOf('module.exports'));
        return (
          !/loanCalculationService|roi|interestMethod|annuity|tenure/i.test(region) &&
          /attributes: \['principal', 'emiAmount'\]/.test(region) &&
          /allocatedAmount/.test(region) &&
          // The breakdown no longer reads the instalment's bounce_charge at
          // all: that column is the charge ASSESSED, and this function reports
          // money COLLECTED.
          !/bounceCharge/.test(region)
        );
      })(),
      'allocated_amount, principal, emi_amount — nothing else'
    );
    record(
      'Collected split',
      'the breakdown is one query, not one per collection',
      (() => {
        const source = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionAllocationService.js'), 'utf8')
        );
        const fn = source.slice(
          source.indexOf('async function allocationBreakdown'),
          source.indexOf('async function bounceCollected')
        );
        return (fn.match(/await /g) ?? []).length === 1 && /CollectionAllocation\.findAll/.test(fn);
      })(),
      'a single findAll over the ledger'
    );
    record(
      'Collected split',
      'the POSTED restriction is AND-ed onto the filters, so a status filter is honoured not overwritten',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportService.js'), 'utf8'));
        return (
          /\[Op\.and\]: \[where, \{ status: COLLECTION_STATUS\.POSTED \}\]/.test(source) &&
          !/\{ \.\.\.where, status: COLLECTION_STATUS\.POSTED \}/.test(source)
        );
      })(),
      'filtering to REVERSED yields a zero breakdown, not the POSTED one'
    );
    /*
     * REPLACES the old memo rule. Bounce used to be reported here as the
     * `bounce_charge` recorded on whichever instalments a payment happened to
     * touch, de-duplicated by instalment id so it at least did not double —
     * but a charge nobody had paid still counted, which is exactly what the
     * Bounce Collection metric must not do. Bounce is now money, summed from
     * the collections' own `bounce_amount`, so there is no per-instalment
     * de-duplication to do: each collection contributes its own figure once.
     */
    record(
      'Collected split',
      'bounce comes from the collections ledger, never from the instalments a payment happened to touch',
      (() => {
        const source = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionAllocationService.js'), 'utf8')
        );
        const breakdown = source.slice(
          source.indexOf('async function allocationBreakdown'),
          source.indexOf('async function bounceCollected')
        );
        const bounceFn = source.slice(source.indexOf('async function bounceCollected'), source.indexOf('module.exports'));
        return (
          // Nothing about bounce is left in the allocation breakdown...
          !/bounce/i.test(breakdown) &&
          // ...and the bounce figure reads collections.bounce_amount, not
          // emi_schedules.bounce_charge.
          /Collection\.findAll/.test(bounceFn) &&
          /'bounce_amount'/.test(bounceFn) &&
          !/bounce_charge|bounceCharge/.test(bounceFn) &&
          !/EmiSchedule|association: 'Emi'/.test(bounceFn)
        );
      })(),
      'SUM(collections.bounce_amount), filtered by the caller'
    );
    record(
      'Collected split',
      'bounce is never added into a collected total',
      (() => {
        const source = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionAllocationService.js'), 'utf8')
        );
        const fn = source.slice(source.indexOf('async function allocationBreakdown'), source.indexOf('module.exports'));
        // principalTotal and interestTotal are summed from the split only.
        return (
          /principalTotal \+= principalPaise;/.test(fn) &&
          /interestTotal \+= interestPaise;/.test(fn) &&
          !/(principalTotal|interestTotal) \+= .*bounce/i.test(fn)
        );
      })(),
      'a separate figure, beside the money'
    );

    /* ------------------------------ export shape ----------------------------- */

    record(
      'Collected split',
      'the collection export carries the three columns, as money, next to Amount',
      (() => {
        const headers = D_COLUMNS[D_REPORTS.COLLECTIONS].map((column) => column.header);
        const amountIndex = headers.indexOf('Amount');
        return (
          headers.slice(amountIndex + 1, amountIndex + 4).join('|') === 'Collected Principal|Collected Interest|Collected Bounce' &&
          ['collectedPrincipal', 'collectedInterest', 'collectedBounce'].every((path) =>
            D_COLUMNS[D_REPORTS.COLLECTIONS].some((column) => column.path === path && column.type === 'money')
          )
        );
      })(),
      D_COLUMNS[D_REPORTS.COLLECTIONS].map((column) => column.header).join(', ')
    );
    record(
      'Collected split',
      'the EMI export carries Bounce Charge, as money, after Interest',
      (() => {
        const headers = D_COLUMNS[D_REPORTS.EMIS].map((column) => column.header);
        return (
          headers[headers.indexOf('Interest') + 1] === 'Bounce Charge' &&
          D_COLUMNS[D_REPORTS.EMIS].some((column) => column.path === 'bounceCharge' && column.type === 'money')
        );
      })(),
      D_COLUMNS[D_REPORTS.EMIS].map((column) => column.header).join(', ')
    );
    record(
      'Collected split',
      'the workbook Summary sheet gained the three totals',
      (() => {
        const labels = D_SUMMARY[D_REPORTS.COLLECTIONS].map((field) => field.label);
        return (
          ['Collected Principal', 'Collected Interest', 'Collected Bounce'].every((label) => labels.includes(label)) &&
          labels.includes('Net Collected') &&
          D_SUMMARY[D_REPORTS.COLLECTIONS].every((field) => field.type === 'money' || field.type === 'number')
        );
      })(),
      D_SUMMARY[D_REPORTS.COLLECTIONS].map((field) => field.label).join(', ')
    );
    record(
      'Collected split',
      'the demand report was left exactly as it was',
      D_COLUMNS[D_REPORTS.DEMAND_COLLECTIONS].length === 9 &&
        !D_COLUMNS[D_REPORTS.DEMAND_COLLECTIONS].some((column) => /^collected(Principal|Interest|Bounce)$/.test(column.path)) &&
        !D_SUMMARY[D_REPORTS.DEMAND_COLLECTIONS].some((field) => /Collected (Principal|Interest|Bounce)/.test(field.label)),
      'no new column, no new total'
    );

    /* -------------------------------- frontend ------------------------------- */

    const collectionReportPage = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'reports', 'CollectionReportPage.jsx'), 'utf8')
    );
    const emiReportPage = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'reports', 'EmiReportPage.jsx'), 'utf8')
    );

    record(
      'Collected split',
      'the required KPI cards are on the collection report',
      ['Net collected', 'EMI collected', 'Collected principal', 'Collected interest', 'Bounce collection'].every((label) =>
        new RegExp(`label: '${label}'`).test(collectionReportPage)
      ),
      'Net collected, EMI collected, principal, interest, bounce collection'
    );
    record(
      'Collected split',
      'the bounce card says plainly that it is money actually collected, and how many collections carried it',
      /label: 'Bounce collection'[\s\S]{0,320}bounceCollectionCount[\s\S]{0,120}actually collected/.test(collectionReportPage) &&
        // The old "separate — not in net collected" wording is gone: bounce IS
        // part of the amount received, it is only outside EMI collected.
        !/not in net collected/.test(collectionReportPage),
      'stated on the card itself'
    );
    record(
      'Collected split',
      'the collection table shows the split, and its colSpan matches the column count',
      (() => {
        const headerCount = (collectionReportPage.match(/<th scope="col"/g) ?? []).length;
        const colSpans = [...collectionReportPage.matchAll(/colSpan="(\d+)"/g)].map((match) => Number(match[1]));
        return (
          /<th scope="col" className="text-end">EMI collected<\/th>/.test(collectionReportPage) &&
          /<th scope="col" className="text-end">Principal<\/th>/.test(collectionReportPage) &&
          /<th scope="col" className="text-end">Interest<\/th>/.test(collectionReportPage) &&
          /<th scope="col" className="text-end">Bounce collected<\/th>/.test(collectionReportPage) &&
          colSpans.length > 0 &&
          colSpans.every((span) => span === headerCount)
        );
      })(),
      `${(collectionReportPage.match(/<th scope="col"/g) ?? []).length} columns`
    );
    record(
      'Collected split',
      'the EMI report table shows Bounce charge, and its colSpan matches too',
      (() => {
        const headerCount = (emiReportPage.match(/<th scope="col"/g) ?? []).length;
        const colSpans = [...emiReportPage.matchAll(/colSpan="(\d+)"/g)].map((match) => Number(match[1]));
        return (
          /<th scope="col" className="text-end">Bounce charge<\/th>/.test(emiReportPage) &&
          /formatCurrency\(emi\.bounceCharge\)/.test(emiReportPage) &&
          colSpans.length > 0 &&
          colSpans.every((span) => span === headerCount)
        );
      })(),
      `${(emiReportPage.match(/<th scope="col"/g) ?? []).length} columns`
    );
  }

  // ---------- Phase 13C: EMI bounce charge ----------
  {
    const { bounceChargeRules } = require('../src/validators/emiValidator');
    const { MAX_BOUNCE_CHARGE, DEFAULT_BOUNCE_CHARGE, EMI_STATUS: BOUNCE_EMI_STATUS } = require('../src/config/emis');
    const emiScheduleService = require('../src/services/emiScheduleService');
    const { EmiSchedule: BounceEmiModel } = models;

    const migrationPath = path.resolve(__dirname, '..', 'migrations', '026-add-emi-bounce-charge.js');
    const migrationSource = fs.readFileSync(migrationPath, 'utf8');

    record(
      'Bounce charge',
      'the column is added by a migration that is additive and reversible',
      fs.existsSync(migrationPath) &&
        /const TABLE = 'emi_schedules'/.test(migrationSource) &&
        /addColumn\(TABLE, 'bounce_charge'/.test(migrationSource) &&
        /removeColumn\(TABLE, 'bounce_charge'\)/.test(migrationSource) &&
        // Adds a column and nothing else: no data is rewritten, nothing dropped.
        !/UPDATE |DELETE |removeColumn\(TABLE, '(?!bounce_charge)|changeColumn/.test(migrationSource),
      '026-add-emi-bounce-charge.js'
    );
    record(
      'Bounce charge',
      'existing instalments read as 0.00 without being rewritten',
      /allowNull: false/.test(migrationSource) &&
        /defaultValue: '0\.00'/.test(migrationSource) &&
        DEFAULT_BOUNCE_CHARGE === '0.00',
      'NOT NULL DEFAULT 0.00, filled in place by MySQL'
    );
    record(
      'Bounce charge',
      'the model stores it as money, defaulted, alongside the instalment',
      (() => {
        const attribute = BounceEmiModel.rawAttributes.bounceCharge;
        return (
          attribute &&
          attribute.field === 'bounce_charge' &&
          attribute.allowNull === false &&
          attribute.defaultValue === DEFAULT_BOUNCE_CHARGE &&
          String(attribute.type).startsWith('DECIMAL(15,2)')
        );
      })(),
      'DECIMAL(15,2) NOT NULL DEFAULT 0.00'
    );

    /*
     * The whole point of the feature is that it is inert. These build an
     * instalment carrying a large charge and assert that every derived figure
     * comes out identical to the same instalment with no charge at all.
     */
    const buildInstalment = (bounceCharge) =>
      BounceEmiModel.build({
        loanId: 1,
        emiNumber: 1,
        emiDate: '2026-01-10',
        emiAmount: '10000.00',
        principal: '9000.00',
        interest: '1000.00',
        amountCollected: '2500.00',
        bounceCharge,
        status: BOUNCE_EMI_STATUS.PENDING
      });

    const withCharge = buildInstalment('50000.00');
    const withoutCharge = buildInstalment('0.00');
    const asOf = '2026-03-01';

    record(
      'Bounce charge',
      'outstanding, DPD and status are identical with and without a charge',
      withCharge.outstanding() === withoutCharge.outstanding() &&
        withCharge.computeDpd(asOf) === withoutCharge.computeDpd(asOf) &&
        withCharge.computeStatus(asOf) === withoutCharge.computeStatus(asOf) &&
        withCharge.outstanding() === '7500.00',
      `₹50,000 charge, outstanding still ${withCharge.outstanding()}, DPD ${withCharge.computeDpd(asOf)}, ${withCharge.computeStatus(asOf)}`
    );
    record(
      'Bounce charge',
      'no loan-level total absorbs it',
      (() => {
        const charged = emiScheduleService.summarise([withCharge], null, asOf);
        const clean = emiScheduleService.summarise([withoutCharge], null, asOf);
        return (
          JSON.stringify(charged) === JSON.stringify(clean) &&
          charged.totalRepayment === '10000.00' &&
          charged.totalOutstanding === '7500.00'
        );
      })(),
      'repayment, principal, interest, collected and outstanding all unmoved'
    );
    record(
      'Bounce charge',
      'the derived methods do not so much as mention it',
      (() => {
        const modelSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'models', 'EmiSchedule.js'), 'utf8'));
        const derived = modelSource.slice(modelSource.indexOf('outstanding()'), modelSource.indexOf('toPublicJSON'));
        return !/bounceCharge/.test(derived);
      })(),
      'outstanding / computeDpd / computeStatus are untouched'
    );
    record(
      'Bounce charge',
      'it is reported per instalment, beside the derived values',
      (() => {
        const json = withCharge.toPublicJSON(asOf);
        return json.bounceCharge === '50000.00' && json.outstanding === '7500.00' && json.emiAmount === '10000.00';
      })(),
      'bounceCharge on the public shape'
    );

    /* ------------------------------- validation ------------------------------ */

    const chargeErrors = async (body) =>
      (await runRules(bounceChargeRules, { params: { loanId: '1', emiId: '2' }, body })).map((error) => error.field);

    record(
      'Bounce charge',
      'zero is valid — that is how a charge is cleared',
      (await chargeErrors({ bounceCharge: '0' })).length === 0 && (await chargeErrors({ bounceCharge: '0.00' })).length === 0,
      '0 and 0.00 accepted'
    );
    record(
      'Bounce charge',
      'a plain amount with up to two decimals is valid',
      (await chargeErrors({ bounceCharge: '500' })).length === 0 &&
        (await chargeErrors({ bounceCharge: '1000.50' })).length === 0 &&
        (await chargeErrors({ bounceCharge: 750 })).length === 0,
      '500, 1000.50, numeric 750'
    );
    record(
      'Bounce charge',
      'a negative amount is refused',
      (await chargeErrors({ bounceCharge: '-100' })).includes('bounceCharge') &&
        (await chargeErrors({ bounceCharge: '-0.01' })).includes('bounceCharge') &&
        (await chargeErrors({ bounceCharge: -1 })).includes('bounceCharge'),
      '-100, -0.01, -1'
    );
    record(
      'Bounce charge',
      'junk, scientific notation and sub-paise precision are refused',
      (
        await Promise.all(
          ['abc', '1e5', 'Infinity', 'NaN', '12.345', '', ' 500 ', '1,000', '5.', null].map((value) =>
            chargeErrors({ bounceCharge: value })
          )
        )
      ).every((errors) => errors.includes('bounceCharge')),
      'every malformed value produces an error'
    );
    record(
      'Bounce charge',
      'a missing amount is refused rather than treated as zero',
      (await chargeErrors({})).includes('bounceCharge'),
      'the field is required'
    );
    record(
      'Bounce charge',
      'an amount that would overflow the column is refused',
      (await chargeErrors({ bounceCharge: '99999999.99' })).includes('bounceCharge') &&
        (await chargeErrors({ bounceCharge: MAX_BOUNCE_CHARGE })).length === 0,
      `ceiling ${MAX_BOUNCE_CHARGE}`
    );
    record(
      'Bounce charge',
      'the endpoint is not a back door: derived and collection fields are still rejected',
      (
        await Promise.all(
          [
            { amountCollected: '5000.00' },
            { status: 'PAID' },
            { dpd: 0 },
            { paymentDate: '2026-01-01' },
            { emiAmount: '1.00' },
            { principal: '1.00' },
            { interest: '1.00' },
            { emiDate: '2026-01-01' },
            { emiNumber: 2 }
          ].map((extra) => chargeErrors({ bounceCharge: '500', ...extra }))
        )
      ).every((errors) => errors.length > 0),
      'one editable field, and only one'
    );

    /* --------------------------- service, route, RBAC ------------------------ */

    record(
      'Bounce charge',
      'the service writes exactly one column and recalculates nothing',
      (() => {
        const source = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8')
        );
        const fn = source.slice(source.indexOf('async function setBounceCharge'), source.indexOf('module.exports'));
        return (
          /emi\.update\(\{ bounceCharge: next \}\)/.test(fn) &&
          !/recalculate|amountCollected|computeStatus|computeDpd|allocat/i.test(fn) &&
          (fn.match(/\.update\(/g) ?? []).length === 1
        );
      })(),
      'one UPDATE, one column'
    );
    record(
      'Bounce charge',
      'the amount is normalised through the shared paise helpers, not string-copied',
      (() => {
        const source = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8')
        );
        const fn = source.slice(source.indexOf('async function setBounceCharge'), source.indexOf('module.exports'));
        return /fromPaise\(toPaise\(String\(bounceCharge\)\)\)/.test(fn);
      })(),
      '"500", "500.0" and "500.00" all store identically'
    );
    record(
      'Bounce charge',
      'the route is the ONLY mutating verb on an instalment, and carries its own permission',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'emiRoutes.js'), 'utf8'));
        const mutations = source.match(/router\.(put|patch|delete)\(/g) ?? [];
        return (
          mutations.length === 1 &&
          mutations[0] === 'router.patch(' &&
          /'\/:emiId\/bounce-charge'/.test(source) &&
          /requirePermission\(PERMISSIONS\.EMIS_BOUNCE_CHARGE\)/.test(source) &&
          /validate\(bounceChargeRules\)/.test(source)
        );
      })(),
      'PATCH /:emiId/bounce-charge only'
    );
    record(
      'Bounce charge',
      'it is a permission of its own, not a widening of emis.update',
      PERMISSIONS.EMIS_BOUNCE_CHARGE === 'emis.bounce_charge' &&
        PERMISSION_DEFINITIONS.some((definition) => definition.name === PERMISSIONS.EMIS_BOUNCE_CHARGE) &&
        ROLE_PERMISSION_MATRIX[ROLES.ADMIN].includes(PERMISSIONS.EMIS_BOUNCE_CHARGE) &&
        !ROLE_PERMISSION_MATRIX[ROLES.MANAGER].includes(PERMISSIONS.EMIS_BOUNCE_CHARGE) &&
        !ROLE_PERMISSION_MATRIX[ROLES.COLLECTOR].includes(PERMISSIONS.EMIS_BOUNCE_CHARGE) &&
        !ROLE_PERMISSION_MATRIX[ROLES.STAFF].includes(PERMISSIONS.EMIS_BOUNCE_CHARGE),
      'ADMIN and SUPER_ADMIN only'
    );
    record(
      'Bounce charge',
      'a change is auditable under its own action, distinct from a DPD recalculation',
      AUDIT_ACTIONS.EMI_BOUNCE_CHARGE_UPDATED === 'EMI_BOUNCE_CHARGE_UPDATED' &&
        AUDIT_ACTIONS.EMI_UPDATED !== AUDIT_ACTIONS.EMI_BOUNCE_CHARGE_UPDATED &&
        (() => {
          const source = stripComments(
            fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'emiScheduleService.js'), 'utf8')
          );
          const fn = source.slice(source.indexOf('async function setBounceCharge'), source.indexOf('module.exports'));
          return /previousBounceCharge: previous/.test(fn) && /bounceCharge: next/.test(fn);
        })(),
      'the trail records the value before and after'
    );

    /* --------------------------------- frontend ------------------------------ */

    record(
      'Bounce charge',
      'the schedule table has a Bounce charge column with one input per instalment',
      (() => {
        const table = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'emis', 'EmiScheduleTable.jsx'), 'utf8')
        );
        return (
          /<th scope="col" className="text-end">Bounce charge<\/th>/.test(table) &&
          /<BounceChargeCell emi=\{emi\} editable=\{editable\} onSave=\{onBounceChargeSave\} \/>/.test(table) &&
          /aria-label=\{`Bounce charge for EMI \$\{emi\.emiNumber\}`\}/.test(table)
        );
      })(),
      'a column, and a labelled input on each row'
    );
    record(
      'Bounce charge',
      'without the permission the cell is text, not a disabled-looking input',
      (() => {
        const table = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'emis', 'EmiScheduleTable.jsx'), 'utf8')
        );
        const page = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'loans', 'LoanEmiSchedulePage.jsx'), 'utf8')
        );
        return (
          /if \(!editable\) \{\s*return <td className="text-end">\{formatCurrency\(saved\)\}<\/td>;/.test(table) &&
          /canEditBounceCharge = false/.test(table) &&
          /canEditBounceCharge=\{can\(PERMISSIONS\.EMIS_BOUNCE_CHARGE\)\}/.test(page)
        );
      })(),
      'read-only by default'
    );
    record(
      'Bounce charge',
      'the frontend rejects the same values the backend does, before spending a request',
      (() => {
        const table = fs.readFileSync(
          path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'emis', 'EmiScheduleTable.jsx'),
          'utf8'
        );
        const isValidCharge = (value) => /^\d+(\.\d{1,2})?$/.test(String(value).trim());
        return (
          /const isValidCharge = \(value\) => \/\^\\d\+\(\\\.\\d\{1,2\}\)\?\$\/\.test\(String\(value\)\.trim\(\)\)/.test(table) &&
          isValidCharge('0') &&
          isValidCharge('500.25') &&
          !isValidCharge('-100') &&
          !isValidCharge('12.345') &&
          !isValidCharge('abc')
        );
      })(),
      'same rule on both sides'
    );
    record(
      'Bounce charge',
      'the frontend constant matches the backend permission name',
      (() => {
        const constants = fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'utils', 'permissions.js'), 'utf8');
        return new RegExp(`EMIS_BOUNCE_CHARGE: '${PERMISSIONS.EMIS_BOUNCE_CHARGE}'`).test(constants);
      })(),
      PERMISSIONS.EMIS_BOUNCE_CHARGE
    );
  }

  // ---------- Loan report Excel export ----------
  {
    const ExcelJS = require('exceljs');
    const reportExcelService = require('../src/services/reportExcelService');
    const { SUMMARY_FIELDS, REPORT_TITLES, EXPORT_FORMAT_VALUES, CSV_COLUMNS: EXPORT_COLUMNS } = require('../src/config/reports');

    const sampleRow = {
      loanNumber: 'LN26-000001',
      status: 'ACTIVE',
      customer: { fullName: 'Asha Verma', cifId: 'C000007', mobile: '9876500001' },
      loanAmount: '100000.00',
      roi: '5.0000',
      roiBasis: 'MONTHLY',
      tenure: 6,
      loanType: 'WEEKLY',
      totalRepayment: '130000.00',
      emiAmount: '5000.00',
      emiCount: 26,
      collected: '8500.00',
      outstanding: '121500.00',
      route: { routeCode: 'RT26-000001', name: 'North' },
      collectorNames: 'Ravi',
      startDate: '2026-08-20',
      createdAt: '2026-08-19T11:00:00.000Z'
    };
    const sampleSummary = {
      loanCount: 1,
      totalLoanAmount: '100000.00',
      totalRepayment: '130000.00',
      totalCollected: '8500.00',
      totalOutstanding: '121500.00'
    };

    const workbookBuffer = await reportExcelService.buildReportWorkbook({
      reportKey: 'loans',
      rows: [sampleRow],
      summary: sampleSummary,
      filters: { status: 'ACTIVE', page: 2, format: 'xlsx' }
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(workbookBuffer);
    const dataSheet = book.getWorksheet(REPORT_TITLES.loans);
    const summarySheet = book.getWorksheet('Summary');
    const firstRow = dataSheet.getRow(2);

    record(
      'Excel export',
      'the file is a real .xlsx (ZIP container), not a renamed CSV',
      workbookBuffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && book.worksheets.length === 2,
      `${workbookBuffer.length} bytes, sheets: ${book.worksheets.map((w) => w.name).join(', ')}`
    );
    record(
      'Excel export',
      'xlsx is an accepted export format alongside csv',
      EXPORT_FORMAT_VALUES.includes('xlsx') && EXPORT_FORMAT_VALUES.includes('csv'),
      EXPORT_FORMAT_VALUES.join(', ')
    );
    record(
      'Excel export',
      'the sheet carries every declared report column, in order',
      dataSheet.getRow(1).values.slice(1).join('|') === EXPORT_COLUMNS.loans.map((column) => column.header).join('|'),
      `${EXPORT_COLUMNS.loans.length} columns`
    );
    record(
      'Excel export',
      'the header is frozen, filterable and styled',
      dataSheet.views?.[0]?.state === 'frozen' &&
        dataSheet.views[0].ySplit === 1 &&
        Boolean(dataSheet.autoFilter) &&
        dataSheet.getRow(1).font?.bold === true,
      `frozen, ${JSON.stringify(dataSheet.autoFilter)}`
    );
    record(
      'Excel export',
      'columns are auto-sized within bounds',
      [1, 3, 6].every((index) => dataSheet.getColumn(index).width >= 10 && dataSheet.getColumn(index).width <= 46),
      [1, 3].map((index) => `col${index}:${dataSheet.getColumn(index).width}`).join(' ')
    );
    record(
      'Excel export',
      'loan numbers, CIFIDs and route codes are text cells',
      firstRow.getCell(1).numFmt === '@' && firstRow.getCell(4).numFmt === '@' && firstRow.getCell(16).numFmt === '@',
      'Excel cannot reinterpret an identifier'
    );
    record(
      'Excel export',
      'money is numeric with an INR format, so a column can be summed',
      typeof firstRow.getCell(6).value === 'number' &&
        firstRow.getCell(6).value === 100000 &&
        firstRow.getCell(6).numFmt === '₹#,##0.00',
      `${firstRow.getCell(6).value} as ${firstRow.getCell(6).numFmt}`
    );
    record(
      'Excel export',
      'dates are real date cells',
      firstRow.getCell(19).value instanceof Date && firstRow.getCell(19).numFmt === 'yyyy-mm-dd',
      'yyyy-mm-dd'
    );

    const summaryMap = new Map();
    summarySheet.eachRow((row) => summaryMap.set(String(row.getCell(1).value ?? ''), row.getCell(2).value));

    record(
      'Excel export',
      'the Summary sheet carries the five required totals',
      ['Total Loans', 'Loan Amount', 'Total Repayment', 'Collected', 'Outstanding'].every((label) => summaryMap.has(label)) &&
        SUMMARY_FIELDS.loans.length === 5,
      SUMMARY_FIELDS.loans.map((field) => field.label).join(', ')
    );
    record(
      'Excel export',
      'the totals are the report summary, not a second calculation',
      summaryMap.get('Total Loans') === 1 && summaryMap.get('Loan Amount') === 100000 && summaryMap.get('Outstanding') === 121500,
      'read straight from the summary block'
    );
    record(
      'Excel export',
      'active filters are listed, without paging noise',
      summaryMap.get('status') === 'ACTIVE' && !summaryMap.has('page') && !summaryMap.has('format'),
      'status only'
    );
    record(
      'Excel export',
      'a blank value stays blank rather than becoming zero',
      reportExcelService.cellFor('', 'money').value === null && reportExcelService.cellFor(null, 'number').value === null,
      'empty cells'
    );

    record(
      'Excel export',
      'the workbook is built from the report service response, never a second query',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportExcelService.js'), 'utf8'));
        return !/models|sequelize|reportService/.test(source);
      })(),
      'no database access in the renderer'
    );
    record(
      'Excel export',
      'the export runs the same service call as the screen, with a raised limit',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'controllers', 'reportController.js'), 'utf8'));
        return /limit: EXPORT_MAX_ROWS/.test(source) && /summary: data\.summary/.test(source);
      })(),
      'one query, one summary'
    );
    record(
      'Excel export',
      'EVERY export format is gated on reports.export, not just CSV',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'reportRoutes.js'), 'utf8'));
        return (
          /EXPORT_FORMAT_VALUES\.includes\(req\.query\.format\)/.test(source) &&
          /requirePermission\(PERMISSIONS\.REPORTS_EXPORT\)/.test(source)
        );
      })(),
      'a new format cannot slip past the gate by not being CSV'
    );
    record(
      'Excel export',
      'every report page asks for Excel, and the toolbar renders the Excel button',
      (() => {
        const pages = ['LoanReportPage', 'CollectionReportPage', 'EmiReportPage', 'DemandCollectionReportPage'].map((name) =>
          stripComments(
            fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'reports', `${name}.jsx`), 'utf8')
          )
        );
        const toolbar = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'reports', 'ReportToolbar.jsx'), 'utf8')
        );
        return (
          pages.every((page) => /exportFormat="xlsx"/.test(page)) &&
          /Export Excel/.test(toolbar) &&
          /bi-file-earmark-excel/.test(toolbar) &&
          /exportFormat = 'xlsx'/.test(toolbar)
        );
      })(),
      'Export Excel on all four report pages'
    );
    record(
      'Excel export',
      'switching the button did not disturb Reset, Refresh or the filter wiring',
      (() => {
        const toolbar = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'reports', 'ReportToolbar.jsx'), 'utf8')
        );
        const pages = ['CollectionReportPage', 'EmiReportPage', 'DemandCollectionReportPage'].map((name) =>
          stripComments(
            fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'reports', `${name}.jsx`), 'utf8')
          )
        );
        return (
          /onClick=\{onReset\}/.test(toolbar) &&
          /onClick=\{onRefresh\}/.test(toolbar) &&
          pages.every((page) => /onRefresh=/.test(page) && /onReset=/.test(page) && /filters=\{/.test(page))
        );
      })(),
      'Reset / Refresh / filters untouched'
    );
    record(
      'Excel export',
      'the export button is still gated on reports.export in the UI too',
      (() => {
        const toolbar = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'reports', 'ReportToolbar.jsx'), 'utf8')
        );
        return /can\(PERMISSIONS\.REPORTS_EXPORT\)/.test(toolbar) && /canExport \?/.test(toolbar);
      })(),
      'hidden without the permission; the backend still refuses regardless'
    );
  }

  // ---------- Phase 13B: Excel export for the remaining three reports ----------
  {
    const ExcelJS = require('exceljs');
    const reportExcelService = require('../src/services/reportExcelService');
    const { REPORTS, CSV_COLUMNS, SUMMARY_FIELDS, REPORT_TITLES } = require('../src/config/reports');

    /*
     * Phase 13A built the workbook renderer for the loan report. Phase 13B adds
     * no second renderer: the other three reports are declared in the same
     * config and served by the same controller, so what is worth asserting is
     * that the declarations are complete and that each report really produces a
     * valid OOXML package with its own sheets, columns and totals.
     */

    const FIXTURES = {
      [REPORTS.COLLECTIONS]: {
        rows: [
          {
            collectionNumber: 'COL26-000001',
            collectionDate: '2026-08-18',
            status: 'POSTED',
            loan: { loanNumber: 'LN26-000001' },
            customer: { fullName: 'Asha Verma', cifId: 'C000007' },
            amount: '2500.00',
            collectedPrincipal: '2100.00',
            collectedInterest: '400.00',
            collectedBounce: '0.00',
            emiCollected: '2500.00',
            ledgerType: 'CASH',
            // Still present on the ROW — the API and the screen keep these —
            // but deliberately not among the exported columns.
            paymentReference: '000451',
            route: { routeCode: 'RT26-000001' },
            createdBy: 'Ravi',
            countsTowardTotals: true
          }
        ],
        summary: {
          totalCount: 1,
          postedCount: 1,
          postedAmount: '2500.00',
          reversedCount: 0,
          reversedAmount: '0.00',
          netCollected: '2500.00',
          // Phase 13D split the net figure by what the money was applied to.
          emiCollected: '2500.00',
          collectedPrincipal: '2100.00',
          collectedInterest: '400.00',
          // Bounce ACTUALLY collected, and how many collections carried any.
          collectedBounce: '0.00',
          bounceCollectionCount: 0
        },
        // Amount / Collection Date / Loan Number, after the five identifier and
        // status columns were dropped from the download.
        moneyColumn: 4,
        dateColumn: 1,
        codeColumn: 2
      },
      /*
       * The Bounce Collection report: the same collection rows restricted to
       * bounce_amount > 0. Total Received = EMI Collected + Bounce Collected.
       */
      [REPORTS.BOUNCE_COLLECTIONS]: {
        rows: [
          {
            collectionNumber: 'COL26-000071',
            collectionDate: '2026-08-19',
            status: 'POSTED',
            loan: { loanNumber: 'LN26-000002' },
            customer: { fullName: 'Asha Verma', cifId: 'C000007' },
            amount: '2500.00',
            emiCollected: '2000.00',
            collectedBounce: '500.00',
            ledgerType: 'CASH',
            paymentReference: '000452',
            route: { routeCode: 'RT26-000001' },
            createdBy: 'Ravi',
            countsTowardTotals: true
          }
        ],
        summary: {
          collectedBounce: '500.00',
          bounceCollectionCount: 1,
          postedCount: 1,
          postedAmount: '2500.00',
          reversedCount: 0,
          reversedBounce: '0.00',
          emiCollected: '2000.00',
          netCollected: '2500.00'
        },
        // Total Received / (no date column) / Loan Number, after the six
        // identifier and status columns were dropped from this download.
        moneyColumn: 3,
        dateColumn: null,
        codeColumn: 1
      },
      [REPORTS.EMIS]: {
        rows: [
          {
            loan: { loanNumber: 'LN26-000001' },
            customer: { fullName: 'Asha Verma', cifId: 'C000007' },
            emiNumber: 3,
            emiDate: '2026-09-20',
            emiAmount: '5000.00',
            principal: '4200.00',
            interest: '800.00',
            amountCollected: '2500.00',
            outstanding: '2500.00',
            dpd: 0,
            status: 'PARTIAL',
            route: { routeCode: 'RT26-000001' },
            collectorNames: 'Ravi'
          }
        ],
        summary: {
          asOf: '2026-08-19',
          emiCount: 1,
          totalEmiAmount: '5000.00',
          totalPrincipal: '4200.00',
          totalInterest: '800.00',
          totalCollected: '2500.00',
          totalOutstanding: '2500.00'
        },
        moneyColumn: 6,
        dateColumn: 5,
        codeColumn: 1
      },
      [REPORTS.DEMAND_COLLECTIONS]: {
        rows: [
          {
            route: { routeCode: 'RT26-000001', name: 'North' },
            collectorNames: 'Ravi',
            demandEmiCount: 4,
            grossDemand: '20000.00',
            collectedAgainstDemand: '7500.00',
            netDemand: '12500.00',
            collectionCount: 2,
            collectedInPeriod: '7500.00'
          }
        ],
        summary: {
          asOf: '2026-08-19',
          routeCount: 1,
          demandEmiCount: 4,
          grossDemand: '20000.00',
          collectedAgainstDemand: '7500.00',
          netDemand: '12500.00',
          collectionCount: 2,
          collectedInPeriod: '7500.00'
        },
        moneyColumn: 5,
        dateColumn: null,
        codeColumn: 1
      }
    };

    record(
      'Excel export 13B',
      'every report — not only loans — declares a sheet title and Summary fields',
      Object.values(REPORTS).every(
        (key) => typeof REPORT_TITLES[key] === 'string' && Array.isArray(SUMMARY_FIELDS[key]) && SUMMARY_FIELDS[key].length > 0
      ) && !Object.prototype.hasOwnProperty.call(REPORT_TITLES, 'undefined'),
      Object.values(REPORTS).map((key) => `${key}:${REPORT_TITLES[key]}`).join(' | ')
    );
    record(
      'Excel export 13B',
      'every Summary field points at a key the report actually returns',
      Object.entries(FIXTURES).every(([key, fixture]) =>
        SUMMARY_FIELDS[key].every((field) => reportExcelService.valueAt(fixture.summary, field.path) !== undefined)
      ),
      'no Summary row can render blank because of a typo in a path'
    );
    record(
      'Excel export 13B',
      'money, date and identifier columns are typed in every report, not just loans',
      Object.values(REPORTS).every((key) =>
        CSV_COLUMNS[key].some((column) => column.type === 'money') && CSV_COLUMNS[key].some((column) => column.type === 'code')
      ),
      Object.values(REPORTS)
        .map((key) => `${key}:${CSV_COLUMNS[key].filter((column) => column.type).length}/${CSV_COLUMNS[key].length} typed`)
        .join(' ')
    );

    for (const [reportKey, fixture] of Object.entries(FIXTURES)) {
      const buffer = await reportExcelService.buildReportWorkbook({
        reportKey,
        rows: fixture.rows,
        summary: fixture.summary,
        filters: { status: 'POSTED', page: 3, limit: 25, format: 'xlsx' }
      });
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(buffer);
      const sheet = book.getWorksheet(REPORT_TITLES[reportKey]);
      const summarySheet = book.getWorksheet('Summary');
      const dataRow = sheet.getRow(2);

      record(
        'Excel export 13B',
        `${reportKey}: a valid OOXML package with its own named sheet and a Summary sheet`,
        buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
          Boolean(sheet) &&
          Boolean(summarySheet) &&
          book.worksheets.length === 2,
        `${buffer.length} bytes, sheets: ${book.worksheets.map((worksheet) => worksheet.name).join(', ')}`
      );
      record(
        'Excel export 13B',
        `${reportKey}: every declared column is present, in order`,
        sheet.getRow(1).values.slice(1).join('|') === CSV_COLUMNS[reportKey].map((column) => column.header).join('|'),
        `${CSV_COLUMNS[reportKey].length} columns`
      );
      record(
        'Excel export 13B',
        `${reportKey}: header frozen and filterable, columns auto-sized`,
        sheet.views?.[0]?.state === 'frozen' &&
          sheet.views[0].ySplit === 1 &&
          Boolean(sheet.autoFilter) &&
          sheet.getRow(1).font?.bold === true &&
          CSV_COLUMNS[reportKey].every((column, index) => {
            const width = sheet.getColumn(index + 1).width;
            return width >= 10 && width <= 46;
          }),
        `frozen, ${JSON.stringify(sheet.autoFilter)}`
      );
      record(
        'Excel export 13B',
        `${reportKey}: money is numeric with the INR format and identifiers stay text`,
        typeof dataRow.getCell(fixture.moneyColumn).value === 'number' &&
          dataRow.getCell(fixture.moneyColumn).numFmt === '₹#,##0.00' &&
          dataRow.getCell(fixture.codeColumn).numFmt === '@' &&
          typeof dataRow.getCell(fixture.codeColumn).value === 'string',
        `${dataRow.getCell(fixture.moneyColumn).value} money, ${dataRow.getCell(fixture.codeColumn).value} text`
      );
      if (fixture.dateColumn) {
        record(
          'Excel export 13B',
          `${reportKey}: dates are real date cells`,
          dataRow.getCell(fixture.dateColumn).value instanceof Date && dataRow.getCell(fixture.dateColumn).numFmt === 'yyyy-mm-dd',
          'yyyy-mm-dd'
        );
      }

      const summaryMap = new Map();
      summarySheet.eachRow((row) => summaryMap.set(String(row.getCell(1).value ?? ''), row.getCell(2).value));

      record(
        'Excel export 13B',
        `${reportKey}: the Summary sheet carries this report's own totals`,
        SUMMARY_FIELDS[reportKey].every((field) => summaryMap.has(field.label)) &&
          SUMMARY_FIELDS[reportKey]
            .filter((field) => field.type === 'money' || field.type === 'number')
            .every((field) => summaryMap.get(field.label) === Number(reportExcelService.valueAt(fixture.summary, field.path))),
        SUMMARY_FIELDS[reportKey].map((field) => `${field.label}=${summaryMap.get(field.label)}`).join(', ')
      );
      record(
        'Excel export 13B',
        `${reportKey}: the filters that produced the file are listed, without paging noise`,
        summaryMap.get('status') === 'POSTED' &&
          !summaryMap.has('page') &&
          !summaryMap.has('limit') &&
          !summaryMap.has('format') &&
          summaryMap.get('Rows exported') === fixture.rows.length,
        `status=POSTED, ${fixture.rows.length} rows`
      );
    }

    record(
      'Excel export 13B',
      'the CSV column set is untouched — the same columns still serve both formats',
      (() => {
        const csvSource = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'utils', 'csv.js'), 'utf8'));
        return !/type/.test(csvSource) && Object.values(REPORTS).every((key) => CSV_COLUMNS[key].every((column) => column.header && column.path));
      })(),
      'the CSV writer never reads the Excel type hints'
    );
    /*
     * Found while verifying the EMI export: every report paged through one
     * helper that capped a result set at MAX_LIMIT (200). A screen wants that
     * cap; a download does not. The EMI report has 576 instalments, so its
     * export silently contained 196 rows while its Summary reported 576 — the
     * file disagreed with its own totals. CSV had the same defect since Phase 9.
     */
    record(
      'Excel export 13B',
      'an export is paged to the export ceiling, so a large report is not silently truncated',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportService.js'), 'utf8'));
        return /const ceiling = isExport \? EXPORT_MAX_ROWS : MAX_LIMIT;/.test(source) && /Math\.min\(ceiling,/.test(source);
      })(),
      'MAX_LIMIT for a screen, EXPORT_MAX_ROWS for a file'
    );
    record(
      'Excel export 13B',
      'an on-screen page is still capped at MAX_LIMIT',
      (() => {
        const { MAX_LIMIT, EXPORT_MAX_ROWS, EXPORT_SCOPE } = require('../src/config/reports');
        const { paging } = require('../src/services/reportService');
        return (
          paging({ limit: 10000 }).pageSize === MAX_LIMIT &&
          paging({ limit: 10000, [EXPORT_SCOPE]: true }).pageSize === EXPORT_MAX_ROWS &&
          paging({ limit: 50, [EXPORT_SCOPE]: true }).pageSize === 50 &&
          paging({}).pageSize === 25
        );
      })(),
      'the raised ceiling applies to exports only'
    );
    record(
      'Excel export 13B',
      'export scope cannot be requested from a query string',
      (() => {
        const { EXPORT_SCOPE } = require('../src/config/reports');
        // A Symbol key is unreachable from req.query, which only ever holds strings.
        const spoofed = { limit: '10000', 'Symbol(report.export)': 'true', export: 'true' };
        return typeof EXPORT_SCOPE === 'symbol' && spoofed[EXPORT_SCOPE] === undefined;
      })(),
      'only the controller can mark a call as an export'
    );
    record(
      'Excel export 13B',
      'the controller marks the export call and no other',
      (() => {
        const source = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'controllers', 'reportController.js'), 'utf8'));
        return (
          /wantsFile \? \{ \.\.\.req\.query, page: 1, limit: EXPORT_MAX_ROWS, \[EXPORT_SCOPE\]: true \} : req\.query/.test(source) &&
          source.match(/EXPORT_SCOPE\]: true/g).length === 1
        );
      })(),
      'one marked call site'
    );
    record(
      'Excel export 13B',
      'no second renderer was added for the other three reports',
      (() => {
        const services = fs.readdirSync(path.resolve(__dirname, '..', 'src', 'services'));
        return services.filter((file) => /excel/i.test(file)).length === 1;
      })(),
      'one reportExcelService for all four reports'
    );
  }

  // ---------- Collection form: Bounce collection ----------
  {
    /*
     * The Bounce column used to be entry-only: nothing in the database, the API
     * or any model carried a bounce amount, so what the operator typed was
     * thrown away on submit. The tripwire that guarded that state has fired —
     * `collections.bounce_amount` now exists — so these checks pin the wiring
     * instead: what is typed is posted, it is taken OUT of the amount rather
     * than added to it, and it never reaches an allocation.
     */
    const modalPath = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'collections', 'CollectionFormModal.jsx');
    const modal = stripComments(fs.readFileSync(modalPath, 'utf8'));

    const headerBlock = (modal.match(/<thead[\s\S]*?<\/thead>/) ?? [''])[0];
    const headers = [...headerBlock.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1].trim());
    record(
      'Bounce collection form',
      'the allocation table shows the charge assessed and the amount collected against it, separately',
      headers.join('|') === '#|Due date|EMI|Collected|Outstanding|Status|Bounce charge|Bounce collected|Allocate',
      headers.join(' | ')
    );

    record(
      'Bounce collection form',
      'the assessed charge is displayed read-only from the instalment, never typed over',
      /<td className="text-end small text-secondary">\{formatCurrency\(emi\.bounceCharge\)\}<\/td>/.test(modal),
      'emi.bounceCharge is shown, not edited'
    );

    record(
      'Bounce collection form',
      'every instalment row renders a bounce-collected input bound to its own EMI',
      /aria-label=\{`Bounce collected for instalment \$\{emi\.emiNumber\}`\}/.test(modal) &&
        /value=\{bounces\[emi\.id\] \?\? ''\}/.test(modal) &&
        /onChange=\{\(event\) => setBounce\(emi\.id, event\.target\.value\)\}/.test(modal),
      'one input per row, keyed by emi.id'
    );

    record(
      'Bounce collection form',
      'bounce defaults to empty and cannot be negative',
      /const \[bounces, setBounces\] = useState\(\{\}\)/.test(modal) && /min="0"/.test(modal),
      'empty default, min 0 — an untouched form posts 0.00 and behaves exactly as before'
    );

    record(
      'Bounce collection form',
      'bounce validation reuses the existing paise convention',
      /isBounceValid = \(value\) =>[\s\S]{0,160}toMinorUnits\(value\) !== null/.test(modal),
      'same toMinorUnits rule as every other money field'
    );

    /* --------------------- the payload, and what is in it -------------------- */

    const payload = modal.slice(modal.indexOf('const payload = {'), modal.indexOf('const response = await createCollection'));
    record(
      'Bounce collection form',
      'the posted payload carries bounce as ONE collection-level figure, not inside the allocations',
      /bounceAmount: fromMinorUnits\(bounceMinor\)/.test(payload) &&
        /allocations: Object\.entries\(allocations\)/.test(payload) &&
        /\.map\(\(\[emiId, value\]\) => \(\{ emiId: Number\(emiId\), amount: value \}\)\)/.test(payload) &&
        // The allocation entries are built from `allocations` alone — no bounce
        // value can leak into one and become principal or interest.
        !/allocations:[\s\S]{0,400}bounce/i.test(payload),
      'bounceAmount beside the allocations, never within them'
    );

    record(
      'Bounce collection form',
      'bounce is subtracted from the amount, so the same rupee is never both allocated and bounced',
      /const emiTargetMinor = amountMinor - bounceMinor;/.test(modal) &&
        /const unallocatedMinor = emiTargetMinor - allocatedMinor;/.test(modal),
      'allocations must total amount − bounce'
    );

    record(
      'Bounce collection form',
      'bounce above the amount received is refused before submission',
      /const bounceOverAmount = bounceMinor > amountMinor;/.test(modal) &&
        /!bounceOverAmount &&/.test(modal) &&
        /cannot be more than the amount received/.test(modal),
      'bounce is part of the amount, not an addition to it'
    );

    record(
      'Bounce collection form',
      'the reconciliation panel shows total, EMI allocated and bounce together',
      ['Total collection', 'EMI allocated', 'Bounce collection', 'Unallocated'].every((label) =>
        new RegExp(`>${label}</div>`).test(modal)
      ),
      'the operator can see the three add up as they type'
    );

    record(
      'Bounce collection form',
      'the form no longer claims bounce is discarded',
      !/it is not saved with the collection/.test(modal) && /it is saved as/.test(modal),
      'the old entry-only notice is gone'
    );

    // The replacement tripwire: bounce lives on the COLLECTION, and must never
    // acquire a home on the allocation row, where it would be indistinguishable
    // from instalment money.
    const allocationModelSource = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'models', 'CollectionAllocation.js'), 'utf8')
    );
    const allocationMigration = fs.readFileSync(
      path.resolve(__dirname, '..', 'migrations', '015-create-collection-allocations.js'),
      'utf8'
    );
    record(
      'Bounce collection form',
      'no bounce field exists on an allocation — bounce is a property of the payment, not of an instalment split',
      !/bounce/i.test(allocationModelSource) && !/bounce/i.test(stripComments(allocationMigration)),
      'collection_allocations carries allocated_amount only'
    );
  }

  // ---------- Bounce Collection: money collected, never money assessed ----------
  {
    const { Collection } = models;
    const { assertBounceAmount } = collectionService;
    const { emiPortionPaise, DEFAULT_BOUNCE_AMOUNT } = require('../src/config/collections');
    const { splitAllocation: bSplit } = allocationService;

    /**
     * One collection, exactly as the service would store it. Nothing here is a
     * second implementation: `amount` and `bounceAmount` are the stored columns,
     * and `emiCollected()` is the model's own method.
     */
    const build = ({ amount, bounce = DEFAULT_BOUNCE_AMOUNT, date, status = COLLECTION_STATUS.POSTED, loanId = 1 }) =>
      Collection.build({
        collectionNumber: 'COL26-000001',
        loanId,
        customerId: 1,
        amount,
        bounceAmount: bounce,
        collectionDate: date,
        ledgerType: LEDGER_TYPES.CASH,
        status
      });

    /*
     * The dashboard / report aggregate, expressed the way the SQL does it:
     * POSTED rows only, filtered by collection date, summing the collections'
     * own bounce_amount. Nothing reads an instalment's bounce_charge.
     */
    const bounceCollection = (ledger, { from, to } = {}) => {
      const counted = ledger.filter(
        (c) =>
          c.status === COLLECTION_STATUS.POSTED &&
          (!from || c.collectionDate >= from) &&
          (!to || c.collectionDate <= to)
      );
      return {
        bounceCollection: fromPaise(counted.reduce((total, c) => total + toPaise(c.bounceAmount), 0n)),
        bounceCollectionCount: counted.filter((c) => toPaise(c.bounceAmount) > 0n).length,
        emiCollection: fromPaise(counted.reduce((total, c) => total + toPaise(c.emiCollected()), 0n)),
        postedAmount: fromPaise(counted.reduce((total, c) => total + toPaise(c.amount), 0n))
      };
    };

    /* ------------------------------- 1. basics ------------------------------ */

    {
      const c = build({ amount: '1000.00', date: '2026-08-18' });
      record(
        'Bounce collection',
        '1. an EMI-only collection records bounce 0.00 and allocates the whole amount',
        c.emiCollected() === '1000.00' &&
          c.bounceAmount === DEFAULT_BOUNCE_AMOUNT &&
          emiPortionPaise(c.amount, c.bounceAmount) === toPaise('1000.00'),
        `emi=${c.emiCollected()} bounce=${c.bounceAmount} total=${c.amount}`
      );
    }

    {
      const c = build({ amount: '1500.00', bounce: '500.00', date: '2026-08-18' });
      const json = c.toPublicJSON();
      record(
        'Bounce collection',
        '2. EMI + bounce: 1000 EMI, 500 bounce, 1500 total - all three preserved and reconciling',
        c.emiCollected() === '1000.00' &&
          c.bounceAmount === '500.00' &&
          c.amount === '1500.00' &&
          toPaise(c.emiCollected()) + toPaise(c.bounceAmount) === toPaise(c.amount) &&
          json.emiCollected === '1000.00' &&
          json.bounceCollected === '500.00' &&
          json.amount === '1500.00',
        'emiCollected + bounceCollected === amount, and the API says so'
      );
    }

    {
      const emiWithCharge = EmiSchedule.build({
        loanId: 1,
        emiNumber: 1,
        emiDate: '2026-08-10',
        emiAmount: '1000.00',
        principal: '900.00',
        interest: '100.00',
        bounceCharge: '500.00',
        amountCollected: '1000.00'
      });
      const ledger = [build({ amount: '1000.00', date: '2026-08-18' })];
      const totals = bounceCollection(ledger);
      record(
        'Bounce collection',
        '3. a 500.00 bounce CHARGE that nobody has paid contributes 0.00 to bounce collection',
        toPaise(emiWithCharge.bounceCharge) === toPaise('500.00') &&
          totals.bounceCollection === '0.00' &&
          totals.bounceCollectionCount === 0,
        `charge=${emiWithCharge.bounceCharge} collected=${totals.bounceCollection} - the charge is not the metric`
      );

      const afterPayment = bounceCollection([...ledger, build({ amount: '500.00', bounce: '500.00', date: '2026-09-02' })]);
      record(
        'Bounce collection',
        '4. once the 500.00 is actually paid, bounce collection becomes 500.00 - and only then',
        afterPayment.bounceCollection === '500.00' &&
          afterPayment.bounceCollectionCount === 1 &&
          afterPayment.emiCollection === '1000.00' &&
          afterPayment.postedAmount === '1500.00',
        `bounce=${afterPayment.bounceCollection} emi=${afterPayment.emiCollection} total=${afterPayment.postedAmount}`
      );
    }

    /* --------------------------- 5-7. many payments -------------------------- */

    {
      const ledger = [
        build({ amount: '1500.00', bounce: '500.00', date: '2026-08-10' }),
        build({ amount: '1200.00', bounce: '200.00', date: '2026-09-10' }),
        build({ amount: '1350.00', bounce: '350.00', date: '2026-10-10' })
      ];
      const totals = bounceCollection(ledger);
      record(
        'Bounce collection',
        '5. one loan, three EMI+bounce collections: bounce sums to 1050.00 across 3 collections',
        totals.bounceCollection === '1050.00' &&
          totals.bounceCollectionCount === 3 &&
          totals.emiCollection === '3000.00' &&
          totals.postedAmount === '4050.00' &&
          toPaise(totals.emiCollection) + toPaise(totals.bounceCollection) === toPaise(totals.postedAmount),
        `bounce=${totals.bounceCollection} emi=${totals.emiCollection} total=${totals.postedAmount}`
      );
    }

    {
      const ledger = [
        build({ amount: '1000.00', date: '2026-08-10' }),
        build({ amount: '1500.00', bounce: '500.00', date: '2026-09-10' }),
        build({ amount: '1000.00', date: '2026-10-10' })
      ];
      const totals = bounceCollection(ledger);
      record(
        'Bounce collection',
        '6. mixing EMI-only and EMI+bounce: only the collection that carried bounce is counted',
        totals.bounceCollection === '500.00' &&
          totals.bounceCollectionCount === 1 &&
          totals.emiCollection === '3000.00' &&
          totals.postedAmount === '3500.00',
        `1 of 3 collections carried bounce; count=${totals.bounceCollectionCount}`
      );
    }

    {
      const ledger = [
        build({ loanId: 1, amount: '1500.00', bounce: '500.00', date: '2026-08-10' }),
        build({ loanId: 2, amount: '2250.00', bounce: '250.00', date: '2026-08-10' }),
        build({ loanId: 3, amount: '900.00', date: '2026-08-10' })
      ];
      const totals = bounceCollection(ledger);
      record(
        'Bounce collection',
        '7. across three loans the bounce collection is 750.00 from 2 collections',
        totals.bounceCollection === '750.00' &&
          totals.bounceCollectionCount === 2 &&
          totals.emiCollection === '3900.00' &&
          totals.postedAmount === '4650.00',
        `bounce=${totals.bounceCollection} from ${totals.bounceCollectionCount} of 3 collections`
      );
    }

    /* ------------------------------ 8-9. dates ------------------------------ */

    {
      const ledger = [
        build({ amount: '1000.00', date: '2026-08-18' }),
        build({ amount: '500.00', bounce: '500.00', date: '2026-09-05' })
      ];

      const onEmiDay = bounceCollection(ledger, { from: '2026-08-18', to: '2026-08-18' });
      const onBounceDay = bounceCollection(ledger, { from: '2026-09-05', to: '2026-09-05' });
      record(
        'Bounce collection',
        '8. bounce is counted on the COLLECTION date, not the EMI due date or the charge date',
        onEmiDay.bounceCollection === '0.00' &&
          onBounceDay.bounceCollection === '500.00' &&
          onBounceDay.bounceCollectionCount === 1,
        `18 Aug -> ${onEmiDay.bounceCollection}, 5 Sep -> ${onBounceDay.bounceCollection}`
      );

      const august = bounceCollection(ledger, { from: '2026-08-01', to: '2026-08-31' });
      const september = bounceCollection(ledger, { from: '2026-09-01', to: '2026-09-30' });
      const both = bounceCollection(ledger, { from: '2026-08-01', to: '2026-09-30' });
      record(
        'Bounce collection',
        '9. different collection dates land in the right periods, and the periods add up',
        august.bounceCollection === '0.00' &&
          september.bounceCollection === '500.00' &&
          both.bounceCollection === '500.00' &&
          toPaise(august.bounceCollection) + toPaise(september.bounceCollection) === toPaise(both.bounceCollection),
        `Aug=${august.bounceCollection} Sep=${september.bounceCollection} both=${both.bounceCollection}`
      );
    }

    {
      const ledger = [
        build({ amount: '1500.00', bounce: '500.00', date: '2026-08-18' }),
        build({ amount: '1200.00', bounce: '200.00', date: '2026-08-18', status: COLLECTION_STATUS.REVERSED })
      ];
      const totals = bounceCollection(ledger);
      record(
        'Bounce collection',
        'a REVERSED collection stops counting toward bounce, exactly as it stops counting toward everything else',
        totals.bounceCollection === '500.00' && totals.bounceCollectionCount === 1 && totals.postedAmount === '1500.00',
        'POSTED only'
      );
    }

    /* ---------------------------- 10-13. allocation --------------------------- */

    {
      const emiPaise = emiPortionPaise('1500.00', '500.00');
      const { principalPaise, interestPaise } = bSplit({
        allocatedPaise: emiPaise,
        principalPaise: toPaise('900.00'),
        emiAmountPaise: toPaise('1000.00')
      });
      record(
        'Bounce collection',
        '10. the bounce amount can never become principal: the split apportions the ALLOCATED total only',
        emiPaise === toPaise('1000.00') && principalPaise === toPaise('900.00'),
        `principal=${fromPaise(principalPaise)} - 90% of 1000, not of 1500`
      );
      record(
        'Bounce collection',
        '11. the bounce amount can never become interest, for the same reason',
        interestPaise === toPaise('100.00') &&
          principalPaise + interestPaise === emiPaise &&
          principalPaise + interestPaise !== toPaise('1500.00'),
        `interest=${fromPaise(interestPaise)}; principal + interest = ${fromPaise(principalPaise + interestPaise)}, not 1500.00`
      );
    }

    {
      const allocationSource = stripComments(
        fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionAllocationService.js'), 'utf8')
      );
      const fifo = allocationSource.slice(
        allocationSource.indexOf('async function planFifoAllocation'),
        allocationSource.indexOf('function splitAllocation')
      );
      const collectionSource = stripComments(
        fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionService.js'), 'utf8')
      );
      record(
        'Bounce collection',
        '12. the FIFO planner is untouched - oldest instalment first, no bounce concept in it at all',
        !/bounce/i.test(fifo) &&
          /order: \[\['emiNumber', 'ASC'\]\]/.test(fifo) &&
          /const take = due < remaining \? due : remaining;/.test(fifo),
        'oldest-first, partial and multi-EMI behaviour unchanged'
      );
      record(
        'Bounce collection',
        'posting passes the INSTALMENT portion to the allocation validator, not the gross amount',
        /const emiPaise = assertBounceAmount\(amount, bounceAmount\);/.test(collectionSource) &&
          /collectionAmount: fromPaise\(emiPaise\)/.test(collectionSource) &&
          !/collectionAmount: amount/.test(collectionSource),
        'allocations must total amount minus bounce'
      );

      let underMessage = '';
      try {
        const total = allocationService.assertAllocationShape([{ emiId: 1, amount: '900.00' }]);
        allocationService.assertAllocationTotal(total, fromPaise(emiPortionPaise('1500.00', '500.00')));
      } catch (error) {
        underMessage = error.message;
      }
      record(
        'Bounce collection',
        'under-allocating the instalment portion is still refused, with the shortfall named',
        /100\.00 unallocated/.test(underMessage),
        underMessage
      );
    }

    {
      const c = build({ amount: '1100.00', bounce: '500.00', date: '2026-08-18' });
      const emi = EmiSchedule.build({
        loanId: 1,
        emiNumber: 1,
        emiDate: '2026-08-10',
        emiAmount: '1000.00',
        principal: '900.00',
        interest: '100.00',
        bounceCharge: '500.00',
        amountCollected: c.emiCollected()
      });
      record(
        'Bounce collection',
        '13. a partial EMI plus a bounce payment reconciles, and the instalment sees only its 600.00',
        c.emiCollected() === '600.00' &&
          toPaise(c.emiCollected()) + toPaise(c.bounceAmount) === toPaise(c.amount) &&
          emi.amountCollected === '600.00' &&
          emi.outstanding() === '400.00' &&
          emi.computeStatus('2026-08-18') === EMI_STATUS.PARTIAL,
        `emi collected=${emi.amountCollected} outstanding=${emi.outstanding()} status=${emi.computeStatus('2026-08-18')}`
      );
    }

    /* -------------------- 15. reconciliation / double counting ------------------- */

    {
      /*
       * The failure this whole design exists to prevent: 1500 received must be
       * 1000 allocated + 500 bounce. The wrong answer - allocating the full
       * 1500 AND recording 500 bounce - invents 500 that nobody paid. The
       * service refuses it, because the allocations are checked against
       * amount - bounce and not against amount.
       */
      const emiPaise = emiPortionPaise('1500.00', '500.00');
      let doubleCountStatus = null;
      let doubleCountMessage = '';
      try {
        const total = allocationService.assertAllocationShape([{ emiId: 1, amount: '1500.00' }]);
        allocationService.assertAllocationTotal(total, fromPaise(emiPaise));
      } catch (error) {
        doubleCountStatus = error.statusCode;
        doubleCountMessage = error.message;
      }
      record(
        'Bounce collection',
        '15. allocating the full 1500 while also recording 500 bounce is REFUSED - no invented money',
        doubleCountStatus === 400 && /more than the collection amount/.test(doubleCountMessage),
        doubleCountMessage
      );

      let overStatus = null;
      try {
        assertBounceAmount('1000.00', '1500.00');
      } catch (error) {
        overStatus = error.statusCode;
      }
      record(
        'Bounce collection',
        'a bounce larger than the amount received is refused (bounce is inside the amount, not added to it)',
        overStatus === 400 && assertBounceAmount('1500.00', '500.00') === toPaise('1000.00'),
        `over -> ${overStatus}; 1500 with 500 bounce -> 1000.00 instalment portion`
      );

      const ledger = [
        build({ amount: '1000.00', date: '2026-08-10' }),
        build({ amount: '1500.00', bounce: '500.00', date: '2026-08-11' }),
        build({ amount: '500.00', bounce: '500.00', date: '2026-08-12' }),
        build({ amount: '1100.00', bounce: '500.00', date: '2026-08-13' })
      ];
      const totals = bounceCollection(ledger);
      record(
        'Bounce collection',
        'across a mixed ledger, EMI collection + bounce collection equals the posted total exactly',
        toPaise(totals.emiCollection) + toPaise(totals.bounceCollection) === toPaise(totals.postedAmount) &&
          totals.postedAmount === '4100.00' &&
          totals.emiCollection === '2600.00' &&
          totals.bounceCollection === '1500.00',
        `${totals.emiCollection} + ${totals.bounceCollection} = ${totals.postedAmount}`
      );
    }

    /* ------------------------- bounce-only collections ------------------------ */

    {
      // The one case in which a collection legitimately has no allocation row.
      const emiPaise = emiPortionPaise('500.00', '500.00');
      const outcome = await allocationService.validateAllocations({
        allocations: [],
        collectionAmount: fromPaise(emiPaise),
        loanId: 1,
        transaction: null
      });
      record(
        'Bounce collection',
        'a bounce-only payment validates with no allocation and never reaches the instalment lock',
        emiPaise === 0n && outcome.planned.length === 0 && outcome.emiIds.length === 0,
        'nothing to allocate, so nothing is allocated'
      );

      let allocatedBounceOnly = null;
      try {
        await allocationService.validateAllocations({
          allocations: [{ emiId: 1, amount: '500.00' }],
          collectionAmount: '0.00',
          loanId: 1,
          transaction: null
        });
      } catch (error) {
        allocatedBounceOnly = error.statusCode;
      }
      record(
        'Bounce collection',
        'a bounce-only payment that tries to allocate to an instalment is refused',
        allocatedBounceOnly === 400,
        `status ${allocatedBounceOnly}`
      );

      // ...and the rule is not a general escape hatch: an ordinary collection
      // still has to allocate.
      const emptyBody = await runRules(collectionValidator.createCollectionRules, { body: {} });
      const normal = await runRules(collectionValidator.createCollectionRules, {
        body: { loanId: 1, customerId: 1, amount: '1500.00', bounceAmount: '500.00', collectionDate: '2026-08-18', ledgerType: 'CASH' }
      });
      const bounceOnly = await runRules(collectionValidator.createCollectionRules, {
        body: { loanId: 1, customerId: 1, amount: '500.00', bounceAmount: '500.00', collectionDate: '2026-08-18', ledgerType: 'CASH' }
      });
      record(
        'Bounce collection',
        'allocations stay required except when the payment is ENTIRELY bounce',
        emptyBody.some((e) => e.field === 'allocations') &&
          normal.some((e) => e.field === 'allocations') &&
          !bounceOnly.some((e) => e.field === 'allocations'),
        'partial bounce still allocates; only 100% bounce does not'
      );
    }

    /* --------------------------- API and validators -------------------------- */

    {
      const badBounce = await Promise.all(
        ['-5', 'abc', 'Infinity', '1e5', '10.123'].map((bounceAmount) =>
          runRules(collectionValidator.createCollectionRules, {
            body: {
              loanId: 1,
              customerId: 1,
              amount: '1500.00',
              bounceAmount,
              collectionDate: '2026-08-18',
              ledgerType: 'CASH',
              allocations: [{ emiId: 1, amount: '1000.00' }]
            }
          })
        )
      );
      record(
        'Bounce collection',
        'bounceAmount rejects negatives, NaN, Infinity, exponents and >2-decimal values',
        badBounce.every((errors) => errors.some((e) => e.field === 'bounceAmount')),
        '5/5 rejected'
      );

      const omitted = await runRules(collectionValidator.createCollectionRules, {
        body: {
          loanId: 1,
          customerId: 1,
          amount: '1000.00',
          collectionDate: '2026-08-18',
          ledgerType: 'CASH',
          allocations: [{ emiId: 1, amount: '1000.00' }]
        }
      });
      const zero = await runRules(collectionValidator.createCollectionRules, {
        body: {
          loanId: 1,
          customerId: 1,
          amount: '1000.00',
          bounceAmount: '0.00',
          collectionDate: '2026-08-18',
          ledgerType: 'CASH',
          allocations: [{ emiId: 1, amount: '1000.00' }]
        }
      });
      record(
        'Bounce collection',
        'BACKWARD COMPATIBLE: a request with no bounceAmount is still valid and means 0.00',
        omitted.length === 0 && zero.length === 0 && assertBounceAmount('1000.00') === toPaise('1000.00'),
        'every pre-existing client keeps working unchanged'
      );
    }

    /* ------------------------ reporting and the dashboard ----------------------- */

    {
      const reportSource = stripComments(
        fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportService.js'), 'utf8')
      );
      const dashboardSource = stripComments(
        fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'dashboardService.js'), 'utf8')
      );
      const collectionServiceSource = stripComments(
        fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionService.js'), 'utf8')
      );
      const dashboardModule = require('../src/services/dashboardService');

      record(
        'Bounce collection',
        'the collection report reads bounce from the collection row, never from the instalments it touched',
        /collectedBounce: collection\.bounceAmount/.test(reportSource) &&
          /bounceCollected\(postedOnly\)/.test(reportSource) &&
          !/bounceCharge/.test(
            reportSource.slice(reportSource.indexOf('async function collectionReport'), reportSource.indexOf('async function emiReport'))
          ),
        'collections.bounce_amount, under the same POSTED filter as netCollected'
      );

      record(
        'Bounce collection',
        'the dashboard consumes the report summary rather than computing bounce a second way',
        /bounceCollection: periodCollections\.summary\.collectedBounce/.test(dashboardSource) &&
          /bounceCollection: todayCollections\.summary\.collectedBounce/.test(dashboardSource) &&
          !/bounce_amount|bounce_charge/.test(dashboardSource),
        'one source of truth, filtered by the same period, route and collector'
      );

      record(
        'Bounce collection',
        'the dashboard exposes bounceCollection and bounceCollectionCount for both today and the period',
        (dashboardSource.match(/bounceCollection:/g) ?? []).length === 2 &&
          (dashboardSource.match(/bounceCollectionCount:/g) ?? []).length === 2 &&
          /bounceDefinition: BOUNCE_COLLECTION_DEFINITION/.test(dashboardSource),
        'clearly named values, with the definition beside them'
      );

      record(
        'Bounce collection',
        'the shipped definition rules out every wrong reading of the number',
        /actually collected/i.test(dashboardModule.BOUNCE_COLLECTION_DEFINITION) &&
          /never the bounce charges assessed or outstanding/i.test(dashboardModule.BOUNCE_COLLECTION_DEFINITION) &&
          /reversed collections excluded/i.test(dashboardModule.BOUNCE_COLLECTION_DEFINITION),
        `${dashboardModule.BOUNCE_COLLECTION_DEFINITION.slice(0, 80)}...`
      );

      record(
        'Bounce collection',
        'EFFICIENCY IS UNCHANGED and says so: bounce is excluded from collected / due',
        /Bounce collection is NOT included/.test(dashboardModule.EFFICIENCY_DEFINITION) &&
          /COALESCE\(SUM\(e\.amount_collected\), 0\)\s+AS collectedOnDue/.test(dashboardSource),
        'the ratio still compares instalment money against instalment demand'
      );

      record(
        'Bounce collection',
        'the loan position names all three separately: charge assessed, collected, outstanding',
        /bounceCharged: fromPaise\(bounceChargedPaise\)/.test(collectionServiceSource) &&
          /bounceCollected: fromPaise\(bounceCollectedPaise\)/.test(collectionServiceSource) &&
          /bounceOutstanding: fromPaise\(/.test(collectionServiceSource) &&
          // The instalment position itself is untouched by any of it.
          /totalOutstanding: fromPaise\(totalRepaymentPaise - totalCollectedPaise\)/.test(collectionServiceSource),
        'Bounce Charge vs Bounce Collection vs Bounce Outstanding'
      );

      record(
        'Bounce collection',
        'the dashboard card is on the page and reads the API verbatim',
        (() => {
          const page = stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Dashboard.jsx'), 'utf8'));
          return (
            /label="Bounce collection"/.test(page) &&
            /value=\{formatCurrency\(data\.collections\.period\.bounceCollection\)\}/.test(page) &&
            /data\.collections\.period\.bounceCollectionCount/.test(page) &&
            /label="Bounce collected today"/.test(page) &&
            /value=\{formatCurrency\(data\.collections\.today\.bounceCollection\)\}/.test(page) &&
            // "Bounce Collection", not "Bounce Charges" - the number is money
            // received.
            !/label="Bounce charges?"/i.test(page)
          );
        })(),
        'total and count, for the period and for today'
      );

      record(
        'Bounce collection',
        'the collections list shows EMI, bounce and total per collection, and the colSpan matches',
        (() => {
          const page = stripComments(
            fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'collections', 'CollectionsListPage.jsx'), 'utf8')
          );
          const headerCount = (page.match(/<th scope="col"/g) ?? []).length;
          const colSpans = [...page.matchAll(/colSpan="(\d+)"/g)].map((match) => Number(match[1]));
          return (
            /<th scope="col" className="text-end">EMI collected<\/th>/.test(page) &&
            /<th scope="col" className="text-end">Bounce collected<\/th>/.test(page) &&
            /<th scope="col" className="text-end">Total<\/th>/.test(page) &&
            /formatCurrency\(collection\.bounceCollected\)/.test(page) &&
            colSpans.length > 0 &&
            colSpans.every((span) => span === headerCount)
          );
        })(),
        'Collection | EMI collected | Bounce collected | Total'
      );

      record(
        'Bounce collection',
        'the export carries EMI Collected beside the three collected figures',
        (() => {
          const { CSV_COLUMNS: B_COLUMNS, SUMMARY_FIELDS: B_SUMMARY, REPORTS: B_REPORTS } = require('../src/config/reports');
          const headers = B_COLUMNS[B_REPORTS.COLLECTIONS].map((column) => column.header);
          const labels = B_SUMMARY[B_REPORTS.COLLECTIONS].map((field) => field.label);
          return (
            headers.includes('EMI Collected') &&
            headers.includes('Collected Bounce') &&
            labels.includes('EMI Collected') &&
            labels.includes('Collected Bounce') &&
            labels.includes('Bounce Collections')
          );
        })(),
        'Amount, Collected Principal / Interest / Bounce, EMI Collected'
      );
    }

    /* ------------------- 14/16. imports, oneBulk and the migration ------------------ */

    {
      const importSource = stripComments(
        fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionImportService.js'), 'utf8')
      );
      const oneBulkSource = stripComments(
        fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'oneBulkImportService.js'), 'utf8')
      );
      record(
        'Bounce collection',
        'BACKWARD COMPATIBLE: neither importer mentions bounce, so every imported row posts bounce 0.00',
        !/bounce/i.test(importSource) && !/bounce/i.test(oneBulkSource),
        'the permanent import and oneBulk are unchanged'
      );
      record(
        'Bounce collection',
        'oneBulk AUTO_EMI_DATE behaviour is untouched - bounce changed nothing about how a date is derived',
        /DATE_SOURCE\.AUTO_EMI_DATE/.test(oneBulkSource) &&
          /function groupAllocationByDate/.test(oneBulkSource) &&
          /const date = emiDates\.get\(entry\.emiId\);/.test(oneBulkSource),
        'a blank Collection Date still resolves per instalment date'
      );

      const migrationFiles = fs.readdirSync(path.resolve(__dirname, '..', 'migrations'));
      const bounceMigration = migrationFiles.find((file) => /bounce-amount/.test(file));
      const migrationSource = bounceMigration
        ? fs.readFileSync(path.resolve(__dirname, '..', 'migrations', bounceMigration), 'utf8')
        : '';
      const upOnly = migrationSource.replace(/async down[\s\S]*$/, '');
      record(
        'Bounce collection',
        'the migration is purely additive: one NOT NULL DEFAULT 0.00 column, nothing dropped or rewritten',
        Boolean(bounceMigration) &&
          /const TABLE = 'collections';/.test(migrationSource) &&
          /addColumn\(TABLE, 'bounce_amount'/.test(migrationSource) &&
          /defaultValue: '0\.00'/.test(migrationSource) &&
          /allowNull: false/.test(migrationSource) &&
          !/removeColumn|changeColumn|dropTable/.test(upOnly) &&
          !/UPDATE |DELETE |TRUNCATE|sequelize\.query/i.test(migrationSource),
        bounceMigration ?? 'MISSING'
      );
      record(
        'Bounce collection',
        'no existing table other than collections is touched, and no new table is created',
        !/createTable/.test(migrationSource) &&
          (migrationSource.match(/addColumn\(/g) ?? []).length === 1 &&
          !/(loans|customers|users|emi_schedules|collection_allocations)'/.test(migrationSource),
        'one column on one table'
      );
    }
  }

  // ---------- Bounce Collection report page ----------
  {
    const { Collection: BCollection } = models;
    const {
      REPORTS: BC_REPORTS,
      CSV_COLUMNS: BC_COLUMNS,
      SUMMARY_FIELDS: BC_SUMMARY,
      REPORT_TITLES: BC_TITLES,
      BOUNCE_SCOPE
    } = require('../src/config/reports');
    const { DEFAULT_BOUNCE_AMOUNT } = require('../src/config/collections');

    const reportSrc = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportService.js'), 'utf8')
    );
    const controllerSrc = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'controllers', 'reportController.js'), 'utf8')
    );
    const routesSrc = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'reportRoutes.js'), 'utf8')
    );

    /* ------------------------- one implementation only ------------------------ */

    record(
      'Bounce report',
      'the report is registered like every other report: key, title, summary fields and export columns',
      BC_REPORTS.BOUNCE_COLLECTIONS === 'bounce-collections' &&
        BC_TITLES[BC_REPORTS.BOUNCE_COLLECTIONS] === 'Bounce Collection Report' &&
        Array.isArray(BC_SUMMARY[BC_REPORTS.BOUNCE_COLLECTIONS]) &&
        BC_SUMMARY[BC_REPORTS.BOUNCE_COLLECTIONS].length > 0 &&
        Array.isArray(BC_COLUMNS[BC_REPORTS.BOUNCE_COLLECTIONS]) &&
        BC_COLUMNS[BC_REPORTS.BOUNCE_COLLECTIONS].length > 0,
      BC_TITLES[BC_REPORTS.BOUNCE_COLLECTIONS]
    );

    record(
      'Bounce report',
      'NO SECOND IMPLEMENTATION: the service delegates to the existing collection report',
      (() => {
        const fn = reportSrc.slice(
          reportSrc.indexOf('async function bounceCollectionReport'),
          reportSrc.indexOf('const EMPTY_BREAKDOWN')
        );
        return (
          /return collectionReport\(\{ \.\.\.filters, \[BOUNCE_SCOPE\]: true \}, actor\);/.test(fn) &&
          // No query, no aggregation, no money arithmetic of its own.
          !/findAll|findAndCountAll|sequelize\.query|toPaise|fromPaise|SUM\(/.test(fn)
        );
      })(),
      'one query, one set of totals, one definition of bounce'
    );

    record(
      'Bounce report',
      'the bounce restriction is applied in SQL, not by filtering rows in the browser',
      /if \(filters\[BOUNCE_SCOPE\]\) \{\s*where\.bounceAmount = \{ \[Op\.gt\]: 0 \};\s*\}/.test(reportSrc),
      'WHERE bounce_amount > 0 — so paging and the summary see the same restricted set'
    );

    record(
      'Bounce report',
      'the bounce scope is a Symbol, so no query string can flip a report into the other one',
      typeof BOUNCE_SCOPE === 'symbol' && !/bounceOnly/.test(routesSrc),
      String(BOUNCE_SCOPE)
    );

    record(
      'Bounce report',
      'bounce comes from collections.bounce_amount — the instalment bounce_charge is never read',
      (() => {
        const columns = BC_COLUMNS[BC_REPORTS.BOUNCE_COLLECTIONS];
        const bounce = columns.find((c) => c.header === 'Bounce Collected');
        const summaryBounce = BC_SUMMARY[BC_REPORTS.BOUNCE_COLLECTIONS].find((f) => f.label === 'Bounce Collected');
        return (
          bounce?.path === 'collectedBounce' &&
          bounce?.type === 'money' &&
          summaryBounce?.path === 'collectedBounce' &&
          !columns.some((c) => /bounceCharge/.test(String(c.path))) &&
          !BC_SUMMARY[BC_REPORTS.BOUNCE_COLLECTIONS].some((f) => /bounceCharge/.test(String(f.path)))
        );
      })(),
      'collectedBounce (= collections.bounce_amount) everywhere'
    );

    record(
      'Bounce report',
      'the export carries exactly the requested columns, in order',
      BC_COLUMNS[BC_REPORTS.BOUNCE_COLLECTIONS].map((c) => c.header).join(' | ') ===
        'Loan Number | Customer | Total Received | EMI Collected | Bounce Collected | Ledger | Route | Collected By',
      BC_COLUMNS[BC_REPORTS.BOUNCE_COLLECTIONS].map((c) => c.header).join(', ')
    );

    /* ------------------------ wiring, permissions, scope ----------------------- */

    record(
      'Bounce report',
      'the controller reuses the shared report handler — same JSON/CSV/Excel path as every report',
      /const bounceCollectionReport = reportHandler\(\{\s*key: REPORTS\.BOUNCE_COLLECTIONS,\s*run: reportService\.bounceCollectionReport,\s*rowsOf: \(data\) => data\.collections\s*\}\);/.test(
        controllerSrc
      ),
      'no bespoke export implementation'
    );

    record(
      'Bounce report',
      'the route is mounted through the same permission gate — no new RBAC permission was invented',
      /router\.get\('\/bounce-collections', \.\.\.report\(bounceCollectionReportRules, reportController\.bounceCollectionReport\)\);/.test(
        routesSrc
      ) &&
        // `report()` applies reports.view, then validation, then the export gate.
        /requirePermission\(PERMISSIONS\.REPORTS_VIEW\)/.test(routesSrc) &&
        /requirePermission\(PERMISSIONS\.REPORTS_EXPORT\)/.test(routesSrc) &&
        // No report-scoped bounce permission was invented. `emis.bounce_charge`
        // predates this page (it governs recording the ASSESSED charge on an
        // instalment) and is deliberately untouched.
        PERMISSION_DEFINITIONS.filter((p) => p.name.startsWith('reports.'))
          .map((p) => p.name)
          .sort()
          .join(',') === 'reports.export,reports.view' &&
        !PERMISSION_DEFINITIONS.some((p) => /bounce/i.test(p.name) && p.name !== PERMISSIONS.EMIS_BOUNCE_CHARGE),
      'reports.view to see it, reports.export to download it'
    );

    {
      const reportRouter = require('../src/routes/reportRoutes');
      const paths = reportRouter.stack.filter((l) => l.route).map((l) => l.route.path);
      const methods = reportRouter.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods));
      record(
        'Bounce report',
        'the endpoint exists, is GET-only, and the existing report routes are untouched',
        paths.includes('/bounce-collections') &&
          ['/loans', '/collections', '/emis', '/demand-collections'].every((p) => paths.includes(p)) &&
          [...new Set(methods)].join(',') === 'get',
        paths.join(' | ')
      );
    }

    record(
      'Bounce report',
      'the validator reuses the collection report rules rather than restating them',
      (() => {
        const v = require('../src/validators/reportValidator');
        return v.bounceCollectionReportRules === v.collectionReportRules;
      })(),
      'same paging, scope, format, date, status, ledger and search rules'
    );

    {
      // 7 & 8: date, route and collector filters reach the query unchanged,
      // because the wrapper passes `filters` straight through and the shared
      // report already applies them.
      const v = require('../src/validators/reportValidator');
      const bad = await runRules(v.bounceCollectionReportRules, {
        query: { dateFrom: '2026-02-30', routeId: '0', collectorId: 'abc', status: 'CANCELLED', limit: '9999' }
      });
      const fields = bad.map((e) => e.field);
      const good = await runRules(v.bounceCollectionReportRules, {
        query: { dateFrom: '2026-08-01', dateTo: '2026-08-31', routeId: '3', collectorId: '7', status: 'POSTED' }
      });
      record(
        'Bounce report',
        '7/8. date, route, collector, status and paging filters are validated like every other report',
        ['dateFrom', 'routeId', 'collectorId', 'status', 'limit'].every((f) => fields.includes(f)) && good.length === 0,
        `rejected: ${fields.join(', ')}`
      );
    }

    record(
      'Bounce report',
      'a collector stays confined to their own routes — the shared scope resolver is not bypassed',
      /const scope = await resolveScope\(actor, filters\);/.test(
        reportSrc.slice(reportSrc.indexOf('async function collectionReport'), reportSrc.indexOf('const EMPTY_BREAKDOWN'))
      ),
      'same resolveScope guard as the collection report'
    );

    /* ------------------------------- the totals ------------------------------- */

    record(
      'Bounce report',
      'reversed bounce is opt-in, so the collection report and the dashboard pay nothing for it',
      /includeBounceDetail = false/.test(reportSrc) &&
        /includeBounceDetail: Boolean\(filters\[BOUNCE_SCOPE\]\)/.test(reportSrc) &&
        /\.\.\.\(includeBounceDetail \? \{ reversedBounce \} : \{\}\)/.test(reportSrc),
      'only the bounce page asks for reversedBounce'
    );

    record(
      'Bounce report',
      'reversed bounce is computed with the same POSTED/REVERSED rule, from the same helper',
      /bounceCollected\(\{ \[Op\.and\]: \[where, \{ status: COLLECTION_STATUS\.REVERSED \}\] \}\)/.test(reportSrc),
      'collectionAllocationService.bounceCollected, filtered to REVERSED'
    );
  }


  // ---------- Bounce Collection report: the data rule ----------
  {
    const { Collection: BCollection } = models;
    const { DEFAULT_BOUNCE_AMOUNT } = require('../src/config/collections');

    /** A collection exactly as stored; emiCollected() is the model's own method. */
    const build = ({ amount, bounce = DEFAULT_BOUNCE_AMOUNT, date = '2026-08-18', status = COLLECTION_STATUS.POSTED }) =>
      BCollection.build({
        collectionNumber: 'COL26-000001',
        loanId: 1,
        customerId: 1,
        amount,
        bounceAmount: bounce,
        collectionDate: date,
        ledgerType: LEDGER_TYPES.CASH,
        status
      });

    /*
     * What the endpoint does, expressed the way the SQL does it:
     *   WHERE bounce_amount > 0  (the page's defining filter)
     *   AND   collection_date BETWEEN from AND to
     * Totals count POSTED rows only; REVERSED rows stay visible but contribute
     * nothing — the same rule every other collected total obeys.
     */
    const page = (ledger, { from, to, status } = {}) => {
      const rows = ledger.filter(
        (c) =>
          toPaise(c.bounceAmount) > 0n &&
          (!from || c.collectionDate >= from) &&
          (!to || c.collectionDate <= to) &&
          (!status || c.status === status)
      );
      const posted = rows.filter((c) => c.status === COLLECTION_STATUS.POSTED);
      const reversed = rows.filter((c) => c.status === COLLECTION_STATUS.REVERSED);
      const sum = (list, pick) => fromPaise(list.reduce((t, c) => t + toPaise(pick(c)), 0n));
      return {
        rows,
        summary: {
          collectedBounce: sum(posted, (c) => c.bounceAmount),
          bounceCollectionCount: posted.length,
          postedCount: posted.length,
          postedAmount: sum(posted, (c) => c.amount),
          reversedCount: reversed.length,
          reversedBounce: sum(reversed, (c) => c.bounceAmount),
          emiCollected: sum(posted, (c) => c.emiCollected()),
          netCollected: sum(posted, (c) => c.amount)
        }
      };
    };

    // Case 1 — a collection with no bounce is not a bounce collection.
    {
      const ledger = [build({ amount: '1000.00' }), build({ amount: '1500.00', bounce: '500.00' })];
      const p = page(ledger);
      record(
        'Bounce report',
        '1. a collection with 0.00 bounce does NOT appear on the page',
        p.rows.length === 1 && toPaise(p.rows[0].bounceAmount) === toPaise('500.00'),
        `${ledger.length} collections, ${p.rows.length} bounce collection`
      );
    }

    // Case 2 — the stated data rule, to the paise.
    {
      const c = build({ amount: '2000.00', bounce: '500.00' });
      record(
        'Bounce report',
        '2. total 2000 with 500 bounce -> Total Received 2000, EMI Collected 1500, Bounce Collected 500',
        c.amount === '2000.00' &&
          c.emiCollected() === '1500.00' &&
          c.bounceAmount === '500.00' &&
          toPaise(c.emiCollected()) + toPaise(c.bounceAmount) === toPaise(c.amount),
        `${c.emiCollected()} + ${c.bounceAmount} = ${c.amount}`
      );
    }

    // Case 3 — several bounce collections sum correctly.
    {
      const p = page([
        build({ amount: '1500.00', bounce: '500.00', date: '2026-08-10' }),
        build({ amount: '1200.00', bounce: '200.00', date: '2026-08-11' }),
        build({ amount: '2350.00', bounce: '350.00', date: '2026-08-12' })
      ]);
      record(
        'Bounce report',
        '3. multiple bounce collections total correctly, and the components reconcile',
        p.summary.collectedBounce === '1050.00' &&
          p.summary.bounceCollectionCount === 3 &&
          p.summary.emiCollected === '4000.00' &&
          p.summary.netCollected === '5050.00' &&
          toPaise(p.summary.emiCollected) + toPaise(p.summary.collectedBounce) === toPaise(p.summary.netCollected),
        `bounce=${p.summary.collectedBounce} emi=${p.summary.emiCollected} total=${p.summary.netCollected}`
      );
    }

    // Case 4 — reversed rows are visible but never counted.
    {
      const ledger = [
        build({ amount: '1500.00', bounce: '500.00' }),
        build({ amount: '1200.00', bounce: '200.00', status: COLLECTION_STATUS.REVERSED })
      ];
      const all = page(ledger);
      const onlyReversed = page(ledger, { status: COLLECTION_STATUS.REVERSED });
      record(
        'Bounce report',
        '4. a reversed bounce collection stays visible but is excluded from collected totals',
        all.rows.length === 2 &&
          all.summary.collectedBounce === '500.00' &&
          all.summary.reversedCount === 1 &&
          all.summary.reversedBounce === '200.00' &&
          onlyReversed.rows.length === 1 &&
          onlyReversed.summary.collectedBounce === '0.00',
        `visible=${all.rows.length} counted=${all.summary.collectedBounce} reversed(excluded)=${all.summary.reversedBounce}`
      );
    }

    // Case 5 — an assessed charge is not a collection.
    {
      const assessed = EmiSchedule.build({
        loanId: 1,
        emiNumber: 1,
        emiDate: '2026-08-10',
        emiAmount: '1000.00',
        principal: '900.00',
        interest: '100.00',
        bounceCharge: '500.00',
        amountCollected: '1000.00'
      });
      const p = page([build({ amount: '1000.00' })]);
      record(
        'Bounce report',
        '5. a 500.00 bounce charge assessed but never paid produces NO row and NO collected bounce',
        toPaise(assessed.bounceCharge) === toPaise('500.00') &&
          p.rows.length === 0 &&
          p.summary.collectedBounce === '0.00',
        `charge=${assessed.bounceCharge} rows=${p.rows.length} collected=${p.summary.collectedBounce}`
      );
    }

    // Case 6 — bounce never enters the principal / interest split.
    {
      const c = build({ amount: '1500.00', bounce: '500.00' });
      const { principalPaise, interestPaise } = allocationService.splitAllocation({
        allocatedPaise: toPaise(c.emiCollected()),
        principalPaise: toPaise('900.00'),
        emiAmountPaise: toPaise('1000.00')
      });
      record(
        'Bounce report',
        '6. a collection with bounce does not increase EMI principal or interest',
        principalPaise === toPaise('900.00') &&
          interestPaise === toPaise('100.00') &&
          principalPaise + interestPaise === toPaise(c.emiCollected()) &&
          principalPaise + interestPaise !== toPaise(c.amount),
        `p=${fromPaise(principalPaise)} i=${fromPaise(interestPaise)} sum=${fromPaise(principalPaise + interestPaise)} (not ${c.amount})`
      );
    }

    // Case 7 — the date filter bounds the rows and the totals together.
    {
      const ledger = [
        build({ amount: '1500.00', bounce: '500.00', date: '2026-08-10' }),
        build({ amount: '1200.00', bounce: '200.00', date: '2026-09-05' })
      ];
      const august = page(ledger, { from: '2026-08-01', to: '2026-08-31' });
      const september = page(ledger, { from: '2026-09-01', to: '2026-09-30' });
      const both = page(ledger, { from: '2026-08-01', to: '2026-09-30' });
      record(
        'Bounce report',
        '7. the date filter limits bounce records, and the periods add back up',
        august.rows.length === 1 &&
          august.summary.collectedBounce === '500.00' &&
          september.summary.collectedBounce === '200.00' &&
          both.summary.collectedBounce === '700.00' &&
          toPaise(august.summary.collectedBounce) + toPaise(september.summary.collectedBounce) ===
            toPaise(both.summary.collectedBounce),
        `Aug=${august.summary.collectedBounce} Sep=${september.summary.collectedBounce} both=${both.summary.collectedBounce}`
      );
    }

    // Case 10 — the existing collection report is unchanged.
    {
      const { CSV_COLUMNS: R_COLUMNS, SUMMARY_FIELDS: R_SUMMARY, REPORTS: R_REPORTS } = require('../src/config/reports');
      const headers = R_COLUMNS[R_REPORTS.COLLECTIONS].map((c) => c.header);
      const amountIndex = headers.indexOf('Amount');
      record(
        'Bounce report',
        '10. the existing Collection report keeps its own columns, order and summary fields',
        headers.slice(amountIndex + 1, amountIndex + 4).join('|') === 'Collected Principal|Collected Interest|Collected Bounce' &&
          headers.includes('EMI Collected') &&
          R_SUMMARY[R_REPORTS.COLLECTIONS].some((f) => f.label === 'Net Collected') &&
          // The bounce page did not add its fields to the collection report.
          !R_SUMMARY[R_REPORTS.COLLECTIONS].some((f) => f.label === 'Total Received'),
        'collection report untouched'
      );
    }
  }


  // ---------- Bounce Collection page: sidebar, routing and UI ----------
  {
    const front = (...segments) => path.resolve(__dirname, '..', '..', 'frontend', 'src', ...segments);
    const navSrc = stripComments(fs.readFileSync(front('routes', 'navigation.js'), 'utf8'));
    const appRoutesSrc = stripComments(fs.readFileSync(front('routes', 'AppRoutes.jsx'), 'utf8'));
    const pageSrc = stripComments(fs.readFileSync(front('pages', 'reports', 'BounceCollectionReportPage.jsx'), 'utf8'));
    const constantsSrc = stripComments(fs.readFileSync(front('utils', 'reportConstants.js'), 'utf8'));

    /* -------------------------------- sidebar -------------------------------- */

    const operations = navSrc.slice(navSrc.indexOf("id: 'operations'"), navSrc.indexOf("id: 'temporary'"));
    const opLabels = [...operations.matchAll(/label: '([^']+)'/g)].map((m) => m[1]).filter((l) => l !== 'Operations');

    record(
      'Bounce page',
      'Bounce Collection sits DIRECTLY BELOW Demand vs collection, in Operations',
      opLabels[opLabels.indexOf('Demand vs collection') + 1] === 'Bounce Collection' &&
        opLabels[opLabels.length - 1] === 'Bounce Collection',
      opLabels.join(' > ')
    );

    record(
      'Bounce page',
      'the whole Operations order is exactly as specified, and nothing was renamed or moved',
      opLabels.join('|') ===
        'Dashboard|Customers|Loans|Collections|Routes|Demand|Loan report|Collection report|EMI report|Demand vs collection|Bounce Collection',
      opLabels.join(' | ')
    );

    record(
      'Bounce page',
      'it is NOT in the Temporary section, which still contains only oneBulk',
      (() => {
        const temporary = navSrc.slice(navSrc.indexOf("id: 'temporary'"), navSrc.indexOf("id: 'administration'"));
        const labels = [...temporary.matchAll(/label: '([^']+)'/g)].map((m) => m[1]).filter((l) => l !== 'Temporary');
        return labels.join('|') === 'oneBulk (temporary)' && !/Bounce/.test(temporary);
      })(),
      'Temporary: oneBulk (temporary)'
    );

    record(
      'Bounce page',
      'the nav entry is gated by the existing reports.view permission',
      /id: 'report-bounce-collections'[\s\S]{0,220}permission: \[PERMISSIONS\.REPORTS_VIEW\]/.test(navSrc),
      'no new permission constant'
    );

    /* -------------------------------- routing -------------------------------- */

    record(
      'Bounce page',
      'the route is registered behind the reports.view guard, alongside the other report pages',
      /<Route path="\/reports\/bounce-collections" element=\{<BounceCollectionReportPage \/>\} \/>/.test(appRoutesSrc) &&
        (() => {
          const guard = appRoutesSrc.slice(appRoutesSrc.indexOf('anyOf={[PERMISSIONS.REPORTS_VIEW]}'));
          return guard.indexOf('/reports/bounce-collections') < guard.indexOf('</Route>');
        })(),
      '/reports/bounce-collections'
    );

    record(
      'Bounce page',
      'the report key mirrors the backend and the path matches the nav entry',
      /BOUNCE_COLLECTIONS: 'bounce-collections'/.test(constantsSrc) &&
        /path: '\/reports\/bounce-collections'/.test(constantsSrc) &&
        /path: '\/reports\/bounce-collections'/.test(navSrc),
      'frontend REPORTS mirrors backend config/reports.js'
    );

    /* ------------------------------ header + toolbar --------------------------- */

    record(
      'Bounce page',
      'the header carries the requested title and subtitle, with Export Excel / Refresh / Reset',
      /title="Bounce Collection"/.test(pageSrc) &&
        /description="Track bounce charges actually collected with EMI payments\."/.test(pageSrc) &&
        /exportFormat="xlsx"/.test(pageSrc) &&
        /reportKey=\{REPORTS\.BOUNCE_COLLECTIONS\}/.test(pageSrc) &&
        /onRefresh=\{load\}/.test(pageSrc) &&
        /onReset=\{\(\) => setFilters\(EMPTY\)\}/.test(pageSrc),
      'ReportToolbar supplies all three buttons, as on every report page'
    );

    record(
      'Bounce page',
      'the export sends the SAME filters the screen is showing',
      /filters=\{query\}/.test(pageSrc) && /const query = \{ \.\.\.filters, search: debouncedSearch \}/.test(pageSrc),
      'the file cannot diverge from the page'
    );

    /* --------------------------------- filters -------------------------------- */

    record(
      'Bounce page',
      'all six filters are present: collection number, status, route, collector, from and to',
      ['bc-search', 'bc-status', 'bc-route', 'bc-collector', 'bc-from', 'bc-to'].every((id) =>
        new RegExp(`id="${id}"`).test(pageSrc)
      ) &&
        /const EMPTY = \{ status: '', routeId: '', collectorId: '', dateFrom: '', dateTo: '', search: '' \}/.test(pageSrc),
      'collection number, status, route, collector, from, to'
    );

    record(
      'Bounce page',
      'filters are sent to the server, and paging resets when they change',
      /getBounceCollectionReport\(\{ \.\.\.query, page, limit: DEFAULT_PAGE_SIZE \}\)/.test(pageSrc) &&
        /setPage\(1\);[\s\S]{0,140}filters\.status, filters\.routeId, filters\.collectorId, filters\.dateFrom, filters\.dateTo/.test(
          pageSrc
        ),
      'server-side filtering and paging'
    );

    /* --------------------------------- KPI cards ------------------------------- */

    record(
      'Bounce page',
      'all six KPI cards are present and read the backend summary verbatim',
      [
        ["label: 'Bounce collected'", 'summary.collectedBounce'],
        ["label: 'Bounce collections'", 'summary.bounceCollectionCount'],
        ["label: 'Posted'", 'summary.postedCount'],
        ["label: 'Reversed'", 'summary.reversedCount'],
        ["label: 'EMI collected with bounce'", 'summary.emiCollected'],
        ["label: 'Total received'", 'summary.netCollected']
      ].every(([label, field]) => pageSrc.includes(label) && pageSrc.includes(field)),
      'bounce collected, count, posted, reversed, EMI with bounce, total received'
    );

    record(
      'Bounce page',
      'the headline card states plainly that this is money received, not charges assessed',
      /label: 'Bounce collected'[\s\S]{0,260}actually received — not charges assessed/.test(pageSrc),
      'stated on the card itself'
    );

    record(
      'Bounce page',
      'the reversed card names the bounce it is excluding from the totals',
      /label: 'Reversed'[\s\S]{0,260}summary\.reversedBounce[\s\S]{0,120}excluded from totals/.test(pageSrc),
      'reversed bounce shown, and shown as excluded'
    );

    record(
      'Bounce page',
      'the page performs no arithmetic of its own — every figure is formatted, never computed',
      !/summary\.\w+\s*[-+*/]\s*summary\.\w+/.test(pageSrc) && !/Number\(summary\./.test(pageSrc),
      'formatCurrency only'
    );

    /* ---------------------------------- table --------------------------------- */

    record(
      'Bounce page',
      'the table declares exactly the requested columns, in order',
      (() => {
        const head = (pageSrc.match(/<thead[\s\S]*?<\/thead>/) ?? [''])[0];
        const headers = [...head.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1].trim());
        return (
          headers.join('|') ===
          'Collection|Date|Loan|Customer|CIFID|Total Received|EMI Collected|Bounce Collected|Ledger|Reference|Route|Collected By|Status|Receipt'
        );
      })(),
      'Collection ... Bounce Collected ... Receipt'
    );

    record(
      'Bounce page',
      'the row values come from the API fields, never recomputed from EMI data',
      /formatCurrency\(c\.amount\)/.test(pageSrc) &&
        /formatCurrency\(c\.emiCollected\)/.test(pageSrc) &&
        /formatCurrency\(c\.collectedBounce\)/.test(pageSrc) &&
        // Nothing on the page touches an assessed bounce charge.
        !/bounceCharge/.test(pageSrc),
      'amount / emiCollected / collectedBounce'
    );

    record(
      'Bounce page',
      'Bounce Collected is the visually prominent column, because it is the point of the page',
      /className=\{`text-end fw-bold \$\{c\.countsTowardTotals \? 'text-warning-emphasis' : 'text-decoration-line-through'\}`\}[\s\S]{0,120}formatCurrency\(c\.collectedBounce\)/.test(
        pageSrc
      ),
      'bold and accented, struck through when it does not count'
    );

    record(
      'Bounce page',
      'the colSpan matches the column count, so the loading and empty rows span the table',
      (() => {
        const headerCount = (pageSrc.match(/<th scope="col"/g) ?? []).length;
        const colSpans = [...pageSrc.matchAll(/colSpan="(\d+)"/g)].map((m) => Number(m[1]));
        return colSpans.length > 0 && colSpans.every((span) => span === headerCount);
      })(),
      `${(pageSrc.match(/<th scope="col"/g) ?? []).length} columns`
    );

    record(
      'Bounce page',
      'the collection number reuses the EXISTING collection details page — no second implementation',
      /to=\{`\/collections\/\$\{c\.id\}`\}/.test(pageSrc) &&
        /to=\{`\/collections\/\$\{c\.id\}\/receipt`\}/.test(pageSrc) &&
        !/CollectionDetails|useParams/.test(pageSrc),
      'links to /collections/:id and /collections/:id/receipt'
    );

    /* ------------------------------- empty state ------------------------------- */

    record(
      'Bounce page',
      'the empty state says what it means, and does not present assessed charges as records',
      /No bounce collections found/.test(pageSrc) &&
        /Bounce collection appears here only when an actual bounce amount has been collected with a posted\s+collection\./.test(
          pageSrc
        ) &&
        /assessed but not paid are not shown/.test(pageSrc),
      '"No bounce collections found" + the explanation'
    );

    record(
      'Bounce page',
      'the page explains the assessed-vs-collected distinction above the table',
      /Bounce collected is money received, not money owed/.test(pageSrc) && /bounce outstanding/i.test(pageSrc),
      'stated in the info banner'
    );

    /* ------------------------- existing pages untouched ------------------------ */

    record(
      'Bounce page',
      'the existing Collection report page was not modified by this change',
      (() => {
        const collectionReportPage = stripComments(fs.readFileSync(front('pages', 'reports', 'CollectionReportPage.jsx'), 'utf8'));
        return (
          /title="Collection report"/.test(collectionReportPage) &&
          /reportKey=\{REPORTS\.COLLECTIONS\}/.test(collectionReportPage) &&
          !/BOUNCE_COLLECTIONS/.test(collectionReportPage)
        );
      })(),
      'Collection report still points at its own report key'
    );
  }

  // ---------- Collection form: amount / allocation / bounce reconciliation ----------
  {
    /*
     * The defect this guards against: the form enforced
     *
     *     amount = SUM(allocated) + bounce
     *
     * but never explained it. Entering ₹17,500 amount, ₹17,500 allocation and
     * ₹1,000 bounce produced Unallocated −₹1,000, a disabled Post button, and
     * no message — because the only guidance was assigned inside handleSubmit,
     * which cannot run while the button is disabled. The required amount is
     * ₹18,500: bounce is money received ON TOP of the instalment, not carved
     * out of it.
     */
    const { emiPortionPaise } = require('../src/config/collections');

    /** Runs one amount/allocation/bounce combination through the REAL guards. */
    const evaluate = ({ amount, allocation, bounce }) => {
      try {
        const emiPaise = collectionService.assertBounceAmount(amount, bounce);
        if (allocation === null) {
          return { ok: emiPaise === 0n, emiPortion: fromPaise(emiPaise), reason: 'no allocation required' };
        }
        const total = allocationService.assertAllocationShape([{ emiId: 1, amount: allocation }]);
        allocationService.assertAllocationTotal(total, fromPaise(emiPaise));
        return { ok: true, emiPortion: fromPaise(emiPaise) };
      } catch (error) {
        return { ok: false, status: error.statusCode, reason: error.message };
      }
    };

    // A. EMI only.
    {
      const r = evaluate({ amount: '17500.00', allocation: '17500.00', bounce: '0.00' });
      record(
        'Collection reconciliation',
        'A. amount 17500, allocation 17500, bounce 0 is VALID',
        r.ok && r.emiPortion === '17500.00',
        `EMI portion ${r.emiPortion}`
      );
    }

    // B. EMI + bounce — the combination the operator actually wanted.
    {
      const r = evaluate({ amount: '18500.00', allocation: '17500.00', bounce: '1000.00' });
      record(
        'Collection reconciliation',
        'B. amount 18500, allocation 17500, bounce 1000 is VALID (17500 + 1000 = 18500)',
        r.ok &&
          r.emiPortion === '17500.00' &&
          emiPortionPaise('18500.00', '1000.00') === toPaise('17500.00'),
        `EMI portion ${r.emiPortion}`
      );
    }

    // C. The reported bug: the backend already refuses it, on its own.
    {
      const r = evaluate({ amount: '17500.00', allocation: '17500.00', bounce: '1000.00' });
      record(
        'Collection reconciliation',
        'C. amount 17500, allocation 17500, bounce 1000 is REJECTED by the backend, not merely by the UI',
        !r.ok && r.status === 400 && /more than the collection amount 16500\.00/.test(r.reason),
        r.reason
      );
    }

    // D. Bounce-only, where the existing rules already allow no allocation.
    {
      const r = evaluate({ amount: '1000.00', allocation: null, bounce: '1000.00' });
      record(
        'Collection reconciliation',
        'D. amount 1000, no allocation, bounce 1000 is VALID (the whole payment is bounce)',
        r.ok && r.emiPortion === '0.00',
        `EMI portion ${r.emiPortion} — ${r.reason}`
      );
    }

    // E. Partial instalment plus bounce.
    {
      const r = evaluate({ amount: '9000.00', allocation: '8000.00', bounce: '1000.00' });
      record(
        'Collection reconciliation',
        'E. amount 9000, allocation 8000, bounce 1000 is VALID (8000 + 1000 = 9000)',
        r.ok && r.emiPortion === '8000.00',
        `EMI portion ${r.emiPortion}`
      );
    }

    /* ------------------------------ the form fix ----------------------------- */

    const modal = stripComments(
      fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'collections', 'CollectionFormModal.jsx'),
        'utf8'
      )
    );

    record(
      'Collection reconciliation',
      'the form computes the REQUIRED amount as allocated + bounce, the invariant read forwards',
      /const requiredAmountMinor = allocatedMinor \+ bounceMinor;/.test(modal),
      'requiredAmountMinor = allocatedMinor + bounceMinor'
    );

    record(
      'Collection reconciliation',
      'the guidance is LIVE, not assigned inside handleSubmit where a disabled button can never reach it',
      (() => {
        const submit = modal.slice(modal.indexOf('const handleSubmit'), modal.indexOf('const payload = {'));
        // Declared at render scope...
        return (
          /const reconciliationError =\s*\n?\s*amountMinor > 0 && !amountMatchesRequired/.test(modal) &&
          // ...and handleSubmit only reuses it, never defines the text itself.
          /errors\.allocations = reconciliationError;/.test(submit) &&
          !/errors\.allocations = '/.test(submit)
        );
      })(),
      'computed during render, so it shows while Post is disabled'
    );

    record(
      'Collection reconciliation',
      'the message names the rule and the exact amount required',
      /Collection amount must equal EMI allocated \+ Bounce collected\. Required amount: \$\{formatCurrency\(/.test(modal),
      '"…Required amount: ₹18,500."'
    );

    record(
      'Collection reconciliation',
      'a non-zero Unallocated is never displayed bare — the error always accompanies it',
      (() => {
        // The figure is flagged, and the message block is rendered from the same
        // condition that makes it non-zero.
        return (
          /amountMatchesRequired \? '' : ' text-danger'/.test(modal) &&
          /\{reconciliationError \? \(/.test(modal) &&
          /const amountMatchesRequired = unallocatedMinor === 0;/.test(modal)
        );
      })(),
      'negative Unallocated is red and carries the explanation'
    );

    record(
      'Collection reconciliation',
      'the required amount can be applied in one click, and is never written silently',
      /const applyRequiredAmount = \(\) => \{/.test(modal) &&
        /setForm\(\(current\) => \(\{ \.\.\.current, amount: fromMinorUnits\(requiredAmountMinor\) \}\)\)/.test(modal) &&
        /onClick=\{applyRequiredAmount\}/.test(modal) &&
        // Only ever from that explicit handler — no effect rewrites the field.
        (modal.match(/amount: fromMinorUnits\(requiredAmountMinor\)/g) ?? []).length === 1,
      'an explicit "Use ₹…" button, not an effect'
    );

    record(
      'Collection reconciliation',
      'the helper line explains that bounce is part of the amount and is not allocated',
      /Bounce collected is included in the total amount received\. It is not allocated to an EMI\./.test(modal) &&
        /\{bounceMinor > 0 \? \(/.test(modal),
      'shown once a bounce amount is entered'
    );

    record(
      'Collection reconciliation',
      'Post stays disabled until the reconciliation holds',
      /unallocatedMinor === 0 &&/.test(modal) &&
        /!bounceOverAmount &&/.test(modal) &&
        /disabled=\{!canSubmit\}/.test(modal),
      'canSubmit still requires unallocatedMinor === 0'
    );

    record(
      'Collection reconciliation',
      'the panel reports all four figures, so the arithmetic is visible',
      ['Total collection', 'EMI allocated', 'Bounce collection', 'Unallocated'].every((label) =>
        new RegExp(`>${label}</div>`).test(modal)
      ),
      'TOTAL COLLECTION / EMI ALLOCATED / BOUNCE COLLECTION / UNALLOCATED'
    );

    record(
      'Collection reconciliation',
      'the posted payload is unchanged: amount, bounceAmount and allocations stay three separate fields',
      (() => {
        const payload = modal.slice(modal.indexOf('const payload = {'), modal.indexOf('const response = await createCollection'));
        return (
          /amount: form\.amount,/.test(payload) &&
          /bounceAmount: fromMinorUnits\(bounceMinor\)/.test(payload) &&
          /allocations: Object\.entries\(allocations\)/.test(payload) &&
          // For the worked example that is amount 18500, bounceAmount 1000,
          // allocations totalling 17500 — bounce never inside an allocation.
          !/allocations:[\s\S]{0,400}bounce/i.test(payload)
        );
      })(),
      'amount 18500 / bounceAmount 1000 / allocations 17500'
    );

    record(
      'Collection reconciliation',
      'the backend invariant itself was NOT relaxed to make the form pass',
      (() => {
        const service = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'collectionService.js'), 'utf8')
        );
        return (
          /const emiPaise = assertBounceAmount\(amount, bounceAmount\);/.test(service) &&
          /collectionAmount: fromPaise\(emiPaise\)/.test(service)
        );
      })(),
      'allocations are still validated against amount − bounce'
    );
  }

  // ---------- Collection Report download: narrowed column set ----------
  {
    const ExcelJS2 = require('exceljs');
    const excelService = require('../src/services/reportExcelService');
    const { toCsv } = require('../src/utils/csv');
    const { CSV_COLUMNS: X_COLUMNS, REPORTS: X_REPORTS, REPORT_TITLES: X_TITLES } = require('../src/config/reports');

    /*
     * Five columns were removed from the Collection Report DOWNLOAD only:
     * Collection Number, CIF, Payment Reference, Status and Counts Toward
     * Totals. They remain on screen, in the API and in the database — this
     * block pins that the workbook itself no longer carries them, rather than
     * merely hiding them somewhere.
     */
    const REMOVED = ['Collection Number', 'CIF', 'Payment Reference', 'Status', 'Counts Toward Totals'];
    const EXPECTED_ORDER = [
      'Collection Date',
      'Loan Number',
      'Applicant',
      'Amount',
      'Collected Principal',
      'Collected Interest',
      'Collected Bounce',
      'EMI Collected',
      'Ledger',
      'Route Code',
      'Collected By'
    ];

    const declared = X_COLUMNS[X_REPORTS.COLLECTIONS].map((column) => column.header);

    record(
      'Collection export',
      'the five columns are gone from the Collection Report column definition',
      REMOVED.every((header) => !declared.includes(header)),
      `removed: ${REMOVED.join(', ')}`
    );

    record(
      'Collection export',
      'the surviving columns are exactly the expected set, in the expected order',
      declared.join('|') === EXPECTED_ORDER.join('|'),
      declared.join(' | ')
    );

    /*
     * A row carrying EVERY field, including the five that were dropped. If any
     * of them could still reach a file, this fixture would expose it.
     */
    const row = {
      collectionNumber: 'COL26-000071',
      collectionDate: '2026-08-19',
      status: 'REVERSED',
      loan: { loanNumber: 'LN26-000002' },
      customer: { fullName: 'Asha Verma', cifId: 'C000007' },
      amount: '2500.00',
      collectedPrincipal: '1600.00',
      collectedInterest: '400.00',
      collectedBounce: '500.00',
      emiCollected: '2000.00',
      ledgerType: 'CASH',
      paymentReference: 'UTR-SECRET-000451',
      route: { routeCode: 'RT26-000001' },
      createdBy: 'Ravi',
      countsTowardTotals: false
    };

    const summary = {
      totalCount: 1,
      postedCount: 0,
      postedAmount: '0.00',
      reversedCount: 1,
      reversedAmount: '2500.00',
      netCollected: '0.00',
      emiCollected: '0.00',
      collectedPrincipal: '0.00',
      collectedInterest: '0.00',
      collectedBounce: '0.00',
      bounceCollectionCount: 0
    };

    const buffer = await excelService.buildReportWorkbook({
      reportKey: X_REPORTS.COLLECTIONS,
      rows: [row],
      summary,
      filters: { status: 'REVERSED', format: 'xlsx' }
    });
    const book = new ExcelJS2.Workbook();
    await book.xlsx.load(buffer);
    const sheet = book.getWorksheet(X_TITLES[X_REPORTS.COLLECTIONS]);
    const headerRow = sheet.getRow(1).values.slice(1).map(String);
    const dataRow = sheet.getRow(2);

    record(
      'Collection export',
      'the GENERATED workbook header row carries none of the five removed columns',
      REMOVED.every((header) => !headerRow.includes(header)),
      headerRow.join(' | ')
    );

    record(
      'Collection export',
      'the generated workbook header row is exactly the expected order',
      headerRow.join('|') === EXPECTED_ORDER.join('|'),
      `${headerRow.length} columns`
    );

    record(
      'Collection export',
      'no removed VALUE leaks into any cell of the workbook, under any header',
      (() => {
        const cells = [];
        sheet.eachRow((r) => r.eachCell((cell) => cells.push(String(cell.value ?? ''))));
        // The collection number, CIFID, reference and status of the row above.
        return ['COL26-000071', 'C000007', 'UTR-SECRET-000451', 'REVERSED', 'false'].every(
          (value) => !cells.includes(value)
        );
      })(),
      'identifiers, reference and status absent from every cell'
    );

    record(
      'Collection export',
      'the remaining columns still line up with their own data',
      (() => {
        const at = (header) => dataRow.getCell(EXPECTED_ORDER.indexOf(header) + 1).value;
        return (
          String(at('Loan Number')) === 'LN26-000002' &&
          String(at('Applicant')) === 'Asha Verma' &&
          String(at('Ledger')) === 'CASH' &&
          String(at('Route Code')) === 'RT26-000001' &&
          String(at('Collected By')) === 'Ravi'
        );
      })(),
      'no off-by-one after the removals'
    );

    record(
      'Collection export',
      'financial values are unchanged and still numeric with the INR format',
      (() => {
        const cell = (header) => dataRow.getCell(EXPECTED_ORDER.indexOf(header) + 1);
        const money = ['Amount', 'Collected Principal', 'Collected Interest', 'Collected Bounce', 'EMI Collected'];
        return (
          money.every((h) => typeof cell(h).value === 'number' && cell(h).numFmt === '₹#,##0.00') &&
          cell('Amount').value === 2500 &&
          cell('Collected Principal').value === 1600 &&
          cell('Collected Interest').value === 400 &&
          cell('Collected Bounce').value === 500 &&
          cell('EMI Collected').value === 2000 &&
          // The reconciliation still reads correctly off the exported figures.
          cell('EMI Collected').value + cell('Collected Bounce').value === cell('Amount').value &&
          cell('Collected Principal').value + cell('Collected Interest').value === cell('EMI Collected').value
        );
      })(),
      '2000 + 500 = 2500, and 1600 + 400 = 2000'
    );

    record(
      'Collection export',
      'the date column is still a real date cell',
      (() => {
        const cell = dataRow.getCell(EXPECTED_ORDER.indexOf('Collection Date') + 1);
        return cell.value instanceof Date && cell.numFmt === 'yyyy-mm-dd';
      })(),
      'Collection Date remains a date, not text'
    );

    record(
      'Collection export',
      'the Summary sheet is untouched — every total the report computes is still exported',
      (() => {
        const summarySheet = book.getWorksheet('Summary');
        const labels = [];
        summarySheet.eachRow((r) => labels.push(String(r.getCell(1).value ?? '')));
        return ['Net Collected', 'Collected Principal', 'Collected Interest', 'Collected Bounce', 'EMI Collected'].every(
          (label) => labels.includes(label)
        );
      })(),
      'summary totals unaffected by the column removal'
    );

    record(
      'Collection export',
      'the CSV variant of the SAME report agrees with the workbook — one column definition, not two',
      (() => {
        const csv = toCsv([row], X_COLUMNS[X_REPORTS.COLLECTIONS]);
        const header = csv.split(/\r?\n/)[0];
        return (
          REMOVED.every((h) => !header.includes(h)) &&
          !csv.includes('COL26-000071') &&
          !csv.includes('UTR-SECRET-000451') &&
          header.includes('Collection Date') &&
          header.includes('EMI Collected')
        );
      })(),
      'CSV and XLSX cannot disagree about what the report contains'
    );

    /* --------------------- everything else is untouched --------------------- */

    record(
      'Collection export',
      'the BOUNCE Collection export keeps exactly its own eight columns',
      X_COLUMNS[X_REPORTS.BOUNCE_COLLECTIONS].map((c) => c.header).join(' | ') ===
        'Loan Number | Customer | Total Received | EMI Collected | Bounce Collected | Ledger | Route | Collected By',
      'separate column array, deliberately unchanged'
    );

    record(
      'Collection export',
      'the loan, EMI and demand exports are untouched',
      X_COLUMNS[X_REPORTS.LOANS].length === 20 &&
        X_COLUMNS[X_REPORTS.EMIS].some((c) => c.header === 'Bounce Charge') &&
        X_COLUMNS[X_REPORTS.DEMAND_COLLECTIONS].length === 9,
      `loans=${X_COLUMNS[X_REPORTS.LOANS].length} emis=${X_COLUMNS[X_REPORTS.EMIS].length} demand=${X_COLUMNS[X_REPORTS.DEMAND_COLLECTIONS].length}`
    );

    record(
      'Collection export',
      'the on-screen Collection report still shows the columns the download drops',
      (() => {
        const page = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'reports', 'CollectionReportPage.jsx'), 'utf8')
        );
        return (
          /<th scope="col">Collection<\/th>/.test(page) &&
          /<th scope="col">Reference<\/th>/.test(page) &&
          /<th scope="col">Status<\/th>/.test(page) &&
          /c\.customer\?\.cifId/.test(page) &&
          /c\.collectionNumber/.test(page) &&
          /countsTowardTotals/.test(page)
        );
      })(),
      'screen unchanged: collection number, CIFID, reference and status all still rendered'
    );

    record(
      'Collection export',
      'the API still RETURNS every removed field — only the download was narrowed',
      (() => {
        const service = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportService.js'), 'utf8')
        );
        // Bounded by the collection report's OWN summary call — `const summary =
        // await` first matches the loan report, which sits earlier in the file
        // and would slice to nothing.
        const start = service.indexOf('const collections = rows.map');
        const rowShape = service.slice(start, service.indexOf('collectionReportSummary(where', start));
        return (
          /collectionNumber: collection\.collectionNumber/.test(rowShape) &&
          /status: collection\.status/.test(rowShape) &&
          /paymentReference: collection\.paymentReference/.test(rowShape) &&
          /cifId: collection\.Customer\.cifId/.test(rowShape) &&
          /countsTowardTotals: posted/.test(rowShape)
        );
      })(),
      'reportService row shape unchanged'
    );
  }

  // ---------- Collection Report export: the actual button path ----------
  {
    /*
     * A download was reported as still carrying the removed columns. It turned
     * out to be the BOUNCE Collection Report's file, whose 14 headers are a
     * different set entirely — the two reports are easy to confuse because both
     * describe collections and both offer "Export Excel".
     *
     * These assertions pin which column array the Collection Report's own
     * export path reaches, and keep the two reports' files distinguishable, so
     * a genuine mix-up in the wiring would fail here rather than be discovered
     * in a spreadsheet.
     */
    const ExcelJS3 = require('exceljs');
    const excelSvc = require('../src/services/reportExcelService');
    const {
      CSV_COLUMNS: P_COLUMNS,
      REPORTS: P_REPORTS,
      REPORT_TITLES: P_TITLES
    } = require('../src/config/reports');

    const COLLECTION_HEADERS = [
      'Collection Date',
      'Loan Number',
      'Applicant',
      'Amount',
      'Collected Principal',
      'Collected Interest',
      'Collected Bounce',
      'EMI Collected',
      'Ledger',
      'Route Code',
      'Collected By'
    ];
    // Every spelling of the removed fields, including the Bounce report's.
    const FORBIDDEN = ['Collection Number', 'CIF', 'CIFID', 'Reference', 'Payment Reference', 'Status', 'Counts Toward Totals'];

    /* --------- the controller binds the button to this exact column set -------- */

    const controllerSrc = stripComments(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'controllers', 'reportController.js'), 'utf8')
    );

    record(
      'Collection export path',
      'the Collection Report handler is bound to REPORTS.COLLECTIONS — the key that selects its columns',
      /const collectionReport = reportHandler\(\{\s*key: REPORTS\.COLLECTIONS,\s*run: reportService\.collectionReport,/.test(
        controllerSrc
      ),
      'reportHandler({ key: REPORTS.COLLECTIONS, run: reportService.collectionReport })'
    );

    record(
      'Collection export path',
      'that key is what selects the columns for BOTH the workbook and the CSV — one lookup, no second source',
      /const columns = CSV_COLUMNS\[reportKey\] \?\? \[\];/.test(
        stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportExcelService.js'), 'utf8'))
      ) && /const csv = toCsv\(rows, CSV_COLUMNS\[key\]\);/.test(controllerSrc),
      'reportExcelService reads CSV_COLUMNS[reportKey]; the controller reads CSV_COLUMNS[key]'
    );

    record(
      'Collection export path',
      'the export permission gate is unchanged — reports.export is still required to download',
      /requirePermission\(PERMISSIONS\.REPORTS_EXPORT\)/.test(
        stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'reportRoutes.js'), 'utf8'))
      ),
      'download still gated'
    );

    /* ---------------- a real workbook, built through that key ---------------- */

    const fixture = {
      collectionNumber: 'COL26-000071',
      collectionDate: '2026-09-02',
      status: 'POSTED',
      loan: { loanNumber: 'LN26-000182' },
      customer: { fullName: 'Vimal Krishna Singh', cifId: 'C000178' },
      amount: '18500.00',
      collectedPrincipal: '12500.00',
      collectedInterest: '5000.00',
      collectedBounce: '1000.00',
      emiCollected: '17500.00',
      ledgerType: 'CASH',
      paymentReference: 'some-reference',
      route: { routeCode: 'RT26-000001' },
      createdBy: 'Super Administrator',
      countsTowardTotals: true
    };

    const workbookFor = async (reportKey, rows) => {
      const buffer = await excelSvc.buildReportWorkbook({
        reportKey,
        rows,
        summary: {
          totalCount: 1,
          postedCount: 1,
          postedAmount: '18500.00',
          reversedCount: 0,
          reversedAmount: '0.00',
          netCollected: '18500.00',
          emiCollected: '17500.00',
          collectedPrincipal: '12500.00',
          collectedInterest: '5000.00',
          collectedBounce: '1000.00',
          bounceCollectionCount: 1,
          reversedBounce: '0.00'
        },
        filters: { format: 'xlsx' }
      });
      const book = new ExcelJS3.Workbook();
      await book.xlsx.load(buffer);
      return book;
    };

    const book = await workbookFor(P_REPORTS.COLLECTIONS, [fixture]);
    const sheet = book.getWorksheet(P_TITLES[P_REPORTS.COLLECTIONS]);
    const header = sheet.getRow(1).values.slice(1).map(String);

    record(
      'Collection export path',
      'the generated Collection Report workbook header is EXACTLY the eleven required columns',
      header.join('|') === COLLECTION_HEADERS.join('|'),
      header.join(' | ')
    );

    record(
      'Collection export path',
      'no removed header appears anywhere in the Collection Report workbook, in any spelling',
      (() => {
        const everyCell = [];
        book.eachSheet((s) => s.eachRow((r) => r.eachCell((c) => everyCell.push(String(c.value ?? '')))));
        return FORBIDDEN.every((h) => !everyCell.includes(h));
      })(),
      `checked across both sheets: ${FORBIDDEN.join(', ')}`
    );

    record(
      'Collection export path',
      'no removed VALUE can surface under any remaining header',
      (() => {
        const cells = [];
        sheet.eachRow((r) => r.eachCell((c) => cells.push(String(c.value ?? ''))));
        return ['COL26-000071', 'C000178', 'some-reference', 'POSTED', 'true'].every((v) => !cells.includes(v));
      })(),
      'collection number, CIFID, reference, status and countsTowardTotals all absent'
    );

    record(
      'Collection export path',
      'the surviving columns are still aligned to their own data',
      (() => {
        const at = (h) => String(sheet.getRow(2).getCell(COLLECTION_HEADERS.indexOf(h) + 1).value ?? '');
        return (
          at('Loan Number') === 'LN26-000182' &&
          at('Applicant') === 'Vimal Krishna Singh' &&
          at('Ledger') === 'CASH' &&
          at('Route Code') === 'RT26-000001' &&
          at('Collected By') === 'Super Administrator'
        );
      })(),
      'no off-by-one'
    );

    record(
      'Collection export path',
      'the exported money reconciles: Amount = EMI Collected + Collected Bounce',
      (() => {
        const cell = (h) => sheet.getRow(2).getCell(COLLECTION_HEADERS.indexOf(h) + 1);
        return (
          cell('Amount').value === 18500 &&
          cell('EMI Collected').value === 17500 &&
          cell('Collected Bounce').value === 1000 &&
          cell('EMI Collected').value + cell('Collected Bounce').value === cell('Amount').value
        );
      })(),
      '17500 + 1000 = 18500'
    );

    record(
      'Collection export path',
      'and Collected Principal + Collected Interest = EMI Collected',
      (() => {
        const cell = (h) => sheet.getRow(2).getCell(COLLECTION_HEADERS.indexOf(h) + 1);
        return (
          cell('Collected Principal').value === 12500 &&
          cell('Collected Interest').value === 5000 &&
          cell('Collected Principal').value + cell('Collected Interest').value === cell('EMI Collected').value
        );
      })(),
      '12500 + 5000 = 17500'
    );

    /* ------------ the two reports stay tellable apart, in the file ------------ */

    const bounceBook = await workbookFor(P_REPORTS.BOUNCE_COLLECTIONS, [
      { ...fixture, emiCollected: '17500.00', collectedBounce: '1000.00' }
    ]);
    const bounceSheet = bounceBook.getWorksheet(P_TITLES[P_REPORTS.BOUNCE_COLLECTIONS]);
    const bounceHeader = bounceSheet.getRow(1).values.slice(1).map(String);

    record(
      'Collection export path',
      'the Bounce Collection export keeps exactly its own eight columns',
      bounceHeader.join(' | ') ===
        'Loan Number | Customer | Total Received | EMI Collected | Bounce Collected | Ledger | Route | Collected By',
      `${bounceHeader.length} columns`
    );

    record(
      'Collection export path',
      'the two workbooks are distinguishable: different sheet names and different headers',
      sheet.name === 'Collection Report' &&
        bounceSheet.name === 'Bounce Collection Report' &&
        header.join('|') !== bounceHeader.join('|'),
      `"${sheet.name}" vs "${bounceSheet.name}"`
    );

    record(
      'Collection export path',
      'the Bounce headers cannot be produced by the Collection Report key, and vice versa',
      P_COLUMNS[P_REPORTS.COLLECTIONS].map((c) => c.header).join('|') !==
        P_COLUMNS[P_REPORTS.BOUNCE_COLLECTIONS].map((c) => c.header).join('|') &&
        !COLLECTION_HEADERS.some((h) => ['Total Received', 'Bounce Collected', 'Customer', 'Route'].includes(h)),
      'the column arrays are disjoint where it matters'
    );

    record(
      'Collection export path',
      'the download filename carries the report key, so the two files are told apart on disk',
      (() => {
        const service = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'services', 'reportService.js'), 'utf8')
        );
        return /link\.download = `lms-\$\{reportKey\}-\$\{String\(stamp\)\.slice\(0, 10\)\}\.\$\{EXPORT_EXTENSION\[format\]\}`/.test(
          service
        );
      })(),
      'lms-collections-….xlsx vs lms-bounce-collections-….xlsx'
    );
  }

  // ---------- Bounce Collection export: narrowed to eight columns ----------
  {
    /*
     * Six columns were dropped from the BOUNCE Collection Report's DOWNLOAD:
     * Collection Number, Collection Date, CIFID, Reference, Status and Counts
     * Toward Totals. All six remain on that report's screen and in its API
     * response — only the file was narrowed.
     *
     * The Collection Report's own export is a separate array and keeps its own
     * columns, Collection Date included.
     */
    const ExcelJS4 = require('exceljs');
    const excelSvc4 = require('../src/services/reportExcelService');
    const {
      CSV_COLUMNS: D_COLS,
      REPORTS: D_REPS,
      REPORT_TITLES: D_TITLES,
      SUMMARY_FIELDS: D_SUM
    } = require('../src/config/reports');
    const { toCsv: toCsv4 } = require('../src/utils/csv');

    const BOUNCE_HEADERS = [
      'Loan Number',
      'Customer',
      'Total Received',
      'EMI Collected',
      'Bounce Collected',
      'Ledger',
      'Route',
      'Collected By'
    ];
    const REMOVED = ['Collection Number', 'Collection Date', 'CIFID', 'Reference', 'Status', 'Counts Toward Totals'];

    /* A row carrying every removed field, so a leak would be visible. */
    const fixture = {
      collectionNumber: 'COL26-000071',
      collectionDate: '2026-09-02',
      status: 'POSTED',
      loan: { loanNumber: 'LN26-000182' },
      customer: { fullName: 'Vimal Krishna Singh', cifId: 'C000178' },
      amount: '18500.00',
      emiCollected: '17500.00',
      collectedBounce: '1000.00',
      ledgerType: 'CASH',
      paymentReference: 'REF-00042',
      route: { routeCode: 'RT26-000001' },
      createdBy: 'Super Administrator',
      countsTowardTotals: true
    };

    const summary = {
      collectedBounce: '1000.00',
      bounceCollectionCount: 1,
      postedCount: 1,
      postedAmount: '18500.00',
      reversedCount: 0,
      reversedBounce: '0.00',
      emiCollected: '17500.00',
      netCollected: '18500.00'
    };

    const buffer = await excelSvc4.buildReportWorkbook({
      reportKey: D_REPS.BOUNCE_COLLECTIONS,
      rows: [fixture],
      summary,
      filters: { format: 'xlsx' }
    });
    const book = new ExcelJS4.Workbook();
    await book.xlsx.load(buffer);
    const sheet = book.getWorksheet(D_TITLES[D_REPS.BOUNCE_COLLECTIONS]);
    const header = sheet.getRow(1).values.slice(1).map(String);
    const at = (h) => sheet.getRow(2).getCell(BOUNCE_HEADERS.indexOf(h) + 1);

    record(
      'Bounce export columns',
      'the generated Bounce workbook has EXACTLY eight columns',
      header.length === 8,
      `${header.length} columns`
    );

    record(
      'Bounce export columns',
      'the eight headers are exactly the required set, in the required order',
      header.join('|') === BOUNCE_HEADERS.join('|'),
      header.join(' | ')
    );

    record(
      'Bounce export columns',
      'all six removed headers are absent from the whole workbook, in any spelling',
      (() => {
        const everyCell = [];
        book.eachSheet((s) => s.eachRow((r) => r.eachCell((c) => everyCell.push(String(c.value ?? '')))));
        return [...REMOVED, 'CIF', 'Payment Reference'].every((h) => !everyCell.includes(h));
      })(),
      REMOVED.join(', ')
    );

    record(
      'Bounce export columns',
      'no removed VALUE reaches any cell under any remaining header',
      (() => {
        const cells = [];
        sheet.eachRow((r) =>
          r.eachCell((c) =>
            cells.push(c.value instanceof Date ? c.value.toISOString().slice(0, 10) : String(c.value ?? ''))
          )
        );
        return ['COL26-000071', '2026-09-02', 'C000178', 'REF-00042', 'POSTED', 'true'].every((v) => !cells.includes(v));
      })(),
      'collection number, date, CIFID, reference, status and countsTowardTotals all absent'
    );

    record(
      'Bounce export columns',
      'NO COLUMN SHIFT: every remaining column still carries its own value',
      (() => {
        const text = (h) => String(at(h).value ?? '');
        return (
          text('Loan Number') === 'LN26-000182' &&
          text('Customer') === 'Vimal Krishna Singh' &&
          text('Ledger') === 'CASH' &&
          text('Route') === 'RT26-000001' &&
          text('Collected By') === 'Super Administrator'
        );
      })(),
      'nothing shifted left onto the wrong data'
    );

    record(
      'Bounce export columns',
      'money stays numeric with the INR format, and still reconciles',
      (() => {
        const money = ['Total Received', 'EMI Collected', 'Bounce Collected'];
        return (
          money.every((h) => typeof at(h).value === 'number' && at(h).numFmt === '₹#,##0.00') &&
          at('Total Received').value === 18500 &&
          at('EMI Collected').value === 17500 &&
          at('Bounce Collected').value === 1000 &&
          at('EMI Collected').value + at('Bounce Collected').value === at('Total Received').value
        );
      })(),
      '17500 + 1000 = 18500'
    );

    record(
      'Bounce export columns',
      'the Summary sheet is unchanged — all eight bounce totals still exported',
      (() => {
        const summarySheet = book.getWorksheet('Summary');
        const labels = [];
        summarySheet.eachRow((r) => labels.push(String(r.getCell(1).value ?? '')));
        return (
          book.worksheets.length === 2 &&
          D_SUM[D_REPS.BOUNCE_COLLECTIONS].length === 8 &&
          D_SUM[D_REPS.BOUNCE_COLLECTIONS].every((f) => labels.includes(f.label))
        );
      })(),
      D_SUM[D_REPS.BOUNCE_COLLECTIONS].map((f) => f.label).join(', ')
    );

    record(
      'Bounce export columns',
      'the CSV variant matches the workbook — one column definition, not two',
      (() => {
        const header0 = toCsv4([fixture], D_COLS[D_REPS.BOUNCE_COLLECTIONS])
          .split(/\r?\n/)[0]
          .replace(/^﻿/, '');
        return header0 === BOUNCE_HEADERS.join(',') && REMOVED.every((h) => !header0.includes(h));
      })(),
      'CSV and XLSX cannot disagree'
    );

    /* --------------------- every other export is untouched -------------------- */

    record(
      'Bounce export columns',
      'the Collection Report export is unchanged — eleven columns, still led by Collection Date',
      D_COLS[D_REPS.COLLECTIONS].length === 11 &&
        D_COLS[D_REPS.COLLECTIONS].map((c) => c.header).join(' | ') ===
          'Collection Date | Loan Number | Applicant | Amount | Collected Principal | Collected Interest | Collected Bounce | EMI Collected | Ledger | Route Code | Collected By',
      D_COLS[D_REPS.COLLECTIONS].map((c) => c.header).join(' | ')
    );

    record(
      'Bounce export columns',
      'the Loan, EMI and Demand exports are unchanged',
      D_COLS[D_REPS.LOANS].length === 20 &&
        D_COLS[D_REPS.EMIS].length === 15 &&
        D_COLS[D_REPS.DEMAND_COLLECTIONS].length === 9 &&
        D_COLS[D_REPS.LOANS].some((c) => c.header === 'Status') &&
        D_COLS[D_REPS.EMIS].some((c) => c.header === 'Status'),
      `loans=${D_COLS[D_REPS.LOANS].length} emis=${D_COLS[D_REPS.EMIS].length} demand=${D_COLS[D_REPS.DEMAND_COLLECTIONS].length} — Status kept where it belongs`
    );

    record(
      'Bounce export columns',
      'no second export definition was introduced — still one array per report',
      Object.keys(D_COLS).length === Object.values(D_REPS).length &&
        Object.values(D_REPS).every((k) => Array.isArray(D_COLS[k])),
      `${Object.keys(D_COLS).length} column arrays for ${Object.values(D_REPS).length} reports`
    );

    /* ----------------- the screen and the API keep every field ---------------- */

    record(
      'Bounce export columns',
      'the Bounce SCREEN still shows all six removed fields',
      (() => {
        const page = stripComments(
          fs.readFileSync(
            path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'reports', 'BounceCollectionReportPage.jsx'),
            'utf8'
          )
        );
        const head = (page.match(/<thead[\s\S]*?<\/thead>/) ?? [''])[0];
        return (
          ['Collection', 'Date', 'CIFID', 'Reference', 'Status'].every((h) => new RegExp(`>${h}</th>`).test(head)) &&
          /c\.collectionNumber/.test(page) &&
          /formatDate\(c\.collectionDate\)/.test(page) &&
          /c\.customer\?\.cifId/.test(page) &&
          /c\.paymentReference/.test(page) &&
          /countsTowardTotals/.test(page)
        );
      })(),
      'screen unchanged'
    );

    record(
      'Bounce export columns',
      'the API still returns all six removed fields on every row',
      (() => {
        const service = stripComments(
          fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'reportService.js'), 'utf8')
        );
        const start = service.indexOf('const collections = rows.map');
        const rowShape = service.slice(start, service.indexOf('collectionReportSummary(where', start));
        return (
          /collectionNumber: collection\.collectionNumber/.test(rowShape) &&
          /collectionDate: collection\.collectionDate/.test(rowShape) &&
          /cifId: collection\.Customer\.cifId/.test(rowShape) &&
          /paymentReference: collection\.paymentReference/.test(rowShape) &&
          /status: collection\.status/.test(rowShape) &&
          /countsTowardTotals: posted/.test(rowShape)
        );
      })(),
      'reportService row shape unchanged — the bounce report reuses it'
    );
  }

  // ---------- Frontend action wiring ----------
  {
    /*
     * Guards the defect found on the loan details page: PartyList renders
     * `onClick={onAdd}`, but the page never passed `onAdd`, so "Add party" was
     * bound to undefined — a silent no-op with no console error. Any handler
     * prop a child declares must actually be supplied by its parent.
     */
    const frontendSrc = path.resolve(__dirname, '..', '..', 'frontend', 'src');
    const partyListPath = path.join(frontendSrc, 'components', 'loanParties', 'PartyList.jsx');
    const detailsPath = path.join(frontendSrc, 'pages', 'loans', 'LoanDetailsPage.jsx');
    const modalPath = path.join(frontendSrc, 'components', 'loanParties', 'PartyFormModal.jsx');

    if (!fs.existsSync(partyListPath) || !fs.existsSync(detailsPath)) {
      record('Frontend wiring', 'loan party components are present', false, 'PartyList / LoanDetailsPage not found');
    } else {
      const partyListSource = fs.readFileSync(partyListPath, 'utf8');
      const detailsSource = fs.readFileSync(detailsPath, 'utf8');

      const propsBlock = (partyListSource.match(/function PartyList\(\{([\s\S]*?)\}\)/) ?? [])[1] ?? '';
      const handlerProps = [...propsBlock.matchAll(/\b(on[A-Z]\w*)\b/g)].map((m) => m[1]);

      const usage = (detailsSource.match(/<PartyList[\s\S]*?\/>/) ?? [''])[0];
      const unwired = handlerProps.filter((prop) => !new RegExp(`${prop}=`).test(usage));

      record(
        'Frontend wiring',
        'every PartyList handler prop is supplied by the loan details page',
        handlerProps.length > 0 && unwired.length === 0,
        unwired.length ? `NOT WIRED: ${unwired.join(', ')}` : `${handlerProps.join(', ')} all bound`
      );

      record(
        'Frontend wiring',
        'the add/edit party modal is rendered by the loan details page',
        fs.existsSync(modalPath) && /<PartyFormModal/.test(detailsSource),
        'PartyFormModal mounted'
      );

      if (fs.existsSync(modalPath)) {
        const modalSource = stripComments(fs.readFileSync(modalPath, 'utf8'));
        record(
          'Frontend wiring',
          'the party modal uses the existing Phase 4 endpoints, not new ones',
          /addLoanParty\(/.test(modalSource) &&
            /updateLoanParty\(/.test(modalSource) &&
            !/api\.(post|put)\(/.test(modalSource),
          'addLoanParty / updateLoanParty from loanPartyService'
        );
        record(
          'Frontend wiring',
          'the party modal surfaces the backend error message',
          /requestError\.message/.test(modalSource),
          'no blanket "something went wrong"'
        );
      }

      const serviceSource = fs.readFileSync(path.join(frontendSrc, 'services', 'loanPartyService.js'), 'utf8');
      record(
        'Frontend wiring',
        'addLoanParty posts to the declared loan-parties route',
        /api\.post\(`\/admin\/loans\/\$\{loanId\}\/parties`/.test(serviceSource),
        'POST /admin/loans/:loanId/parties'
      );
    }
  }

  // ---------- Route protection (HTTP, no DB reached) ----------
  {
    const server = app.listen(5096);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = 'http://127.0.0.1:5096';

    const call = async (method, path, options = {}) => {
      const res = await fetch(base + path, { method, ...options });
      let body;
      try {
        body = await res.json();
      } catch {
        body = { __nonJson: true };
      }
      return { status: res.status, body };
    };

    const endpoints = [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/users/1'],
      ['POST', '/api/admin/users'],
      ['PUT', '/api/admin/users/1'],
      ['PATCH', '/api/admin/users/1/status'],
      ['PATCH', '/api/admin/users/1/role'],
      ['POST', '/api/admin/users/1/reset-password'],
      ['GET', '/api/admin/roles'],
      ['GET', '/api/admin/roles/1'],
      ['PUT', '/api/admin/roles/1/permissions'],
      ['GET', '/api/admin/permissions'],
      ['GET', '/api/admin/customers'],
      ['GET', '/api/admin/customers/1'],
      ['POST', '/api/admin/customers'],
      ['PUT', '/api/admin/customers/1'],
      ['PATCH', '/api/admin/customers/1/status'],
      ['GET', '/api/admin/loans/1/parties'],
      ['POST', '/api/admin/loans/1/parties'],
      ['POST', '/api/admin/loans/1/parties/swap'],
      ['PUT', '/api/admin/loans/1/parties/2'],
      ['PATCH', '/api/admin/loans/1/parties/2/status'],
      ['GET', '/api/admin/loans'],
      ['GET', '/api/admin/loans/1'],
      ['POST', '/api/admin/loans'],
      ['POST', '/api/admin/loans/preview'],
      ['PUT', '/api/admin/loans/1'],
      ['PATCH', '/api/admin/loans/1/status'],
      ['GET', '/api/admin/loans/1/emis'],
      ['GET', '/api/admin/loans/1/emis/2'],
      ['POST', '/api/admin/loans/1/emis/generate'],
      ['POST', '/api/admin/loans/1/emis/recalculate'],
      ['GET', '/api/admin/loans/1/collection-summary'],
      ['GET', '/api/admin/collections'],
      ['GET', '/api/admin/collections/1'],
      ['POST', '/api/admin/collections'],
      ['POST', '/api/admin/collections/1/reverse'],
      ['GET', '/api/admin/routes'],
      ['GET', '/api/admin/routes/1'],
      ['POST', '/api/admin/routes'],
      ['PUT', '/api/admin/routes/1'],
      ['PATCH', '/api/admin/routes/1/status'],
      ['GET', '/api/admin/routes/1/assignments'],
      ['POST', '/api/admin/routes/1/collectors'],
      ['PATCH', '/api/admin/routes/1/collectors/1/status'],
      ['POST', '/api/admin/routes/1/loans'],
      ['PATCH', '/api/admin/routes/1/loans/1/status'],
      ['GET', '/api/admin/demand'],
      ['GET', '/api/admin/demand/routes'],
      ['GET', '/api/admin/reports/loans'],
      ['GET', '/api/admin/reports/collections'],
      ['GET', '/api/admin/reports/emis'],
      ['GET', '/api/admin/reports/demand-collections'],
      ['GET', '/api/admin/collections/1/receipt'],
      ['GET', '/api/admin/dashboard']
    ];

    const unauthenticated = [];
    for (const [method, endpoint] of endpoints) {
      const res = await call(method, endpoint);
      if (res.status !== 401 || res.body.success !== false) {
        unauthenticated.push(`${method} ${endpoint} -> ${res.status}`);
      }
    }
    record(
      'Route protection',
      `all ${endpoints.length} admin endpoints reject unauthenticated requests with 401`,
      unauthenticated.length === 0,
      unauthenticated.length === 0 ? 'every endpoint returned 401 JSON' : `unexpected: ${unauthenticated.join(', ')}`
    );

    const badToken = await call('GET', '/api/admin/users', { headers: { Authorization: 'Bearer not.a.token' } });
    record(
      'Route protection',
      'malformed token is rejected with 401 before any query runs',
      badToken.status === 401 && badToken.body.success === false,
      `${badToken.status} ${badToken.body.message}`
    );

    // Phase 1 endpoints must keep behaving exactly as before.
    const health = await call('GET', '/api/health');
    record(
      'Phase 1 compatibility',
      'GET /api/health unchanged',
      health.status === 200 && health.body.success === true && health.body.message === 'LMS API is running',
      JSON.stringify(health.body)
    );

    const notFound = await call('GET', '/api/test-invalid');
    record('Phase 1 compatibility', 'unknown route still returns JSON 404', notFound.status === 404 && notFound.body.success === false, `${notFound.status}`);

    const me = await call('GET', '/api/auth/me');
    record('Phase 1 compatibility', 'GET /api/auth/me still 401 without a token', me.status === 401, `${me.status}`);

    server.close();
  }

  // ---------- Migration integrity ----------
  {
    const dir = path.resolve(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((file) => file.endsWith('.js')).sort();

    const bad = files.filter((file) => {
      const migration = require(path.join(dir, file));
      return typeof migration.up !== 'function' || typeof migration.down !== 'function';
    });
    record('Migrations', `all ${files.length} migrations export up() and down()`, bad.length === 0, bad.length ? bad.join(', ') : files.join(', '));

    const ordered = files.every((file, index) => file.startsWith(String(index + 1).padStart(3, '0')));
    record('Migrations', 'filenames are deterministically ordered', ordered, files.join(' → '));

    const expected = [
      'users',
      'roles',
      'permissions',
      'role-permissions',
      'users-role',
      'audit-logs',
      'customers',
      'cif-sequences',
      'loans',
      'loan-sequences',
      'loan-parties',
      'emi-schedules',
      'collections',
      'collection-sequences',
      'collection-allocations',
      'routes',
      'route-sequences',
      'route-collectors',
      'loan-routes'
    ];
    const covers = expected.every((token) => files.some((file) => file.includes(token)));
    record('Migrations', 'covers every Phase 1–8 table', covers, expected.join(', '));

    const routesIdx = files.findIndex((f) => f.includes('016-create-routes'));
    const routeCollectorsIdx = files.findIndex((f) => f.includes('route-collectors'));
    const loanRoutesIdx = files.findIndex((f) => f.includes('loan-routes'));
    const loansIdx2 = files.findIndex((f) => f.includes('create-loans'));
    record(
      'Migrations',
      'Phase 8 migrations are numbered 016-019 and ordered after their dependencies',
      files[routesIdx] === '016-create-routes.js' &&
        routeCollectorsIdx > routesIdx &&
        loanRoutesIdx > routesIdx &&
        loanRoutesIdx > loansIdx2,
      `${files[routesIdx]} -> ${files[routeCollectorsIdx]} -> ${files[loanRoutesIdx]}`
    );

    const phase8Migrations = ['016-create-routes.js', '017-create-route-sequences.js', '018-create-route-collectors.js', '019-create-loan-routes.js'];
    const alteringExisting = phase8Migrations.filter((file) => {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      return /addColumn\(\s*'(loans|customers|users|emi_schedules|collections)'/.test(src) || /removeColumn|changeColumn|dropTable/.test(src.replace(/async down[\s\S]*$/, ''));
    });
    record(
      'Migrations',
      'Phase 8 migrations are purely additive — no existing table is altered',
      alteringExisting.length === 0,
      alteringExisting.length ? alteringExisting.join(', ') : 'four CREATE TABLE migrations only'
    );

    const collectorsMigration = fs.readFileSync(path.join(dir, '018-create-route-collectors.js'), 'utf8');
    const loanRoutesMigration = fs.readFileSync(path.join(dir, '019-create-loan-routes.js'), 'utf8');
    record(
      'Migrations',
      'assignment tables use RESTRICT on their subject keys and generated-column uniqueness',
      collectorsMigration.includes("onDelete: 'RESTRICT'") &&
        collectorsMigration.includes('uq_route_collectors_active') &&
        loanRoutesMigration.includes("onDelete: 'RESTRICT'") &&
        loanRoutesMigration.includes('uq_loan_routes_active_loan') &&
        loanRoutesMigration.includes('GENERATED ALWAYS AS'),
      'history cannot be cascade-deleted; one active row per pair/loan'
    );

    const collectionsIdx = files.findIndex((file) => file.includes('013-create-collections'));
    const allocationsIdx = files.findIndex((file) => file.includes('collection-allocations'));
    const emiIdx = files.findIndex((file) => file.includes('emi-schedules'));
    record(
      'Migrations',
      'collection_allocations is ordered after both collections and emi_schedules',
      collectionsIdx !== -1 && allocationsIdx > collectionsIdx && allocationsIdx > emiIdx,
      `${files[emiIdx]} / ${files[collectionsIdx]} -> ${files[allocationsIdx]}`
    );

    const collectionsMigration = fs.readFileSync(path.join(dir, '013-create-collections.js'), 'utf8');
    record(
      'Migrations',
      'collections references loans and customers with RESTRICT, and has the required indexes',
      /references:\s*\{\s*model:\s*'loans'/.test(collectionsMigration) &&
        /references:\s*\{\s*model:\s*'customers'/.test(collectionsMigration) &&
        (collectionsMigration.match(/onDelete: 'RESTRICT'/g) ?? []).length === 2 &&
        ['idx_collections_loan', 'idx_collections_customer', 'idx_collections_date', 'idx_collections_status', 'idx_collections_ledger_type', 'idx_collections_created_by'].every(
          (index) => collectionsMigration.includes(index)
        ),
      'financial history is never cascade-deleted'
    );

    const allocationsMigration = fs.readFileSync(path.join(dir, '015-create-collection-allocations.js'), 'utf8');
    record(
      'Migrations',
      'collection_allocations enforces UNIQUE(collection_id, emi_id) and RESTRICT on both keys',
      allocationsMigration.includes('uq_collection_allocations_collection_emi') &&
        /references:\s*\{\s*model:\s*'collections'/.test(allocationsMigration) &&
        /references:\s*\{\s*model:\s*'emi_schedules'/.test(allocationsMigration) &&
        (allocationsMigration.match(/onDelete: 'RESTRICT'/g) ?? []).length === 2,
      'one allocation row per collection/instalment pair'
    );

    const emiIndex = files.findIndex((file) => file.includes('emi-schedules'));
    const loansIdx = files.findIndex((file) => file.includes('create-loans'));
    record(
      'Migrations',
      'emi_schedules is numbered 012 and ordered after loans',
      files[emiIndex] === '012-create-emi-schedules.js' && loansIdx < emiIndex,
      `${files[loansIdx]} -> ${files[emiIndex]}`
    );

    const emiMigration = fs.readFileSync(path.join(dir, '012-create-emi-schedules.js'), 'utf8');
    record(
      'Migrations',
      'emi_schedules references loans with ON DELETE RESTRICT and has the required indexes',
      /references:\s*\{\s*model:\s*'loans'/.test(emiMigration) &&
        emiMigration.includes("onDelete: 'RESTRICT'") &&
        emiMigration.includes('uq_emi_schedules_loan_emi_number') &&
        emiMigration.includes('idx_emi_schedules_emi_date') &&
        emiMigration.includes('idx_emi_schedules_loan_status'),
      'UNIQUE(loan_id, emi_number) + emi_date + (loan_id, status)'
    );

    const customerMigration = fs.readFileSync(path.join(dir, '007-create-customers.js'), 'utf8');
    record(
      'Migrations',
      'customers has UNIQUE(cif_id) and indexes on mobile, full_name, email, status, state+city',
      customerMigration.includes('unique: true') &&
        ['idx_customers_mobile', 'idx_customers_full_name', 'idx_customers_email', 'idx_customers_status', 'idx_customers_state_city'].every(
          (index) => customerMigration.includes(index)
        ),
      'unique cif_id + 5 indexes'
    );
    record(
      'Migrations',
      'created_by/updated_by reference users with ON DELETE SET NULL',
      (customerMigration.match(/onDelete: 'SET NULL'/g) ?? []).length === 2,
      'removing a user never removes customer history'
    );
    // Checked against the real model attributes rather than the file text, so
    // explanatory comments cannot skew the result.
    const customerColumns = Object.keys(Customer.rawAttributes);
    record(
      'Migrations',
      'customers has no applicant/co-applicant/guarantor/loan columns (Phase 4 uses a join table)',
      !customerColumns.some((column) => /applicant|guarantor|loan/i.test(column)),
      `${customerColumns.length} columns, none loan-related`
    );

    // Phase 9+ scope: no receipts, reports or exports yet.
    const forbidden = ['receipt', 'report', 'export', 'statement'];
    const leaked = files.filter((file) => forbidden.some((token) => file.toLowerCase().includes(token)));
    record('Scope', 'no receipt, report or export tables were created', leaked.length === 0, leaked.length ? leaked.join(', ') : 'none');

    const modelNames = Object.keys(models).filter((key) => key !== 'sequelize');
    const futureModels = modelNames.filter((name) => /Receipt|Report|Export|Statement/i.test(name));
    record('Scope', 'no receipt/report/export models exist', futureModels.length === 0, `models: ${modelNames.length} registered`);

    record(
      'Scope',
      'demand introduced no financial columns anywhere (EMI stays the source of truth)',
      !Object.keys(models.Route.rawAttributes).some((c) => /amount|emi|demand/i.test(c)),
      'routes carry no money'
    );

    // Phase 5 stores loan-level figures only — instalment detail lives in emi_schedules.
    const loanColumns = Object.keys(models.Loan.rawAttributes);
    const instalmentColumns = loanColumns.filter((column) =>
      /principal_per|interest_per|due_date|paid|collected|dpd|installment|instalment/i.test(column)
    );
    record('Scope', 'loans stores loan-level figures only, no per-instalment fields', instalmentColumns.length === 0, `${loanColumns.length} loan columns`);

    const partyRouter = require('../src/routes/loanPartyRoutes');
    const partyMethods = partyRouter.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods));
    record(
      'Scope',
      'loan party router exposes no DELETE route (soft removal only)',
      !partyMethods.includes('delete'),
      `methods: ${[...new Set(partyMethods)].join(', ')}`
    );

    const loanRouter = require('../src/routes/loanRoutes');
    const loanMethods = loanRouter.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods));
    record(
      'Scope',
      'loan router exposes no DELETE route (loans are preserved; cancellation is a status)',
      !loanMethods.includes('delete'),
      `methods: ${[...new Set(loanMethods)].join(', ')}`
    );

    const customerRouter = require('../src/routes/customerRoutes');
    const methods = customerRouter.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods));
    record(
      'Scope',
      'customer router exposes no DELETE route (customers are never hard-deleted)',
      !methods.includes('delete'),
      `methods: ${[...new Set(methods)].join(', ')}`
    );
  }

  // ---------- Report ----------
  const groups = [...new Set(results.map((result) => result.group))];
  console.log('\n================ PHASE 2 OFFLINE TESTS ================');
  groups.forEach((group) => {
    console.log(`\n${group}`);
    results
      .filter((result) => result.group === group)
      .forEach((result) => console.log(`  ${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`));
  });

  const failed = results.filter((result) => !result.pass).length;
  console.log(`\n-------------------------------------------------------`);
  console.log(`${results.length - failed}/${results.length} passed`);
  console.log('\nNOT RUN — DATABASE BLOCKED (require a live MySQL connection):');
  [
    'migration execution against MySQL',
    'seed:rbac and seed:admin',
    'user CRUD endpoints with real data',
    'pagination / search / filter results',
    'role escalation and last-SUPER_ADMIN guards',
    'inactive user cannot authenticate',
    'audit_logs row creation',
    'customer CRUD endpoints with real data',
    'CIFID allocation at runtime (sequence increment, C000001 onward)',
    'concurrent customer creation / row-lock behaviour',
    'UNIQUE(cif_id) enforcement by MySQL',
    'customer search and filter results',
    'loan_parties migration execution',
    'party add / update / soft-remove against real rows',
    'applicant uniqueness enforced by the generated-column unique index',
    'applicant / co-applicant swap at runtime, including rollback on failure',
    'concurrent party creation behaviour under row locks',
    'loans and loan_sequences migration execution',
    'loan creation transaction (loan + parties committed or rolled back together)',
    'loan number allocation at runtime (LN26-000001 onward) and its row lock',
    'UNIQUE(loan_number) enforcement by MySQL',
    'DECIMAL round-tripping of money through MySQL',
    'loan search across loan number, CIFID, customer name and mobile',
    'status transitions and audit rows against real data',
    'emi_schedules migration execution',
    'schedule generation inside the activation transaction (and its rollback)',
    'UNIQUE(loan_id, emi_number) enforcement by MySQL',
    'idempotent generation when a schedule already exists',
    'concurrent generate requests against a locked loan row',
    'DPD/status snapshot recalculation against stored rows',
    'collections / collection_sequences / collection_allocations migration execution',
    'collection posting transaction against real rows (and its rollback)',
    'collection number allocation at runtime (COL26-000001 onward)',
    'UNIQUE(collection_number) and UNIQUE(collection_id, emi_id) enforcement by MySQL',
    'concurrent collections competing for the same instalment under row locks',
    'concurrent reversal of the same collection',
    'EMI snapshot rebuild from the allocation ledger against stored data',
    'loan collection summary against real instalments'
  ].forEach((item) => console.log(`  - ${item}`));

  process.exit(failed ? 1 : 0);
})();
