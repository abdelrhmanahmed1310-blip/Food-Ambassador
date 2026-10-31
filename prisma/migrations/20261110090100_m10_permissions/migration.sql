-- New permission for existing organizations' system roles (ADR-048).
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'integrations.manage')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
