# ACTIVE Operating System

A full real-estate **operating system**, not just a CRM: CRM, Sales,
Inventory, Payment Plans, Finance/Collections, Brokers, Organization
(Branches/Departments), HR, Operations (maintenance), Legal (contract
documents), Purchasing (vendors/POs), Marketing (campaigns), Communication
(internal messaging), Analytics, a rule-based AI lead-scoring engine, a
Customer Portal, Auth, default-deny RBAC, and a real product frontend —
unifying what is usually a fragmented stack of point solutions. It is a
real, working web application: sign up, log in, and use it.

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
| Organization (Company/Employee/Branch/Department) | Implemented — no Team CRUD |
| Multi-tenancy | Implemented (application layer; verified isolated for both demo and real signed-up tenants) |
| CRM (Leads) | Implemented — no Activities/Notes/Follow-ups |
| Sales (Opportunities/Contracts, incl. cancel) | Implemented, concurrency-proven |
| Inventory (Units, Projects) | Implemented, concurrency-proven — no Building/Floor entities |
| Payment Plans | Implemented, most thoroughly tested |
| Finance/Collections | Implemented |
| Brokers (quarantine gate + commissions) | Implemented |
| HR (leave requests: request/approve/reject/cancel) | Implemented — no attendance/payroll |
| Operations (maintenance tickets on units) | Implemented |
| Legal (contract document tracking: pending → received → verified/rejected) | Implemented — documents are metadata records, not file uploads |
| Purchasing (vendors + purchase orders: draft → approved → fulfilled) | Implemented |
| Marketing (campaigns + lead-source attribution/conversion) | Implemented |
| Communication (internal message/notification log) | Implemented — internal log; real external delivery (WhatsApp/Email/SMS) goes through the Integration Layer below, not this module directly |
| Analytics (sales funnel, pipeline, collections aging, inventory occupancy, broker performance) | Implemented |
| AI (rule-based lead priority scoring, 0–100 with shown factors) | Implemented — deterministic scoring, not a trained ML/LLM model (none is configured in this environment) |
| Customer Portal (customer_user accounts scoped to their own contracts/schedule) | Implemented |
| Tasks (generic tasks/reminders/follow-ups) | Implemented |
| Automation Engine (event/scheduled/webhook triggers, conditions/branching, retries, approvals, run history, workflow templates, encrypted secrets) | Implemented, production-capable — see below |
| AI Execution Layer (AI Agent takes real actions — create leads/tasks, update lead status, assign owners, send messages, update campaigns, call webhooks — through the same permission/policy/approval/audit pipeline as the Automation Engine) | Implemented |
| Integration Layer (WhatsApp Business, Email/SendGrid, Meta Ads, Google Calendar, Stripe, generic custom REST) | Implemented — real outbound HTTP calls, encrypted per-connection credentials, per-provider rate limiting, retry/backoff, and a delivery event log; reachable from workflows/AI via the `integration_call` action and from the Integrations page. No real third-party credentials are configured in this environment, so live delivery to an actual WhatsApp/SendGrid/etc account is unverified here — the connect/send/log pipeline itself is real, not a stub |
| Frontend SPA | Implemented — staff app shell plus a separate scoped portal shell for customer_user accounts; verified end-to-end in a real browser |
| Persistent storage | Implemented (SQLite) — Postgres/Prisma remains a future migration |

### Automation Engine + AI Execution Layer

`src/modules/automation/automation.service.ts` is ACTIVE's native workflow
engine — a from-scratch build (no automation/workflow/scheduler/queue
infrastructure existed before this phase). It supports:

