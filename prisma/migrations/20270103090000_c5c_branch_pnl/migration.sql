-- C5c branch P&L (ADR-111): permission only.
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'pnl.view'), ('finance', 'pnl.view'),
             ('operations_manager', 'pnl.view'), ('branch_manager', 'pnl.view'),
             ('analyst', 'pnl.view'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
