"use server";

import { placeGuestOrder } from "@/modules/pos/ordering";
import { errorToState } from "@/server/actions/handle";
import { getClientIp } from "@/server/request";

export type GuestOrderResult =
  | { ok: true; number: string; guestToken: string; paymentUrl: string | null }
  | { ok: false; error: string };

/** A guest places an order from the public page (ADR-070); no sign-in. */
export async function placeGuestOrderAction(
  publicToken: string,
  input: unknown,
): Promise<GuestOrderResult> {
  try {
    const r = await placeGuestOrder(publicToken, input, await getClientIp());
    return { ok: true, number: r.number, guestToken: r.guestToken, paymentUrl: r.paymentUrl };
  } catch (error) {
    const state = await errorToState(error, {});
    return {
      ok: false,
      error: Object.values(state.fieldErrors ?? {})[0] ?? state.formError ?? "",
    };
  }
}
