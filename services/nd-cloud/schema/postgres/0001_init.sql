-- ND Cloud PostgreSQL target schema (EXPERIMENTAL, NOT CONNECTED TO PILOT).
-- Do not deploy until reviewed with ND-DSH PRD 0009/0010 and identity ADR.
-- Use a distinct unprivileged app role, SET LOCAL nd.tenant_id only AFTER
-- trusted authentication, and an application transaction per request.
-- Never give the app role table ownership, BYPASSRLS, or DDL permissions.
BEGIN;

CREATE TABLE nd_schema_migrations (
  version INTEGER PRIMARY KEY,
  sha256 CHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE nd_tenants (
  tenant_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE nd_principals (
  principal_id UUID PRIMARY KEY,
  oidc_issuer TEXT NOT NULL,
  oidc_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE nd_memberships (
  tenant_id TEXT NOT NULL REFERENCES nd_tenants(tenant_id),
  principal_id UUID NOT NULL REFERENCES nd_principals(principal_id),
  role TEXT NOT NULL CHECK (role IN ('owner','reviewer','viewer')),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY(tenant_id, principal_id)
);

CREATE TABLE nd_projects (
  tenant_id TEXT NOT NULL REFERENCES nd_tenants(tenant_id),
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,project_id)
);

CREATE TABLE nd_project_grants (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  principal_id UUID NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read','review','manage')),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY(tenant_id,project_id,principal_id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES nd_projects(tenant_id,project_id),
  FOREIGN KEY(tenant_id,principal_id) REFERENCES nd_memberships(tenant_id,principal_id)
);

CREATE TABLE nd_host_bindings (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  host_id UUID NOT NULL,
  local_company_id TEXT NOT NULL,
  local_project_id TEXT NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,project_id,host_id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES nd_projects(tenant_id,project_id)
);

CREATE TABLE nd_boards (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  host_id UUID NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  digest CHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id),
  FOREIGN KEY(tenant_id,project_id,host_id) REFERENCES nd_host_bindings(tenant_id,project_id,host_id)
);

CREATE TABLE nd_source_snapshots (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_id UUID NOT NULL,
  artifact_sha256 CHAR(64) NOT NULL,
  manifest JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id,source_id),
  UNIQUE(tenant_id,project_id,artifact_sha256),
  FOREIGN KEY(tenant_id,project_id) REFERENCES nd_projects(tenant_id,project_id)
);

CREATE TABLE nd_wiki_pages (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  page_id UUID NOT NULL,
  source_id UUID NOT NULL,
  source_path TEXT,
  source_sha256 CHAR(64) NOT NULL,
  author_id UUID NOT NULL REFERENCES nd_principals(principal_id),
  reviewer_id UUID REFERENCES nd_principals(principal_id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','stale')),
  revision BIGINT NOT NULL CHECK(revision > 0),
  PRIMARY KEY(tenant_id,project_id,page_id),
  FOREIGN KEY(tenant_id,project_id,source_id) REFERENCES nd_source_snapshots(tenant_id,project_id,source_id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES nd_projects(tenant_id,project_id),
  CHECK (reviewer_id IS NULL OR reviewer_id <> author_id)
);

CREATE TABLE nd_support_cases (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  case_id UUID NOT NULL,
  reporter_id UUID NOT NULL REFERENCES nd_principals(principal_id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id,case_id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES nd_projects(tenant_id,project_id)
);

CREATE TABLE nd_task_proposals (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  proposal_id UUID NOT NULL,
  case_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  author_id UUID NOT NULL REFERENCES nd_principals(principal_id),
  approved_by UUID REFERENCES nd_principals(principal_id),
  status TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  content TEXT NOT NULL,
  host_reported_task_id TEXT,
  PRIMARY KEY(tenant_id,project_id,proposal_id),
  UNIQUE(tenant_id,project_id,case_id,idempotency_key),
  FOREIGN KEY(tenant_id,project_id,case_id) REFERENCES nd_support_cases(tenant_id,project_id,case_id),
  CHECK (approved_by IS NULL OR approved_by <> author_id)
);

CREATE TABLE nd_project_events (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  seq BIGINT NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id,seq),
  FOREIGN KEY(tenant_id,project_id) REFERENCES nd_projects(tenant_id,project_id)
);

CREATE TABLE nd_ledger_transactions (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  txn_id UUID NOT NULL,
  reference TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id,txn_id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES nd_projects(tenant_id,project_id)
);
CREATE TABLE nd_ledger_legs (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  txn_id UUID NOT NULL,
  leg_number SMALLINT NOT NULL CHECK (leg_number BETWEEN 1 AND 4),
  account TEXT NOT NULL,
  amount BIGINT NOT NULL,
  PRIMARY KEY(tenant_id,project_id,txn_id,leg_number),
  FOREIGN KEY(tenant_id,project_id,txn_id) REFERENCES nd_ledger_transactions(tenant_id,project_id,txn_id)
);
-- Balanced legs MUST be enforced by an application transaction/deferrable
-- constraint trigger before this schema can host financial data.

-- FORCE RLS on every scoped table, including cross-reference tables. RLS is
-- defense-in-depth: app must independently authorize tenant/project/role.
ALTER TABLE nd_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nd_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY nd_tenant_scope ON nd_tenants USING (tenant_id = current_setting('nd.tenant_id', true));

DO $ddl$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'nd_memberships','nd_projects','nd_project_grants','nd_host_bindings','nd_boards',
    'nd_source_snapshots','nd_wiki_pages','nd_support_cases','nd_task_proposals',
    'nd_project_events','nd_ledger_transactions','nd_ledger_legs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY nd_tenant_scope ON %I USING (tenant_id = current_setting(''nd.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''nd.tenant_id'', true))',table_name);
  END LOOP;
END $ddl$;

-- nd_principals is global identity metadata and MUST NOT be queryable directly
-- by tenant clients. The app only resolves IDs via a restricted auth service.
REVOKE ALL ON nd_principals FROM PUBLIC;
REVOKE ALL ON nd_schema_migrations FROM PUBLIC;
COMMIT;
