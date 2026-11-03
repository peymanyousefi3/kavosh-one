# Kavosh One

Private source repository for the multi-academy management platform for Kavosh Al and Robotics Academy Inc.

## Status

The owner authorized continuous backend implementation on 3 November 2026: implementation, tests, review and fixes proceed across milestones without another approval request. Visual UI/UX work still requires owner input. This remains an incomplete backend, not a production-ready academy or accounting platform. `backend-work.json` tracks the full approved scope and remaining dependencies; a passing milestone is not the end of the work.

Implemented: PostgreSQL migrations, tenant row policies and composite references, immutable academy-master identity, multi-role permissions with deny precedence, expiring/scoped bot credentials, shared rate limits, hub/pending-person creation and listing, audit history, credential revocation, bounded JSON/pagination, and transactional audit/outbox/idempotency records.

Human identity uses pinned Better Auth: invitation-only email/password signup, email verification, signed-in phone verification, master new-device MFA, optional MFA for others, trusted devices, encrypted single-use recovery codes, password recovery and session management. Unverified accounts cannot use academy APIs. The encrypted auth-message queue has a separate least-privilege delivery worker with SMTP/Twilio adapters; live providers are **not configured or delivery-verified**. The separate business-event outbox does not have an automation worker yet.

Role-template create/read/update/duplicate, scoped staff assignments, effective-access inspection, supervisor hierarchy and exact-payload approval APIs are implemented. Masters self-approve; other actors require a permitted upper human reviewer. Expired/revoked bot credentials, changed authority and target versions invalidate pending proposals. Withdraw/reject history, reasons, audit and atomic rollback are preserved. Scoped denials exclude only affected hubs. Templates are academy-wide policy configuration; person-assignment views redact outside-scope segments.

Role-management screens, guardian-linked child contact verification, manual identity-recovery review, approvals for later domain modules, accounting, R2 uploads, BoldSign and other planned modules remain in progress/planned. No mock verification or public activation bypass exists.

The separate `kavosh-academy` repository contains the existing public-facing website and learning lab. Work here must not overwrite or deploy that project.

## Product workspaces

Overview, Academy, People, Learning, Finance, Reports, Community and Administration. Files, approvals, audit history and notifications are shared capabilities. External management agents use a scoped, documented API, with configurable approvals and limits.

## Approved technical direction

- React/TypeScript with a supported standard Next.js/Node deployment.
- PostgreSQL as the authoritative transactional store.
- Private R2 object storage and permission-aware file browsing.
- Separate background workers for reports, notifications, payroll and automation.
- BoldSign integration, subject to verifying the existing account's API entitlement.
- VPS/container compatibility and custom domains.

See [the planning baseline](docs/implementation-plan.md) and its [PDF copy](docs/implementation-plan.pdf). The baseline was written before approval, so its pause statements describe the document's original status; this README records the subsequent approval. Proposed defaults and outstanding vendor/legal/accounting gates remain explicitly identified in the plan.

## Repository rules

Keep this repository private. Never commit credentials, tokens, production databases, student/guardian records, private media, signatures or financial exports. Use synthetic data for tests. `.gitignore` is a convenience, not a secret scanner or an access-control boundary.

Implement in reviewable stages. Every completion claim needs evidence from the relevant persistence, authorization, accounting, browser or integration check. Paid integrations and production launch are separate authorization gates.

## Backend development

Use Node 22.13+ and pnpm 11.25.0. Install with `pnpm install --frozen-lockfile`. Run `pnpm typecheck`, `pnpm test`, `pnpm build` and then `pnpm test:http`. Tests use synthetic fixtures in an embedded PostgreSQL engine; setting `TEST_DATABASE_URL` to an isolated loopback PostgreSQL service runs the same suite over the real TCP driver in disposable, uniquely named databases. That integration account must be able to create databases. Never point tests at production.

