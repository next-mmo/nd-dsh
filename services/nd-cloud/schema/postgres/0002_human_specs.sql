-- ND Cloud proposed PostgreSQL spec persistence schema (NOT EXECUTED by
-- the local Go JSON pilot; requires reviewed, transactional migration runner).
-- Preconditions: apply 0001_init.sql; migrate only using a dedicated DDL role.
-- Application sessions MUST resolve verified OIDC identity before setting
-- nd.tenant_id and MUST check per-project grants independently from RLS.
BEGIN;

CREATE TABLE nd_human_specs (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    spec_id TEXT NOT NULL,
    source_id UUID NOT NULL,
    source_path TEXT NOT NULL,
    source_sha256 CHAR(64) NOT NULL,
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
    status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'conflict')),
    author_id UUID NOT NULL REFERENCES nd_principals(principal_id),
    reviewer_id UUID REFERENCES nd_principals(principal_id),
    revision BIGINT NOT NULL CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, project_id, spec_id),
    FOREIGN KEY (tenant_id, project_id) REFERENCES nd_projects(tenant_id, project_id),
    FOREIGN KEY (tenant_id, project_id, source_id) REFERENCES nd_source_snapshots(tenant_id, project_id, source_id),
    CHECK (reviewer_id IS NULL OR reviewer_id <> author_id)
);

-- Each mutation appends an immutable human-facing revision. The hosted
-- implementation must make the row update + audit revision + outbox event one
-- SQL transaction; only the trusted service role can write these tables.
CREATE TABLE nd_human_spec_versions (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    spec_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    action TEXT NOT NULL CHECK (action IN ('create', 'revise', 'approve', 'source_conflict')),
    actor_id UUID REFERENCES nd_principals(principal_id), -- NULL = trusted system invalidation
    status TEXT NOT NULL CHECK (status IN ('draft','approved','conflict')),
    source_id UUID NOT NULL,
    source_path TEXT NOT NULL,
    source_sha256 CHAR(64) NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    happened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, project_id, spec_id, revision),
    FOREIGN KEY (tenant_id, project_id, spec_id) REFERENCES nd_human_specs(tenant_id, project_id, spec_id)
);

ALTER TABLE nd_human_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nd_human_specs FORCE ROW LEVEL SECURITY;
CREATE POLICY nd_tenant_scope ON nd_human_specs
    USING (tenant_id = current_setting('nd.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('nd.tenant_id', true));

ALTER TABLE nd_human_spec_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nd_human_spec_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY nd_tenant_scope ON nd_human_spec_versions
    USING (tenant_id = current_setting('nd.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('nd.tenant_id', true));

-- Future migration runner records a checksum in nd_schema_migrations only
-- AFTER verified successful completion. This file does not mark itself done.
COMMIT;
