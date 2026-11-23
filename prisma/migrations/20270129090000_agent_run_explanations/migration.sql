-- ADR-141: Claude-written explanations of agent runs, in English and Arabic.
-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "explained_at" TIMESTAMPTZ(3),
ADD COLUMN     "explanation" JSONB,
ADD COLUMN     "explanation_error" TEXT,
ADD COLUMN     "explanation_input_tokens" INTEGER,
ADD COLUMN     "explanation_model" TEXT,
ADD COLUMN     "explanation_output_tokens" INTEGER;

-- An explanation holds both languages as text, and comes with its model and time.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_explanation_check" CHECK (
  "explanation" IS NULL OR (
    jsonb_typeof("explanation") = 'object'
    AND jsonb_typeof("explanation" -> 'en') = 'string'
    AND jsonb_typeof("explanation" -> 'ar') = 'string'
    AND "explanation_model" IS NOT NULL
    AND "explained_at" IS NOT NULL
  )
);
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_explanation_tokens_check" CHECK (
  ("explanation_input_tokens" IS NULL OR "explanation_input_tokens" >= 0)
  AND ("explanation_output_tokens" IS NULL OR "explanation_output_tokens" >= 0)
);
