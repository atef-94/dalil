# ACTIVE Operating System

A connected backend for real estate businesses — CRM, Sales, Inventory, Payment
Plans, Finance/Collections, Brokers, Organization, Auth, and a default-deny
RBAC layer — unifying what is usually a fragmented stack of point solutions.

## Why this exists / provenance

A previous session in this repository built and adversarially audited a
version of this backend (documented in a final report: 93/93 tests, 8 live
security/concurrency bugs found and fixed, live-verified production build).
That work was never committed to git and was lost when its container was
recycled. This codebase is a from-scratch rebuild against that report, which
was detailed enough to serve as a full specification (exact endpoints,
business rules, and test coverage). It is a faithful reconstruction, not a
byte-for-byte copy — some implementation choices necessarily differ.

## Architecture

- **Backend:** Node.js (v22) + TypeScript on Node built-ins (`node:http`,
  `node:crypto`, `node:test`, `node:fs`, `node:path`).
- **Routing:** a hand-written router (`src/infra/http-server.ts`) — path
  params, query params, JSON body parsing (1MB cap), static file serving,
  security headers, CORS, rate limiting, structured logging.
- **Persistence:** `InMemoryRepository<T>` (`src/infra/repository.ts`), shaped
  to match a future Prisma-backed `Repository<T>` so swapping it in is a
  repository-layer change, not a service-layer rewrite. **Data does not
  survive a process restart** — see Gaps below.
- **Auth:** scrypt password hashing + HMAC-SHA256-signed tokens
  (JWT-shaped), 15-minute TTL, lockout after 5 failed logins / 15 minutes.
- **RBAC:** a four-dimension model — Action × Resource × Scope ×
  Sensitivity — default-deny, evaluated by `RbacEvaluator`
  (`src/modules/permissions/rbac.evaluator.ts`). `getListAccessScope()`
  resolves scope for list endpoints separately from single-record checks.
- **Frontend:** one static test console (`public/index.html`) — role
  selector, live Permission Manifest viewer, Payment Plan template/schedule
  preview, EN/AR RTL toggle. Not a product UI.

See `src/app.ts` for the full route table and `src/infra/seed.ts` for the
four demo accounts (CEO / Sales Manager / Sales Agent / Finance) used by the
`x-demo-user` development header (never honored when `NODE_ENV=production`).

## Modules

| Module | Status |
|---|---|
| Auth | Implemented |
| RBAC (core evaluator) | Implemented |
| Organization (Company/Employee) | Partially implemented — no Branch/Department/Team CRUD |
| Multi-tenancy | Implemented (application layer only, no DB) |
| CRM (Leads) | Implemented — no Activities/Notes/Follow-ups |
| Sales (Opportunities/Contracts) | Implemented, concurrency-proven |
| Inventory (Units) | Implemented, concurrency-proven — no Project/Building/Floor entities |
| Payment Plans | Implemented, most thoroughly tested |
| Finance/Collections | Implemented |
| Brokers (quarantine gate) | Implemented |
| Marketing, Communication, Customer Portal, Analytics, AI, HR, Legal, Operations, Purchasing | Not implemented |
| PostgreSQL/Prisma | Not connected — schema written, unexecuted |
| Frontend SPA | Not implemented — test console only |

## Known gaps (stated honestly, not silently dropped)

- **No real database.** All data is lost on process restart. This alone
  disqualifies real production use until `prisma/schema.prisma` is applied
  and `InMemoryRepository` is replaced.
- **No role-management API.** The only working roles are the four
  hardcoded demo accounts in `src/infra/seed.ts`. A user created through
  `POST /api/auth/register` has zero `UserRole` entries and, under
  default-deny, zero permissions — real login is not yet connected to real,
  assignable RBAC.
- **`POST /api/organization/companies` is intentionally public** (tenant
  signup — there is no user or role to gate it behind before the first
  company exists). Documented here as a deliberate design choice, not an
  oversight.
- Contract lifecycle only ever reaches `signed` — `pending_approval`,
  `cancelled`, `terminated` exist as states but no endpoint sets them.
  `PaymentScheduleLine.status` similarly never passes through `due`
  (only `upcoming` → `overdue` → `paid`, via the sweep).
  No `Project`, `Client`, `Branch`, `Department`, `Team` entities exist —
  `projectId`/`departmentId`/`branchId` are plain string fields.
- No `DELETE`/archive endpoints anywhere; no pagination on any list
  endpoint; no restricted-tier audit-log field masking.
- No external integrations (WhatsApp, ad platforms, payment gateways, MLS).

## Development

```bash
npm install
npm run typecheck && npm run test
npm run dev
```

## Production build

```bash
npm run build
NODE_ENV=production TOKEN_SECRET=$(openssl rand -hex 32) DATABASE_URL=postgres://placeholder npm run start:prod
```

## Docker

```bash
cp .env.example .env
docker compose up -d db
npx prisma migrate deploy   # once prisma is generated against schema.prisma
docker compose up -d app
```

## Status

**Development ready.** Not deployment ready (no persistent database, no
role-management API, unfixed reliance on demo accounts for RBAC). Not
production ready.