The GitHub workflow checks both engines, migration repeatability, compilation, actual HTTP security responses, container execution and production dependency advisories. Real PostgreSQL also runs a bounded HTTP load test with 5,000 synthetic identities and 100 simultaneous connections (100 password logins, 300 session reads and 300 scoped business reads). It reports measured latency/errors, not a production capacity guarantee. Check the workflow result for the commit before treating CI as passed.

`pnpm db:migrate` uses only `MIGRATION_DATABASE_URL`. A database operator must separately provision a non-owner login belonging to `kavosh_runtime`, then place that login's connection string in runtime `DATABASE_URL`. No runtime account may inherit migration-owner, superuser or RLS-bypass privileges. Verified TLS is the default; plaintext is allowed only outside production for local development. Production must not receive migration credentials at all.

`pnpm bootstrap` reads `BOOTSTRAP_ACADEMY_NAME`, `BOOTSTRAP_MASTER_NAME`, `BOOTSTRAP_MASTER_EMAIL` and the migration connection from the operator's environment. It creates a provisioning-state academy with a pending human master and a seven-day bot credential. It prints the credential once for secure local storage; do not run in shared logs or paste it into chat. It does not send messages, verify users or activate an academy. This command provisions a new academy each time; do not rerun expecting to update an existing one.

Production packaging is provided in `Dockerfile`; the image runs as a non-root user and contains no database credentials. Real TLS, WAF/DDoS settings, failover, backups/restore and external delivery still require deployment verification. No deployment was performed. The intended deployment is an isolated `one.kavosh.ai` application on the existing VPS only after capacity/configuration review; the landing page must remain untouched.

## Human identity setup and flow

1. Apply migrations using the operator environment. Provision three **different** non-owner database logins: `kavosh_runtime` member for business APIs, `kavosh_identity` member for authentication, and `kavosh_delivery` member for the delivery worker. Never grant them `kavosh_identity_policy` or ownership/elevated roles. Identity is stored in its own private schema, not a separate physical database.
2. Configure web-only `APP_ORIGIN`, `AUTH_SECRET` (random, at least 32 characters), `IDENTITY_DATABASE_URL`, `DATABASE_URL` and, in production, `EDGE_AUTH_SECRET`. Keep migration credentials out of both web and worker environments. Production database TLS must verify certificates. Production origin must be HTTPS and exactly an origin, without trailing slash or path.
3. Provision the academy, then run `pnpm auth:invite` in the operator environment with `INVITE_ACADEMY_ID`, `INVITE_PERSON_ID`, `AUTH_SECRET` and `MIGRATION_DATABASE_URL`. The pending person's saved email is the invitation destination. Issuance expires old invitations and prints a private, single-use 48-hour invitation; do not put that output in shared logs. Invitation issuance is operator-only in this milestone.
4. The future interface supplies that invitation via `X-Kavosh-Invitation` to `POST /api/auth/sign-up/email`. The person verifies their email link, signs in, verifies a phone they control, then signs in again. Phone verification revokes existing sessions rather than upgrading an old session. A master completes SMS MFA, then accepts the invitation using `POST /api/auth/accept-invitation`. Only successful verified master acceptance activates a provisioning academy. Accepting an ordinary invitation grants no role automatically.
5. Use `/api/auth/memberships` to select an academy, then send `X-Academy-Id` with the host-only session cookie to business APIs. Membership, verification, MFA, academy state and roles are checked server-side. Cookies never authorize access to a foreign academy. Cookie-authenticated mutations require the exact configured Origin.

Every new master device requires an extra step; explicit trust lasts at most 30 days and rotates on use. Others can enable SMS or authenticator MFA. Recovery-code generation requires a fresh verified session and password; store the returned codes securely offline. Password reset/change revokes sessions and remembered-device grants without disabling MFA. There are no security questions or phone-only login/reset endpoints. Changing a verified phone and lost-all-factor recovery require a separately designed, audited support process; no unsafe bypass is provided.

