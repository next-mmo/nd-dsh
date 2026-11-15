# PostgreSQL target schema — experimental, not active

This migration is a **reviewable design artifact** for replacing the single-process JSON pilot store. It has not been executed or validated against a running PostgreSQL instance in this environment, and the Go pilot does not use it. Do not assume tenant RLS alone is sufficient authorization: app must resolve a trusted OIDC principal and project grant, `SET LOCAL nd.tenant_id` only within an authenticated transaction, and use an unprivileged SQL role. Row-level security for global principals needs a dedicated restricted identity API, and balanced ledger legs require a deferred balance check before any money flow.

Production gates still required: Go-vs-Rust ADR, a reviewed Go PostgreSQL driver/lockfile, migration tool, tenant isolation tests on real PostgreSQL, HA/cross-process concurrency, encrypted backups and point-in-time restore, key rotation, OIDC/MFA, audit and incidents, provider-rights signoff and finance-grade webhook reconciliation. No live billing or model resale is authorized by this file.


The experimental `0002_human_specs.sql` adds tenant/project-scoped spec revisions and independent reviewer metadata as a **design target only**. The JSON pilot does not invoke these migrations. A future PostgreSQL migration runner must enforce immutable history, project-level ABAC, RLS, writer authorization, one transaction per update/review/outbox write, checksums and restore/drill evidence before deployment.
