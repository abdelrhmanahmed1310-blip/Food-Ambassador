import { z } from "zod";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";

export const createRecallSchema = z.object({
  title: requiredText(160),
  reason: requiredText(2000),
});

export const recallLotsSchema = z.object({
  lotIds: z.array(uuidSchema).min(1, { error: "nothingSelected" }).max(500),
});

export const closeRecallSchema = z.object({
  outcome: z.enum(["DISPOSED", "RELEASED"], { error: "invalidOption" }),
  note: requiredText(2000),
});

export const cancelRecallSchema = z.object({ note: optionalText(2000) });
