-- A source may have no secret_ref (#385): a Prometheus source with
-- `auth: "none"`, an in-cluster endpoint with no authentication, names no
-- credentials, so it names no reference either. Every other source still
-- carries one, which the application enforces per kind (SourceDraft in
-- src/lib/registry.ts) rather than a CHECK on `config`, so the rule lives
-- beside the kind that owns it.
--
-- Expand only: every existing row keeps its value, and code from before this
-- migration never writes NULL.

ALTER TABLE sources ALTER COLUMN secret_ref DROP NOT NULL;

-- rollback:
-- A row written with no reference cannot be made to have one; it is removed
-- rather than given a made-up name, and so is anything that cascades from it.
DELETE FROM sources WHERE secret_ref IS NULL;
ALTER TABLE sources ALTER COLUMN secret_ref SET NOT NULL;
