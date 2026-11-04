"use server";

import { submitFeedback } from "@/modules/crm/feedback";
import { errorToState } from "@/server/actions/handle";

/** A guest rates an order from the link on its receipt (ADR-118); no sign-in. */
export async function submitFeedbackAction(
  token: string,
  input: { rating: number; comment: string },
) {
  try {
    await submitFeedback(token, { rating: String(input.rating), comment: input.comment });
    return { ok: true };
  } catch (error) {
    const state = await errorToState(error, {});
    return { ok: false, error: Object.values(state.fieldErrors ?? {})[0] ?? state.formError ?? "" };
  }
}
