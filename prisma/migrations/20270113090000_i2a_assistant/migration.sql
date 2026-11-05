-- I2a: AI assistant (DECISIONS.md ADR-122).


-- CreateEnum
CREATE TYPE "AssistantRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "assistant_settings" (
    "organization_id" UUID NOT NULL,
    "api_key_sealed" TEXT,
    "api_key_hint" TEXT,
    "model" TEXT NOT NULL DEFAULT 'claude-opus-5-5',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "daily_question_limit" INTEGER NOT NULL DEFAULT 50,
    "tested_at" TIMESTAMPTZ(3),
    "test_ok" BOOLEAN,
    "test_error" TEXT,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assistant_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "assistant_conversations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "AssistantRole" NOT NULL,
    "text" TEXT NOT NULL,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "stop_reason" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_conversations_organization_id_user_id_updated_at_idx" ON "assistant_conversations"("organization_id", "user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_conversations_organization_id_id_key" ON "assistant_conversations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "assistant_messages_organization_id_conversation_id_created__idx" ON "assistant_messages"("organization_id", "conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "assistant_settings" ADD CONSTRAINT "assistant_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "assistant_conversations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── I2a assistant (ADR-122): hand-written rules ───
ALTER TABLE "assistant_settings" ADD CONSTRAINT "assistant_settings_ck" CHECK (
  "daily_question_limit" BETWEEN 1 AND 1000
  AND "model" IN ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5')
  AND (NOT "enabled" OR ("api_key_sealed" IS NOT NULL AND "test_ok" IS TRUE)));
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_ck" CHECK (
  length("title") BETWEEN 1 AND 120);
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_ck" CHECK (
  length("text") BETWEEN 1 AND 20000);

-- Questions and answers are a record: never edited (old ones are deleted by retention).
CREATE OR REPLACE FUNCTION "assistant_messages_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'assistant messages cannot be changed' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "assistant_messages_fixed" BEFORE UPDATE ON "assistant_messages"
  FOR EACH ROW EXECUTE FUNCTION "assistant_messages_fixed"();

GRANT SELECT, INSERT, UPDATE ON "assistant_settings" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_conversations" TO fa_tenant;
GRANT SELECT, INSERT, DELETE ON "assistant_messages" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_settings', 'assistant_conversations', 'assistant_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'assistant.use'), ('admin', 'assistant.manage'),
             ('operations_manager', 'assistant.use'), ('procurement', 'assistant.use'),
             ('warehouse', 'assistant.use'), ('food_safety', 'assistant.use'),
             ('finance', 'assistant.use'), ('branch_manager', 'assistant.use'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
