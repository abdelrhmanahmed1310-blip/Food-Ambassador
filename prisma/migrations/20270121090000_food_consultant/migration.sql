-- Food consultant: conversations carry their mode (DECISIONS.md ADR-131).

-- CreateEnum
CREATE TYPE "AssistantMode" AS ENUM ('BUSINESS', 'CONSULTANT');

-- AlterTable
ALTER TABLE "assistant_conversations" ADD COLUMN     "mode" "AssistantMode" NOT NULL DEFAULT 'BUSINESS';

CREATE INDEX "assistant_conversations_mode_idx" ON "assistant_conversations" ("organization_id", "user_id", "mode", "updated_at");

-- The consultant has its own right (kitchen staff use it without the business assistant).
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'consultant.use'), ('operations_manager', 'consultant.use'),
             ('branch_manager', 'consultant.use'), ('food_safety', 'consultant.use'),
             ('kitchen', 'consultant.use'), ('procurement', 'consultant.use'),
             ('warehouse', 'consultant.use'), ('finance', 'consultant.use'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
