# Loan Management System (LMS)

**Phase 1** — project foundation and architecture.
**Phase 2** — user, role and permission management.
**Phase 3** — customer and CIF management.
**Phase 4** — applicant / co-applicant / guarantor relationships.
**Phase 5** — loan management.
**Phase 6** — EMI schedule engine.
**Phase 7** — collection management.

Phase 1 delivered the authentication foundation and application shell: login,
JWT-protected routing, a dashboard placeholder and the layout later phases build
on.

Phase 2 adds role-based access control: a normalised `roles` / `permissions` /
`role_permissions` schema, permission-gated APIs, user administration (create,
edit, activate/deactivate, assign role, reset password), an audit trail, and
migrations replacing `sequelize.sync()`.

Phase 3 adds the central customer register: one reusable customer record per
person, identified by a system-generated immutable CIFID, with search, filtering,
status management and audit logging.

Phase 4 adds the relationship layer that connects customers to a loan as
applicant, co-applicant or guarantor — see
[Loan parties](#loan-parties-applicant--co-applicant--guarantor).

Phase 5 adds the loan entity itself — see [Loans](#loans).

Phase 6 adds the per-instalment EMI schedule — see
[EMI schedule](#emi-schedule).

Phase 7 adds payment transactions and their allocation to instalments — see
[Collections](#collections).

Routes, demand management and reporting are intentionally **not** implemented.

> **Database execution is currently pending.** The local MySQL credentials are
> unresolved, so migrations and seeds have never been run. Everything below is
> implemented and verified by the offline test suite; the runtime steps are
> listed as pending in the verification notes.

---

## Stack

| Layer          | Technology                     |
| -------------- | ------------------------------ |
| Frontend       | React.js (Vite), React Router  |
| UI             | Bootstrap 5, Bootstrap Icons   |
| HTTP client    | Axios                          |
| Backend        | Node.js, Express.js            |
| ORM            | Sequelize                      |
| Database       | MySQL 8                        |
| Authentication | JWT (`jsonwebtoken`)           |
| Password hash  | bcrypt                         |

---

## Project structure

```text
lms/
├── frontend/                  React client (Vite)
│   ├── src/
│   │   ├── assets/            Global theme stylesheet
│   │   ├── components/        Reusable UI (common, layout, dashboard, users)
│   │   ├── context/           AuthContext — session lifecycle
│   │   ├── hooks/             useAuth, usePermissions
│   │   ├── layouts/           MainLayout (header + sidebar + content)
│   │   ├── pages/             Login, Dashboard, Users, Roles, 403, NotFound
│   │   ├── routes/            Route table, guards, sidebar definition
│   │   ├── services/          Axios client + auth/user/role API calls
│   │   ├── utils/             Storage, error normalisation, constants, permissions
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── package.json
│   └── .env.example
│
├── backend/                   Express API
│   ├── migrations/            Ordered schema migrations (001…015)
│   ├── tests/                 offline.test.js — no database required
│   ├── src/
│   │   ├── config/            env, Sequelize, roles, permissions, audit actions
│   │   ├── controllers/       Thin HTTP handlers
│   │   ├── middleware/        auth, roles, permissions, validation, rate limit, errors, 404
│   │   ├── models/            User, Role, Permission, RolePermission, AuditLog
│   │   ├── routes/            /api router tree
│   │   ├── services/          Business logic (auth, user, role, audit)
│   │   ├── utils/             ApiError, response helpers, JWT, migrator, CLI scripts
│   │   ├── validators/        express-validator rule sets
│   │   ├── app.js             Express app wiring
│   │   └── server.js          Startup: connect DB → migrate → listen
│   ├── package.json
│   └── .env.example
│
├── README.md
└── .gitignore
```

---

## Prerequisites

- Node.js 18 or newer (developed on Node 22)
- MySQL 8 running locally
- npm 9+

---

## Installation

### 1. Clone the project

```bash
git clone <repository-url>
cd lms
```

### 2. Install backend dependencies

```bash
cd backend
npm install
```

### 3. Install frontend dependencies

```bash
cd ../frontend
npm install
```

### 4. Configure the backend environment

```bash
cd ../backend
cp .env.example .env      # Windows: copy .env.example .env
```

Edit `backend/.env` and set at least `DB_USER`, `DB_PASSWORD` and a strong
`JWT_SECRET`.

```env
NODE_ENV=development
PORT=5000

DB_HOST=localhost
DB_PORT=3306
DB_NAME=lms
DB_USER=root
DB_PASSWORD=your_mysql_password

JWT_SECRET=a_long_random_string
JWT_EXPIRES_IN=1d

FRONTEND_URL=http://localhost:5174

ADMIN_NAME=Administrator
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=a_strong_dev_password
```

### 5. Configure the frontend environment

```bash
cd ../frontend
cp .env.example .env      # Windows: copy .env.example .env
```

```env
VITE_API_URL=http://localhost:5000/api
VITE_APP_NAME=Loan Management System
```

### 6. Create the MySQL database

```bash
cd ../backend
npm run db:create
```

Equivalent SQL, if you prefer to do it by hand:

```sql
CREATE DATABASE lms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 7. Run the migrations

```bash
npm run db:migrate          # apply all pending migrations
npm run db:migrate:status   # show applied / pending
npm run db:migrate:undo     # revert the most recent migration
```

Migrations are the authoritative schema mechanism as of Phase 2. Outside
production the backend applies pending migrations automatically at startup; in
production it refuses to start while migrations are pending, so a deploy can
never half-migrate a live database.

### 8. Seed roles, permissions and the first administrator

```bash
npm run seed          # runs seed:rbac then seed:admin
```

or individually:

```bash
npm run seed:rbac     # roles, permissions and the role→permission grants
npm run seed:admin    # the first administrator, from .env
```

Both seeds are idempotent — re-running never creates duplicates. `seed:rbac`
re-applies the matrix in `backend/src/config/permissions.js`, which is how new
permissions are rolled out in later phases.

Administrator credentials come from `ADMIN_NAME` / `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `backend/.env`. The password is hashed with bcrypt before it
reaches MySQL and is never written to source. Re-running on an existing email is
a no-op.

### 9. Start the backend

```bash
cd backend
npm run dev          # nodemon, http://localhost:5000
# or
npm start
```

The server connects to MySQL first and exits with a clear message if the
connection fails — it never reports as running when the database is unreachable.

### 10. Start the frontend

```bash
cd frontend
npm run dev          # http://localhost:5174
```

Open <http://localhost:5174> and log in with the seeded administrator.

The dev server is pinned to port 5174 (`strictPort`). The backend only accepts
requests from the origin in `FRONTEND_URL`, so if you change the port, change it
in `frontend/vite.config.js` **and** `backend/.env` together.

---

## NPM scripts

### Backend (`backend/`)

| Command                   | Purpose                                        |
| ------------------------- | ---------------------------------------------- |
| `npm run dev`             | Start with nodemon (auto-reload)               |
| `npm start`               | Start the API                                  |
| `npm run db:create`       | Create the MySQL database if it does not exist |
| `npm run db:migrate`      | Apply pending migrations                       |
| `npm run db:migrate:status` | Show applied / pending migrations            |
| `npm run db:migrate:undo` | Revert the most recent migration               |
| `npm run seed:rbac`       | Seed roles, permissions and grants             |
| `npm run seed:admin`      | Create the first administrator from `.env`     |
| `npm run seed`            | Run both seeds in order                        |
| `npm run test:offline`    | Test suite that needs no database              |

### Frontend (`frontend/`)

| Command           | Purpose                       |
| ----------------- | ----------------------------- |
| `npm run dev`     | Vite dev server on port 5174  |
| `npm run build`   | Production build into `dist/` |
| `npm run preview` | Preview the production build  |

---

## API

Base URL: `http://localhost:5000/api`

| Method | Endpoint       | Auth | Required permission | Description                    |
| ------ | -------------- | ---- | ------------------- | ------------------------------ |
| GET    | `/health`      | No   | —                   | Service status                 |
| POST   | `/auth/login`  | No   | —                   | Authenticate and receive a JWT |
| GET    | `/auth/me`     | JWT  | —                   | Current user, role, permissions |
| POST   | `/auth/logout` | JWT  | —                   | Clear the auth cookie          |

### Administration (Phase 2)

| Method | Endpoint                             | Required permission                  |
| ------ | ------------------------------------ | ------------------------------------ |
| GET    | `/admin/users`                       | `users.view`                         |
| GET    | `/admin/users/:id`                   | `users.view`                         |
| POST   | `/admin/users`                       | `users.create`                       |
| PUT    | `/admin/users/:id`                   | `users.update`                       |
| PATCH  | `/admin/users/:id/status`            | `users.activate` / `users.deactivate` |
| PATCH  | `/admin/users/:id/role`              | `users.assign_role`                  |
| POST   | `/admin/users/:id/reset-password`    | `users.reset_password`               |
| GET    | `/admin/roles`                       | `roles.view`                         |
| GET    | `/admin/roles/:id`                   | `roles.view`                         |
| PUT    | `/admin/roles/:id/permissions`       | `roles.manage`                       |
| GET    | `/admin/permissions`                 | `permissions.view`                   |

`GET /admin/users` supports `page`, `limit`, `search`, `role`, `status`,
`sortBy` and `sortOrder`; filtering and paging happen in SQL, not the browser.

### Customers (Phase 3)

| Method | Endpoint                            | Required permission                          |
| ------ | ----------------------------------- | -------------------------------------------- |
| GET    | `/admin/customers`                  | `customers.view`                             |
| GET    | `/admin/customers/:id`              | `customers.view`                             |
| POST   | `/admin/customers`                  | `customers.create`                           |
| PUT    | `/admin/customers/:id`              | `customers.update`                           |
| PATCH  | `/admin/customers/:id/status`       | `customers.activate` / `customers.deactivate` |

There is deliberately **no DELETE**: customers are deactivated, never removed.

`GET /admin/customers` supports `page`, `limit`, `search`, `status`, `city`,
`state`, `gender`, `sortBy` and `sortOrder`. `search` matches CIFID, full name,
mobile and email; a search that looks like a phone number is also matched against
the canonical ten-digit form, so `+91 98765 43210` finds `9876543210`. All
filtering and paging is done in SQL — the client never receives the full table.

Send the token as `Authorization: Bearer <token>`. The login response also sets
an httpOnly `token` cookie, which the API accepts as a fallback.

### Response format

Every endpoint answers with one of two envelopes.

Success:

```json
{
  "success": true,
  "message": "Operation successful",
  "data": {}
}
```

Error:

```json
{
  "success": false,
  "message": "Something went wrong",
  "errors": []
}
```

Handled status codes: `400`, `401`, `403`, `404`, `409`, `422`, `429`, `500`,
`503`. Unknown routes under any path return a JSON `404`, never an HTML error
page.

---

## Roles and permissions

Roles: `SUPER_ADMIN`, `ADMIN`, `MANAGER`, `COLLECTOR`, `STAFF`
(`backend/src/config/roles.js`). Permissions and the default grant matrix live in
`backend/src/config/permissions.js`.

```text
users → roles → role_permissions → permissions
```

Default grants:

| Role        | Permissions                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| SUPER_ADMIN | all (re-applied on every `seed:rbac` run)                                                                 |
| ADMIN       | `users.view/create/update/activate/deactivate/assign_role/reset_password`, `roles.view`, `permissions.view` |
| MANAGER     | `users.view`, `customers.view`, `loan_parties.view/create/update`, all `loans.*`, `emis.view/generate`, all `collections.*` |
| COLLECTOR   | `loan_parties.view`, `loans.view`, `emis.view`, `collections.view/create` (**not** `collections.reverse`)  |
| STAFF       | none                                                                                                      |

ADMIN additionally holds all five customer permissions
(`customers.view/create/update/activate/deactivate`), all five loan-party
permissions (`loan_parties.view/create/update/remove/swap`), all six loan
permissions (`loans.view/create/update/activate/close/cancel`), all three EMI
permissions (`emis.view/generate/update`) and all three collection permissions
(`collections.view/create/reverse`).

Guarding a route:

```js
const { requirePermission } = require('../middleware/permissionMiddleware');
const requireRole = require('../middleware/roleMiddleware');

router.get('/users', authMiddleware, requirePermission('users.view'), handler);
router.delete('/users/:id', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), handler);
```

Adding a permission for a future module takes two steps: add it to
`PERMISSIONS` / `PERMISSION_DEFINITIONS`, grant it in `ROLE_PERMISSION_MATRIX`,
then re-run `npm run seed:rbac`. No schema or middleware change is required.

### Safeguards

- Only a `SUPER_ADMIN` can grant the `SUPER_ADMIN` role or modify a `SUPER_ADMIN` account.
- Nobody can change their own role or status.
- The last active `SUPER_ADMIN` cannot be deactivated or demoted.
- Role and password cannot be changed through `PUT /admin/users/:id` — each has its own endpoint and permission.
- User deletion is deliberately not implemented; deactivation is used instead.
- Inactive users cannot authenticate, and existing tokens stop working because
  the user record is re-read on every request.

### Frontend authorisation

`frontend/src/utils/permissions.js` and the `usePermissions()` hook expose
`can()`, `canAny()` and `is()`. Sidebar items (`frontend/src/routes/navigation.js`)
carry a `permission` list, and `RequirePermission` guards routes — showing a 403
page rather than redirecting, so no redirect loop is possible. This is UX only;
the backend re-checks every request.

## Customers and CIFID

A customer is a **reusable person record** — one row per person, regardless of
how many loans they later participate in. There are no
applicant/co-applicant/guarantor columns: a later phase relates customers to
loans through a join table (`loan_parties`), so the same customer can hold a
different role on each loan.

### CIFID format

```text
C000001, C000002, C000003, …    "C" + a zero-padded six-digit number
```

Six digits is the format in use. (The project brief's overview showed five
digits and its generation section mandated six; no earlier phase had established
a format, so six was adopted and documented rather than changed silently.)

### CIFID generation strategy

Generated **only** by the backend — never by React, never accepted from a
request, and never derived from `Date.now()`, a random value or a UUID.

Allocation uses a dedicated counter table (`cif_sequences`), not
`MAX(cif_id) + 1`, which races under concurrent creation:

1. Customer creation opens a transaction.
2. The counter row is read with `SELECT … FOR UPDATE`, taking a row lock.
3. The number is incremented and formatted as `C000001`.
4. The customer row is inserted in the **same** transaction.
5. Commit releases the lock.

A second concurrent creation blocks at step 2 until the first commits, so two
customers can never receive the same CIFID. `UNIQUE(cif_id)` is the final
backstop. Because the increment shares the customer's transaction, a failed
creation rolls the counter back too — so a failure neither consumes a number nor
leaves a gap. Duplicates are impossible under any outcome.

CIFID is **immutable**: it is absent from the service's editable-field whitelist,
and the validators reject `cifId` / `cif_id` in both create and update bodies
with a 422 rather than silently ignoring them.

### Uniqueness and indexes

| Field      | Constraint                                                          |
| ---------- | ------------------------------------------------------------------- |
| `cif_id`   | **UNIQUE** — the authoritative customer identifier                  |
| `mobile`   | Indexed, **not unique** — families legitimately share a number      |
| `email`    | Indexed, **not unique** — shared household addresses are common     |
| `full_name`| Indexed for name search                                             |
| `status`   | Indexed for the default filter                                      |
| `state, city` | Composite — serves "by state" and "by state + city" with one index |

Duplicate detection is deliberately not automated: matching names, mobiles or
emails never merge or block a record. CIFID remains the only authoritative
identity.

### Status behaviour

`ACTIVE` / `INACTIVE`, defaulting to `ACTIVE`. Customers are **never
hard-deleted** — there is no DELETE endpoint and no route registered. Status
changes go through `PATCH /admin/customers/:id/status`, which requires
`customers.activate` or `customers.deactivate` depending on the target status.

### Field ownership

`cif_id`, `full_name`, `created_by`, `updated_by`, `created_at` and `updated_at`
are backend-owned. `full_name` is always constructed from `first_name`,
`middle_name` and `last_name` by a model hook, so a client-supplied value is
overwritten. Mobile numbers are normalised to one canonical ten-digit form by the
same hook — `+91 9876543210`, `09876543210` and `0091 9876543210` all store as
`9876543210`.

## Loans

The loan is the financial agreement. Customers reach it only through
`loan_parties` — there is no `applicant_id`, no `customer_id` and no CIFID on
`loans`.

### Loan number

```text
LN26-000001    "LN" + two-digit year + a zero-padded six-digit sequence
```

The year is the year the loan is created, and the sequence restarts each year.
Format constants live in `backend/src/config/loans.js`
(`LOAN_NUMBER_PREFIX`, `LOAN_NUMBER_PADDING`, `LOAN_NUMBER_YEAR_FORMAT`).

Allocation is backend-only and concurrency-safe. It uses a per-year counter
table (`loan_sequences`), never `MAX(loan_number) + 1`, `Math.random()` or
`Date.now()`:

1. Loan creation opens a transaction.
2. The year's counter row is read with `SELECT … FOR UPDATE`.
3. The number is incremented and formatted.
4. The loan **and all its party rows** are inserted in that same transaction.
5. Commit.

A concurrent creation blocks at step 2. `UNIQUE(loan_number)` is the final
backstop. Because the increment shares the loan's transaction, a rollback
releases the number — gaps are possible only if a later commit fails, and
duplicates cannot occur under any outcome. The loan number is immutable: it is
rejected by the validator on both create and update.

### Loan types and tenure

`DAILY`, `WEEKLY`, `MONTHLY`. **Tenure counts periods of the loan's own type, not
months** — a `DAILY` loan with tenure 12 runs twelve daily periods. `emiCount`
always equals `tenure`; a client cannot submit `tenure: 12` with `emiCount: 25`,
because `emiCount` is never accepted from a request.

### Financial formula

**ROI is a MONTHLY percentage** — `5` means 5% per month, stored as
`DECIMAL(7,4)`. This is the current rule (`roiBasis: MONTHLY`, the default for
every new loan); it replaced an earlier annual interpretation, and loans priced
under that interpretation carry `roiBasis: ANNUAL` and keep meaning "per year"
forever — the basis is stored per loan precisely so a later change of the
default can never re-price an existing agreement (`migrations/021-add-loan-roi-basis.js`).

The entered rate is normalised to its annual equivalent once, then converted to
whichever period the loan actually charges:

```text
annualEquivalent = roi × 12                              (MONTHLY basis, current)
                  = roi                                   (ANNUAL basis, legacy loans)
periodRate        = annualEquivalent / (100 × periodsPerYear(loanType))

periodsPerYear: DAILY 365, WEEKLY 52, BI_WEEKLY 26, MONTHLY 12
```

Two interest methods, chosen per loan (`interestMethod`, stored, never
re-priced by a later default):

```text
FLAT       interest       = loanAmount × (annualEquivalent / 100) × (termMonths / 12)
           totalRepayment = loanAmount + interest
           emiAmount      = totalRepayment / emiCount

REDUCING   EMI            = P × i × (1 + i)ⁿ / ((1 + i)ⁿ − 1)     i = periodRate, n = emiCount
           each instalment charges interest on the balance still outstanding,
           so interest falls and principal rises across the schedule
```

FLAT is the default (`interestMethod: FLAT`). All of it lives in
`services/loanCalculationService.js` — no financial arithmetic exists in any
controller, route or React component. If the business uses a different
interpretation, only that module changes.

### Precision and rounding

Money is `DECIMAL(15,2)` in MySQL and never `FLOAT`. All arithmetic runs in
integer paise through `BigInt` (`utils/money.js`), so no stored value is the
result of floating-point maths — `toPaise('0.1') + toPaise('0.2')` equals
`toPaise('0.3')` exactly, where `0.1 + 0.2 !== 0.3` in JavaScript.

Rounding is **half away from zero, to 2 decimal places**. Because `emiAmount` is
rounded, `emiAmount × emiCount` can differ from `totalRepayment` by a few paise.
That residue is never dropped: the service reports it as `roundingRemainder` and
folds it into `lastEmiAmount`, so the instalments always sum exactly to
`totalRepayment`. Phase 6 applies it to the final instalment.

### Status lifecycle

```text
DRAFT ──► ACTIVE ──► CLOSED
  │          │
  └──────────┴──► CANCELLED

CLOSED and CANCELLED are terminal.
```

New loans always start as `DRAFT`. Transitions are validated by
`services/loanStatusService.js`; a request cannot set an arbitrary status, and
each transition needs its own permission (`loans.activate` / `loans.close` /
`loans.cancel`). Activation additionally requires exactly one active applicant.

### Edit rules

| Status | Terms | Parties |
| --- | --- | --- |
| `DRAFT` | editable (financials are recalculated) | editable |
| `ACTIVE` | **fixed** — amount, ROI, tenure, type and start date all rejected with 409 | locked |
| `CLOSED` / `CANCELLED` | **read-only** — every edit rejected | locked |

`PUT /admin/loans/:id` cannot bypass this, and it cannot change status or
parties either — each has its own endpoint and permission. Correcting an active
loan needs a controlled amendment workflow, which is deliberately deferred rather
than allowed as a silent edit.

### API

| Method | Endpoint | Required permission |
| --- | --- | --- |
| GET | `/admin/loans` | `loans.view` |
| GET | `/admin/loans/:id` | `loans.view` |
| POST | `/admin/loans` | `loans.create` |
| POST | `/admin/loans/preview` | `loans.create` or `loans.update` |
| PUT | `/admin/loans/:id` | `loans.update` |
| PATCH | `/admin/loans/:id/status` | `loans.activate` / `loans.close` / `loans.cancel` |

No DELETE: loans are preserved, and cancellation is a status change.

`GET /admin/loans` supports `page`, `limit`, `search`, `status`, `loanType`,
`startDateFrom`, `startDateTo`, `sortBy` and `sortOrder`. `search` matches the
loan number, and — through `loan_parties` — customer CIFID, name and mobile. All
filtering happens in SQL.

`POST /admin/loans/preview` returns exactly the figures creation would store, so
the form shows a preview without reimplementing the formula in the browser. The
backend remains the only authority: `loanNumber`, `totalRepayment`, `emiAmount`
and `emiCount` are rejected if a client tries to supply them.

### Creating a loan

One transaction covers everything:

```text
BEGIN
  resolve + validate applicant, co-applicants, guarantors   (Phase 4 rules)
  allocate loan number                                      (locked counter)
  insert loan
  insert loan_party rows
COMMIT   ── any failure rolls all of it back
```

Exactly one applicant is required, co-applicants and guarantors are unbounded,
every customer must exist and be `ACTIVE`, and no customer may hold two roles on
the same loan.

## Collections

Money actually received, and how it was applied.

```text
Collection ──hasMany──► CollectionAllocation ──belongsTo──► EmiSchedule
```

### The ledger is the authority

`collection_allocations` rows **are** the record of what has been paid.
`emi_schedules.amount_collected`, `payment_date`, `status` and `dpd` are
snapshots **recomputed from that ledger** on every posting and reversal — never
incremented or decremented in place. That is what makes a reversal exactly
correct rather than approximately correct: removing a collection from the ledger
and rebuilding gives the true state, with no compensating arithmetic.

An allocation counts exactly when its parent collection is `POSTED`. There is
deliberately no status column on the allocation itself, so the two can never
disagree.

EMI status and DPD come from the Phase 6 model methods — that logic is reused,
not restated, so `PARTIAL` still outranks `OVERDUE` and DPD still counts from the
due date.

### Rules

| Rule | Enforcement |
| --- | --- |
| Allocations must total the collection amount **exactly** | Rejected over *and* under — no silently unallocated money |
| No allocation may exceed an instalment's outstanding | `409`; excess never spills into the next instalment |
| One instalment per collection | Duplicate `emiId` rejected; `UNIQUE(collection_id, emi_id)` |
| Amount must be > 0 | Rejects `0`, negatives, `NaN`, `Infinity`, `1e5`, >2 decimals |
| Collection date ≤ today | Advance collections unsupported; server date, injectable for tests |
| Loan must be `ACTIVE` | `DRAFT`/`CLOSED`/`CANCELLED` rejected with `409` |
| Payer must be an active party to the loan | Applicant, co-applicant **or** guarantor may pay |
| `BANK` requires a payment reference | `CASH` does not |
| Posted collections are immutable | No `PUT`, no `PATCH`, no `DELETE`, no `.destroy()` |

Multiple collections may settle one instalment, and one collection may settle
several instalments — both in a single transaction.

### Concurrency

Two collectors posting against the same instalment must not between them
over-collect it. Posting therefore:

1. locks the **loan** row, so its status cannot change mid-posting;
2. locks the affected **instalment** rows — in ascending id order, to limit
   deadlocks — *before* reading their outstanding balances;
3. validates and writes inside that same transaction.

What is validated is therefore still true at commit. Reversal locks the
collection row first, so a second simultaneous reversal sees `REVERSED` and gets
a conflict rather than double-reversing.

### Reversal

Reversal is a status change, never a delete. The collection and its allocation
rows are retained and remain visible; they simply stop counting. The affected
instalments are then rebuilt from the remaining `POSTED` allocations, so status,
DPD and payment date return to whatever the data says they should be — nothing
is restored from a stored "previous" value.

```text
EMI 10,000 fully paid, due 10 days ago  ──reverse──►  OVERDUE, DPD 10, outstanding 10,000
EMI 10,000 paid by 3 collections        ──reverse 1─►  PARTIAL, outstanding rebuilt from the rest
```

`payment_date` is the date of the collection that *completed* the instalment,
found by walking its valid allocations oldest-first — so a partial payment never
stamps a date, and a reversal clears or moves it correctly.

### API

| Method | Endpoint | Required permission |
| --- | --- | --- |
| GET | `/admin/collections` | `collections.view` |
| GET | `/admin/collections/:id` | `collections.view` |
| POST | `/admin/collections` | `collections.create` |
| POST | `/admin/collections/:id/reverse` | `collections.reverse` |
| GET | `/admin/loans/:loanId/collection-summary` | `collections.view` |

Listing supports `search` (collection number, loan number, CIFID, customer name),
`status`, `ledgerType`, `loanId`, `createdBy`, `dateFrom`, `dateTo` and paging —
all in SQL.

**A collector can post money but cannot reverse it.** `collections.reverse` is a
supervisory permission withheld from the COLLECTOR role and enforced by the
backend, not merely hidden in the UI.

### Loan outstanding

Derived, never stored as a separate mutable total:

```text
totalOutstanding = SUM(emi_amount) - SUM(amount_collected)
```

`getLoanCollectionSummary()` returns the repayment total, collected, outstanding,
paid/partial/overdue/remaining instalment counts and max DPD — all computed from
the instalment rows, which are themselves computed from the ledger. There is one
authoritative calculation, so no two totals can drift apart.

## EMI schedule

One row per instalment in `emi_schedules`, generated from the loan's stored
terms. The formula is **not** restated here — the schedule engine calls the
Phase 5 calculation service, which remains the only authority on interest.

### When a schedule is created

```text
POST /admin/loans          -> loan is DRAFT, no schedule
PATCH /admin/loans/:id/status  DRAFT -> ACTIVE
                           -> schedule generated in the SAME transaction
```

A loan can never become `ACTIVE` without its schedule: if generation or
reconciliation fails, the activation rolls back with it. Closing or cancelling
generates nothing, and an existing schedule is never rebuilt or deleted — it is
financial history. Generation is idempotent, guarded by a row lock on the loan
and by `UNIQUE(loan_id, emi_number)`.

`POST /admin/loans/:loanId/emis/generate` exists for **recovery only** (an
active loan that somehow has no schedule). It refuses DRAFT, CLOSED and
CANCELLED loans, and returns 409 rather than rebuilding an existing schedule.

### Due dates

| Loan type | Interval |
| --- | --- |
| `DAILY` | +1 day per instalment |
| `WEEKLY` | +7 days per instalment |
| `MONTHLY` | +1 calendar month per instalment |

Dates are computed with calendar arithmetic (`utils/dates.js`), never
`30 × 24 × 60 × 60 × 1000`. Monthly dates are measured from the loan's start date
each time — **anchored, not chained** — and clamped to the last valid day of the
target month:

```text
2026-01-31  ->  2026-02-28,  2026-03-31,  2026-04-30,  2026-05-31
2028-01-31  ->  2028-02-29                        (leap year)
```

Anchoring matters: chaining from the clamped 28th would leave every later
instalment on the 28th.

### Principal / interest allocation

Interest is split evenly across instalments, the EMI amount matches the loan's
stored `emi_amount` for every instalment but the last, and **principal is
derived as the remainder** (`emi − interest`). Deriving principal rather than
rounding it independently is what makes all three totals reconcile at once:

```text
SUM(principal)  = loan_amount
SUM(interest)   = total interest
SUM(emi_amount) = total_repayment
```

The final instalment absorbs all rounding residue — the same rule Phase 5 uses
for `lastEmiAmount`. `validateScheduleTotals()` re-checks these three equalities
in exact integer paise **before any row is inserted**; a schedule that does not
reconcile is refused, never persisted. All arithmetic reuses `utils/money.js`.

### DPD and status

Both are **derived**, never accepted from a client:

```text
DPD = 0                        on or before the due date
DPD = 0                        nothing outstanding, or waived
DPD = days since the due date  otherwise
```

DPD comes from the due date and the outstanding amount, not from the payment
date. Status precedence:

```text
WAIVED > PAID > PARTIAL > OVERDUE > DUE > PENDING
```

`PARTIAL` deliberately outranks `OVERDUE` — it carries the more specific
information, and lateness is still reported through DPD. A waiver is a decision
and is never overwritten by derivation.

The `dpd` and `status` columns are stored **snapshots** so they can be indexed
and reported on, but the API always serves freshly derived values, so a stale
snapshot can never be what a client sees.
`POST /admin/loans/:loanId/emis/recalculate` (permission `emis.update`) brings
the columns back in line; it changes no amount, date or instalment count.

### API

| Method | Endpoint | Required permission |
| --- | --- | --- |
| GET | `/admin/loans/:loanId/emis` | `emis.view` |
| GET | `/admin/loans/:loanId/emis/:emiId` | `emis.view` |
| POST | `/admin/loans/:loanId/emis/generate` | `emis.generate` |
| POST | `/admin/loans/:loanId/emis/recalculate` | `emis.update` |

There is deliberately no PUT, PATCH or DELETE on an instalment. Listing supports
`status`, `emiNumber`, `dateFrom`, `dateTo`, `page` and `limit`, and returns a
`summary` block (totals, outstanding, overdue count, max DPD) derived from the
rows.

## Loan parties (applicant / co-applicant / guarantor)

> **CUSTOMER ≠ APPLICANT.**
> "Applicant" is not a property of a person. It is a **role a customer holds
> within one loan**. The same customer can be the applicant on one loan, a
> co-applicant on another and a guarantor on a third — all from a single
> customer record and a single CIFID.

Consequently `customers` has **no** `applicant_id`, `co_applicant_id`,
`guarantor_id`, `is_applicant`, `is_co_applicant` or `is_guarantor` columns. The
role lives on the relationship row in `loan_parties`.

```text
Loan (Phase 5)  ──hasMany──►  LoanParty  ◄──hasMany──  Customer
                                  │
                          party_role: APPLICANT | CO_APPLICANT | GUARANTOR
```

`loan_parties` stores **no** customer profile data — no name, mobile, email,
address or CIFID. Those are read through the Customer association, which stays
the single source of truth. (If a legal requirement for point-in-time snapshots
of party details emerges, that belongs in a separate snapshot table in a later
phase — not as duplicated columns here.)

### Rules

| Rule | Enforcement |
| --- | --- |
| Exactly **one** applicant per loan | Service check under a row lock **and** a unique index |
| **Multiple** co-applicants allowed | No constraint |
| **Multiple** guarantors allowed | No constraint |
| One customer holds **one role per loan** | `UNIQUE(loan_id, customer_id)` + service check |
| Customer must exist | `404` — a party is never allowed to create a customer |
| Inactive customer cannot be newly assigned | `409`; existing history stays readable |
| Applicant cannot be removed or demoted directly | `409` — use the swap operation |
| Parties are never hard-deleted | Soft removal via status; no DELETE route exists |

Applicant uniqueness is enforced in the database, not just in the service,
because two concurrent requests can both pass an application-level check. MySQL
has no partial indexes, so a generated column holds `loan_id` only for rows that
are an active applicant and `NULL` otherwise; a `UNIQUE` index ignores `NULL`s,
which permits unlimited co-applicants and guarantors while making a second active
applicant impossible.

### Applicant / co-applicant swap

`swapApplicantAndCoApplicant()` exchanges the two roles in **one transaction**,
never as two requests. Inside it the applicant is demoted *first*, so the loan
passes briefly through **zero** applicants rather than two — two would violate
the unique index and abort. No other session observes the intermediate state, and
any failure rolls back to the original roles. The operation is audited with the
old and new applicant/co-applicant CIFIDs.

### API

| Method | Endpoint | Required permission |
| --- | --- | --- |
| GET | `/admin/loans/:loanId/parties` | `loan_parties.view` |
| POST | `/admin/loans/:loanId/parties` | `loan_parties.create` |
| POST | `/admin/loans/:loanId/parties/swap` | `loan_parties.swap` |
| PUT | `/admin/loans/:loanId/parties/:partyId` | `loan_parties.update` |
| PATCH | `/admin/loans/:loanId/parties/:partyId/status` | `loan_parties.remove` |

There is deliberately **no DELETE**: a loan's participant history must stay
readable, so removal sets `status = REMOVED`. Customers are identified by
`customerId` or `cifId`; the party selector reuses the Phase 3 customer search
(`GET /admin/customers?search=…&limit=10`) rather than adding a second search API.

### Migration history

Phase 4 wrote this table's migration but parked it under `migrations/pending/`,
because `loan_id` had to reference a `loans` table that did not exist yet — the
active sequence must never contain a foreign key to a missing table. Phase 5
created `loans` (009), then moved that same file into the sequence as
`011-create-loan-parties.js` with its foreign key enabled. It was moved, not
copied: exactly one migration creates `loan_parties`, and `migrations/pending/`
no longer exists.

### Frontend components

`components/loanParties/` provides `PartySelector`, `PartyCard`, `PartyList`,
`SwapApplicantModal` and `PartyRoleBadge`, plus `services/loanPartyService.js`.
Phase 5 composes them into the loan form and loan details page.

## Audit log

`audit_logs` records `USER_CREATED`, `USER_UPDATED`, `USER_ACTIVATED`,
`USER_DEACTIVATED`, `ROLE_CHANGED`, `PASSWORD_RESET`,
`ROLE_PERMISSIONS_UPDATED`, `CUSTOMER_CREATED`, `CUSTOMER_UPDATED`,
`CUSTOMER_ACTIVATED`, `CUSTOMER_DEACTIVATED`, `PARTY_ADDED`, `PARTY_UPDATED`,
`PARTY_REMOVED`, `APPLICANT_COAPPLICANT_SWAPPED`, `LOAN_CREATED`,
`LOAN_UPDATED`, `LOAN_ACTIVATED`, `LOAN_CLOSED`, `LOAN_CANCELLED`,
`EMI_SCHEDULE_GENERATED`, `EMI_UPDATED`, `COLLECTION_CREATED` and
`COLLECTION_REVERSED` with the actor, entity, IP and a JSON detail object.
Entities: `USER`, `ROLE`, `CUSTOMER`, `LOAN_PARTY`, `LOAN`, `EMI_SCHEDULE`,
`COLLECTION`.

There is deliberately no `EMI_SCHEDULE_REGENERATED` action: a schedule is never
rebuilt, so that vocabulary would describe something the system cannot do.
Credential-like keys are stripped before anything is written, and audit failures
never break the operation they record.

---

## Security notes

- Passwords are hashed with bcrypt (12 rounds) in a model hook, so no call site
  can persist plain text.
- The password hash is excluded from queries by default (`defaultScope`) and is
  only loaded through the explicit `withPassword` scope.
- Helmet, CORS restricted to `FRONTEND_URL`, request validation and rate limiting
  (tighter on `/auth/login`) are enabled.
- Stack traces are returned only outside production; database and configuration
  details never reach the client.
- `.env` is git-ignored; only `.env.example` is committed.

---

## Testing

```bash
cd backend && npm run test:offline
```

Covers permission middleware, route protection, validators, model serialisation,
audit redaction, the permission catalogue and migration integrity — everything
that does not need a live database. The runner prints an explicit
`NOT RUN — DATABASE BLOCKED` list for the rest.

## Not yet implemented

Customer management, CIF generation, applicant/co-applicant/guarantor, loan
creation and numbering, ROI and EMI calculation, EMI schedules, collections,
payment allocation, DPD, routes, demand and financial reports, Excel/PDF export.
The sidebar shows these as disabled placeholders only.