- **Triggers**: domain events (`lead.created`, `contract.signed`, `payment.overdue_swept`,
  and 13 others — emitted from `app.ts` route handlers via `src/infra/event-bus.ts`
  right after the underlying mutation already succeeded, so an automation
  failure can never break the primary API response), scheduled/recurring
  (per-workflow interval, ticked every minute from `main.ts`), and inbound
  webhooks (`POST /api/automation/webhooks/:companyId/:slug`, public —
  the URL's slug is the credential, the same model Zapier/Make use).
- **Conditions and branching**: each step is independently gated by
  AND-combined conditions against the trigger payload (dot-path field,
  8 operators); a step whose conditions fail is skipped, not blocking —
  branching is multiple steps off the same trigger, each condition-gated
  differently.
- **Actions**: `create_task`, `create_lead`, `send_message`,
  `update_lead_status`, `assign_lead_owner`, `update_campaign_status`,
  `webhook_call` (with encrypted-secret bearer-token injection), and
  `require_approval` (pauses the run and creates an `ApprovalRequest` until
  a human with `approve:approval` decides it).
- **Retry/failure handling**: per-step `maxRetries` with `onFailure:
  'stop'|'continue'`.
- **Idempotency**: every run carries a dedup key (derived from event
  type+payload, a scheduled interval bucket, or a webhook idempotency
  header/payload hash) — a duplicate trigger delivery is guaranteed to
  create at most one run per workflow.
- **RBAC enforcement**: a workflow always executes as its creator; every
  single step re-checks that user's live RBAC grant before running, every
  single run — a workflow can never do more than its creator is currently
  authorized to do, and a permission revoke takes effect on the very next
  run.
- **Audit trail**: every step execution is recorded (`WorkflowStepRun`,
  with attempts/output/error) and written to the existing `AuditLog`.
- **Templates**: `GET /api/automation/templates` returns 4 built-in
  starting points (new-lead welcome task, qualified-lead reassignment
  approval, overdue-payment notice, weekly campaign review reminder).

The **AI Execution Layer** (`src/modules/ai/ai-agent.service.ts`) is not
limited to analysis/recommendations — it takes real actions on a human's
behalf. Every request goes through the same four-stage pipeline, no
exceptions: **permission** (does the requesting human hold the RBAC grant
this action needs?) → **policy** (`AiPolicy.autonomyLevel` — `suggest_only`
/ `require_approval` / `auto_execute`, defaulting to `require_approval`
when a company hasn't set one) → **approval** (if policy requires it, the
action pauses as a real `ApprovalRequest` — the same entity/table the
Automation Engine's workflow approvals use) → **audit** (every request,
whatever the outcome, is persisted as an `AiActionRequest` and written to
`AuditLog` with an `executedByAI: true` marker). It never has its own
execution path: `AutomationService.executeActionDirect()` dispatches
through the exact same `executeAction()` switch a workflow step uses, so
an AI-requested action and a workflow-triggered one are indistinguishable
to the executor and get identical RBAC enforcement. `suggestNextAction()`
builds a concrete, explainable "next best action" for a lead from the
existing rule-based `LeadScoringService` (no external LLM/ML dependency in
this deployment) — surfaced as an "Ask AI" button on the Leads page.

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
  No `Team` entity exists yet (Branch/Department/Project do). `Unit.projectId`
  deliberately stays a free-form string rather than a validated FK, for
  backward compatibility with data/UI predating the `Project` entity.
- No restricted-tier audit-log field masking; audit logging covers the
  significant mutating actions (leads, contracts, payments, role
  assignment, employee creation, broker-lead approval) but not every single
  endpoint, and not yet the newer modules (HR, Operations, Legal,
  Purchasing, Marketing, Communication).
- The Integration Layer (`src/modules/integrations/integration.service.ts`)
  makes real outbound HTTP calls to WhatsApp Business, SendGrid, Meta Ads,
  Google Calendar, and Stripe, plus a generic authenticated REST passthrough
  for other approved services — with encrypted credentials, rate limiting,
  retries, and a delivery log. It has not been exercised against real
  third-party credentials in this environment (none are configured), and
  there is no MLS connector. The internal `Communication` module (message
  log) is separate and still logs-only by design — external delivery goes
  through the Integration Layer's `integration_call` action, not through
  `Communication.sendMessage` directly.
- Legal documents are metadata records (name, type, status, notes) — there
  is no file upload/storage backing them yet.
- The AI module is intentionally a transparent, rule-based scorer, not a
  trained model — no LLM/ML API is configured in this environment. Its
  single `scoreLead` method is designed as a drop-in point for a real
  ML/LLM-backed scorer later.
- The Customer Portal has no self-service signup — a staff member with
  `create:portal_access` grants access per lead from the Leads page.
- **No content/CMS entity exists yet**, so "schedule and publish approved
  content" (one of the AI capabilities requested in scope) isn't directly
  automatable — `webhook_call` is the documented escape hatch (e.g. trigger
  an external CMS/Zapier publish step) until a content entity is built.
- The Automation Engine's action set covers CRM/Sales lead mutations, tasks,
  messaging, campaigns, and generic webhooks — it does not yet expose
  Finance/Payments, Contract, HR, Operations, Legal, or Purchasing state
  transitions as automatable action types (those modules are event
  *sources* — 9 of the 16 domain events come from them — but not yet action
  *targets*). Extending `AutomationActionType` and `executeAction()`'s
  switch is the intended path (see `automation.service.ts`) and follows the
  exact same pattern the CRM/Marketing/Task actions already use.
- The Automation Engine executes step-by-step synchronously within the
  triggering request/tick (no external job queue) — correct and simple for
  this deployment's scale, but a slow `webhook_call` step delays the run
  (and, for event triggers, the API response of the route that fired it)
  until it resolves or times out.

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
npm run test              # 315 automated unit/integration tests (node:test)
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

The Docker image itself (multi-stage build, non-root `node` user, a
`docker-entrypoint.sh` that `chown`s a freshly mounted volume before
dropping root via `gosu`) has been hand-reviewed but **not build-tested in
this environment** — outbound access to Docker Hub's registry CDN is
blocked by this sandbox's network policy. Validate `docker build .` once
yourself before relying on it for anything beyond `docker compose` local
dev.

## Deploy to Railway

`railway.json` at the repo root pins the build to Railway's Nixpacks
builder (not the Dockerfile above — this is the path actually verified
live in this environment: `npm run build` then `npm start`), plus a
`/health` healthcheck and an on-failure restart policy.

1. On [railway.app](https://railway.app), **New Project → Deploy from
   GitHub repo** → pick `atef-94/dalil`, branch
   `claude/active-operating-system-9c00k3` (or `main`, once this PR is
   merged).
2. **Add a Volume** to the service — without this, the SQLite database
   resets on every redeploy. `SQLITE_PATH` defaults to
   `./data/active-os.db` relative to the compiled app (typically
   `/app/data/active-os.db` under Nixpacks' default `/app` working
   directory). Mount the volume there, or set `SQLITE_PATH` explicitly to
   an absolute path inside wherever you mount it if Railway places the app
   somewhere else — check the deploy logs' first line
   (`persistent storage: <path>`) to confirm where it actually landed.
3. **Set environment variables** on the service:
   - `NODE_ENV=production`
   - `TOKEN_SECRET` — a real random secret (e.g. `openssl rand -hex 32`).
     The app **refuses to boot** in production without this (see
     `src/app.ts`) — it will never silently fall back to the insecure dev
     default.
   - `ALLOWED_ORIGINS` — your Railway-assigned domain, once you have it
     (e.g. `https://your-app.up.railway.app`).
   - Everything else in `.env.example` is optional; Railway injects `PORT`
     automatically and the app already reads it.
4. Deploy. Railway gives you the real public URL — open it, and the login
   screen is the same one verified locally in this session (Company ID
   `company-demo`, the four demo accounts, or self-service signup for a
   brand-new tenant).

I could not perform this connection myself in this session — no Railway
CLI session or API token is available here — so steps 1-4 are for you to
run from the Railway dashboard.

## Status

**Deployment ready** for a single-instance deployment: real persistent
storage, real self-service signup connected to real RBAC, a working
frontend (staff app + a separate scoped customer portal) verified
end-to-end in a real browser, 315 passing automated tests, and every
module named in the original scope — CRM, Sales, Inventory, Payment Plans,
Finance, Brokers, Organization (incl. Branches/Departments/Projects), HR,
Operations, Legal, Purchasing, Marketing, Communication, Analytics, AI
lead scoring, Tasks, the native Automation Engine, the AI Execution Layer,
and the Customer Portal — is real and working, not stubbed.
**Not yet "enterprise production ready"**: no horizontal scaling (the
in-memory concurrency mutex and rate limiter are per-process), no
Postgres/Prisma migration executed, no MLS connector, no real third-party
credentials configured for the built Integration Layer (WhatsApp/Email/
Meta Ads/Calendar/Stripe) to verify live delivery against, no file storage
backing Legal documents, and audit-log field masking / full endpoint
coverage is not implemented.