The login interface should guide the user one task at a time (create account → verify email → verify phone → enter academy), automatically choosing the necessary next step, with plain-language errors and resend cooldowns. It must never read/store session tokens, put invitation/reset secrets in analytics, or reveal account existence in recovery messages. Reset links currently target the reserved `/account/recover#token=…` route; that interface is not built, so do not send onboarding messages to real users yet.

`pnpm auth:deliver` runs separately with `DELIVERY_DATABASE_URL`, the same `AUTH_SECRET`, SMTP settings and Twilio credentials from `.env.example`. It leases encrypted messages, retries failures up to three times with backoff, stops expired messages and scrubs payloads after delivery/expiry/final failure. SMTP requires TLS and valid certificates; Twilio calls use a fixed HTTPS endpoint. Provider acceptance is not proof of inbox/handset delivery. A crash after provider acceptance can cause a duplicate retry (at-least-once delivery). Real sender/domain/number setup, delivery receipts, regional regulatory registration and provider billing remain deployment gates.

At the reverse proxy, overwrite `X-Kavosh-Client-IP` from the trusted connection, remove client-supplied proxy headers and inject `X-Kavosh-Edge-Key`. Reject direct access to the application port. The application fails closed on missing/wrong production edge credentials. Add edge request timeouts, body limits, connection/rate limits and upstream DDoS protection; the app limiter alone is not DDoS protection. Never log query strings on verification endpoints, credentials, request bodies or cookies.

Retain `AUTH_SECRET` securely for encrypted recovery codes/messages and invitation digests; unplanned rotation makes them unusable. The running delivery worker hourly purges expired sessions/challenges, budgets older than two days, and expired invitations/scrubbed delivery rows after seven days. This does not delete academy records or audit/security history. Recovery-code regeneration signs out existing sessions; the interface must explain saving codes before signing in again. Before any production launch recheck Better Auth's announced 3 November security release and apply its stable fixes when published; 1.7.15 was the latest stable during this implementation check, not a guarantee against unpublished issues.

## API contract

`public/openapi.json` describes the implemented endpoints. `pnpm api:generate` updates the contract from the actual authentication and business schemas. Business endpoints accept either an expiring bot bearer token (academy derived from token) or a verified human cookie plus an authorized academy selection. Mutations require a UUID `Idempotency-Key`. People creation makes a pending record, not a login or enrollment.

The academy catalogue supports editable countries, provinces/regions, cities, hub contact/address/map coordinates, explicit time zones/currencies, multilingual labels and versioned courses with ordered modules. Hub-scoped readers see only permitted geography; shared and hub-specific courses have separate editing checks. Updates require the current version and preserve omitted fields. Sending a modules array replaces that ordered outline and retains the prior immutable snapshot. Archive rather than delete historical records. Active children prevent geographic archival. Minimal legacy hubs are flagged `setup_complete=false` until their location/time-zone/currency settings are explicitly supplied; no values are guessed. Course bodies are limited to 1 MiB and 100 modules; ordinary business bodies remain limited to 16 KiB. Classes, calendars, enrollment and the other items marked incomplete in `backend-work.json` are not implemented by this catalogue batch.

Registered approval actions share a single exact-payload engine; policy changes hold an exclusive academy policy lock, while ordinary domain writes share that lock to allow concurrency without mid-write permission changes. Geography/hub topology changes use an additional lock to prevent active-child/archive races. The application checks permissions before acquiring these locks and rechecks current rights afterward. Catalogue editing itself follows feature editing rights rather than requiring approval of every profile correction; protected administration changes still require the configured human superior, with master self-approval.

Liveness is `/api/health`; readiness is `/api/ready`. Readiness checks the required schema revision and both business/identity database roles. It fails closed on absent configuration, stale schema, unsafe privileges or invalid TLS; it is not a claim that external email/SMS delivery or all planned modules work. Each later schema migration must advance `public.schema_revision()` and `expectedSchemaRevision` together, with its readiness test. The current API-only CSP intentionally permits no page scripts or camera access; replace it with a tested route-specific policy when the real interface is built.
