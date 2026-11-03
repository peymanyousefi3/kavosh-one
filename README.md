# Kavosh One

Private source repository for the multi-academy management platform for Kavosh Al and Robotics Academy Inc.

## Status

The owner approved the implementation direction on 3 November 2026. Backend milestone 1 implements a narrow, tested API foundation. This is not a production-ready academy or accounting platform.

Implemented: PostgreSQL migration, tenant row policies and composite references, an immutable academy-master reference, multi-role permissions with deny precedence, expiring/scoped bot credentials, shared rate limits, hub/pending-person creation and listing, audit history, credential revocation, bounded JSON/pagination, and transactional audit/outbox/idempotency records. The outbox has no delivery worker yet.

Human email/password sign-in, email/SMS verification, trusted devices, recovery, role-management screens, approval workflows, financial features, R2 uploads and BoldSign are **not implemented** in this milestone. Provisioning leaves an academy inactive until real identity verification is implemented. There are no mock verification or activation endpoints.

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

The GitHub workflow checks both engines, migration repeatability, compilation, actual HTTP security responses and production dependency advisories. Check the workflow result for the commit before treating CI as passed.

`pnpm db:migrate` uses only `MIGRATION_DATABASE_URL`. A database operator must separately provision a non-owner login belonging to `kavosh_runtime`, then place that login's connection string in runtime `DATABASE_URL`. No runtime account may inherit migration-owner, superuser or RLS-bypass privileges. Verified TLS is the default; plaintext is allowed only outside production for local development. Production must not receive migration credentials at all.

`pnpm bootstrap` reads `BOOTSTRAP_ACADEMY_NAME`, `BOOTSTRAP_MASTER_NAME`, `BOOTSTRAP_MASTER_EMAIL` and the migration connection from the operator's environment. It creates a provisioning-state academy with a pending human master and a seven-day bot credential. It prints the credential once for secure local storage; do not run in shared logs or paste it into chat. It does not send messages, verify users or activate an academy. This command provisions a new academy each time; do not rerun expecting to update an existing one.

Production packaging is provided in `Dockerfile`; the image runs as a non-root user and contains no database credentials. Docker image execution, real TLS, WAF/DDoS settings, failover and external-service integration still require deployment verification. No deployment was performed by this milestone.

## API contract

`public/openapi.json` describes the implemented endpoints. All business endpoints accept an expiring bot bearer token, derive the academy from that token and require current role/credential permissions. Mutations require a UUID `Idempotency-Key`. Human browser cookies are not accepted as authorization. People creation makes a pending record, not a login or enrollment.

Liveness is `/api/health`; readiness is `/api/ready`. Readiness fails closed when the database is absent, privileges are unsafe, TLS is misconfigured or the schema is missing. Neither endpoint proves that planned modules exist. The current API-only CSP intentionally permits no page scripts or camera access; replace it with a tested route-specific policy when the real interface is built.
