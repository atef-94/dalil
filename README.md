# ACTIVE Operating System

A connected real estate operating layer — CRM, Sales, Inventory, Payment
Plans, Finance/Collections, Brokers, Organization, Auth, default-deny RBAC,
and a real product frontend — unifying what is usually a fragmented stack of
point solutions. It is a real, working web application: sign up, log in, and
use it.

## Why this exists / provenance

A previous session in this repository built and adversarially audited a
version of this backend (documented in a final report: 93/93 tests, 8 live
security/concurrency bugs found and fixed). That work was never committed to
git and was lost when its container was recycled. This codebase is a
from-scratch rebuild against that report, then audited again and extended
into a genuinely production-usable application: real persistent storage,
self-service tenant signup connected to real RBAC (not just four hardcoded
demo accounts), a full frontend, and end-to-end browser verification.

## Architecture

- **Backend:** Node.js (v22) + TypeScript on Node built-ins (`node:http`,
  `node:crypto`, `node:sqlite`, `node:test`, `node:fs`, `node:path`) — no
  Express/NestJS/Prisma runtime dependency.
- **Routing:** a hand-written router (`src/infra/http-server.ts`) — GET/POST/
  PATCH/DELETE/HEAD/OPTIONS, path params, query params, JSON body parsing
  (1MB cap), static file serving, security headers, CORS, rate limiting,
  structured logging.
- **Persistence:** real, on-disk storage via `SqliteRepository<T>`
  (`src/infra/sqlite-repository.ts`, using Node's built-in `node:sqlite`) —
  data survives process restarts (verified live: create data, kill the
  process, restart, data is still there). Shaped to match a future
  Prisma/Postgres-backed `Repository<T>` (see `prisma/schema.prisma`) so that
  migration remains a repository-layer swap, not a service-layer rewrite.
  Tests use `InMemoryRepository<T>` for fast, isolated runs.
- **Auth:** scrypt password hashing + HMAC-SHA256-signed tokens
  (JWT-shaped), 15-minute TTL, lockout after 5 failed logins / 15 minutes.
- **Onboarding:** `POST /api/auth/signup` — a real self-service "create your
  organization" flow (company + founding employee + user + an unrestricted
  company-scoped Owner role, in one step). This is what makes the system
  usable by real users, not just the four hardcoded demo accounts.
- **RBAC:** a four-dimension model — Action × Resource × Scope ×
  Sensitivity — default-deny, evaluated by `RbacEvaluator`
  (`src/modules/permissions/rbac.evaluator.ts`), plus a real role-management
  API (`src/modules/permissions/role-management.service.ts`) so a company's
  own Owner can create custom roles, grant/revoke specific permissions, and
  assign/revoke roles for real teammates.
- **Frontend:** a real product SPA (`public/`) — framework-free ES modules,
  no build step. Login/signup, dashboard, employees, roles & permissions,
  leads, sales opportunities (create → reserve unit → sign contract),
  inventory, payment plan templates with live schedule preview, finance
  (balances, payments, overdue sweep), brokers, audit log. RTL/EN toggle.
  Verified end-to-end in a real browser — see Testing below.

See `src/app.ts` for the full route table and `src/infra/seed.ts` for the
four demo accounts (CEO / Sales Manager / Sales Agent / Finance) used by the
`x-demo-user` development header (never honored when `NODE_ENV=production`).
Real users should use the signup/login screen instead.

## Modules

