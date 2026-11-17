-- Modules and functions an organization switches off (ADR-137). Entries are
-- "module:<key>" or a function key; the service keeps them to known keys.
ALTER TABLE "organizations" ADD COLUMN "disabled_features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_disabled_features_check"
  CHECK (cardinality("disabled_features") <= 200);
