# Kavosh One

Private source repository for the multi-academy management platform for Kavosh Al and Robotics Academy Inc.

## Status

The owner approved the implementation direction on 3 November 2026. This initial repository records the approved planning baseline; it does not contain a production implementation or claim tested financial/security functionality.

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