| Module | Status |
|---|---|
| Auth + self-service signup | Implemented |
| RBAC (evaluator + role-management API) | Implemented |
| Organization (Company/Employee) | Partially implemented — no Branch/Department/Team CRUD |
| Multi-tenancy | Implemented (application layer; verified isolated for both demo and real signed-up tenants) |
| CRM (Leads) | Implemented — no Activities/Notes/Follow-ups |
| Sales (Opportunities/Contracts, incl. cancel) | Implemented, concurrency-proven |
| Inventory (Units) | Implemented, concurrency-proven — no Project/Building/Floor entities |
| Payment Plans | Implemented, most thoroughly tested |
| Finance/Collections | Implemented |
| Brokers (quarantine gate + commissions) | Implemented |
| Frontend SPA | Implemented — verified end-to-end in a real browser |
| Persistent storage | Implemented (SQLite) — Postgres/Prisma remains a future migration |
| Marketing, Communication, Customer Portal, Analytics, AI, HR, Legal, Operations, Purchasing | Not implemented |

## Known gaps (stated honestly, not silently dropped)

- **PostgreSQL/Prisma is not connected.** SQLite is real, on-disk,
  durable storage today — this is not the "data lost on restart" gap
  anymore — but `prisma/schema.prisma`'s row-level locking (`SELECT ... FOR
  UPDATE`) is not exercised; the in-memory `KeyedMutex` concurrency
  protection is correct for a single-process deployment only.
- **`POST /api/organization/companies` and `POST /api/auth/register` remain
  intentionally public/low-level** — real users should sign up through
  `POST /api/auth/signup` instead, which is what the frontend uses.
- Contract lifecycle reaches `signed` and `cancelled`; `pending_approval` and
  `terminated` exist as states but no endpoint sets them.
  `PaymentScheduleLine.status` never passes through `due` (only
  `upcoming` → `overdue` → `paid`, via the sweep).
  No `Project`, `Client`, `Branch`, `Department`, `Team` entities exist —
  `projectId`/`departmentId`/`branchId` are plain string fields.
- No restricted-tier audit-log field masking; audit logging covers the
  significant mutating actions (leads, contracts, payments, role
  assignment, employee creation, broker-lead approval) but not every single
  endpoint.
- No external integrations (WhatsApp, ad platforms, payment gateways, MLS).

## Development

```bash
npm install
npm run typecheck && npm run test
npm run dev
```

Open `http://localhost:3000` — sign up a new organization, or use one of
the seeded demo accounts via the `x-demo-user` header (see
`src/infra/seed.ts`; the frontend signup/login flow does not use this
header, it's for API debugging only).

## Production build

```bash
npm run build
NODE_ENV=production TOKEN_SECRET=$(openssl rand -hex 32) npm run start:prod
```

Data persists to `./data/active-os.db` by default (override with
`SQLITE_PATH`). Verified live: `/health` returns 200, `/api/seed-info` 404s,
the `x-demo-user` bypass is rejected, and data survives a process restart.

## Testing

```bash
npm run test              # 112 automated unit/integration tests (node:test)
node scripts/e2e-smoke.mjs   # real-browser E2E smoke test (Playwright)
```

The E2E script drives the compiled app in real Chromium against a running
server (start one first, e.g. `PORT=3094 node dist/main.js`, then set
`BASE_URL=http://localhost:3094` if different from the default): sign up a
brand-new company, log in, create and qualify a lead, add inventory, create
a payment plan template and preview its schedule, create a sales
opportunity, reserve a unit, sign a contract, check the finance balance, see
the auto-created Owner role, log out, and log back in with the real
credentials. It is a manual verification script, not part of `npm test`.

## Docker

```bash
cp .env.example .env
docker compose up -d app   # SQLite persists to the app-data volume
# db (Postgres) is provisioned for the future Prisma migration; the app
# does not connect to it yet.
```

## Status

**Deployment ready** for a single-instance deployment: real persistent
storage, real self-service signup connected to real RBAC, a working
frontend verified end-to-end in a real browser, 112 passing automated
tests. **Not yet "enterprise production ready"**: no horizontal scaling
(the in-memory concurrency mutex and rate limiter are per-process), no
Postgres/Prisma migration executed, several modules (Marketing,
Communication, Analytics, AI, HR, Legal, Operations, Purchasing) remain
entirely unbuilt, and audit-log field masking is not implemented.
