"use server";

import { redirect } from "next/navigation";
import { unsubscribe } from "@/modules/crm/campaigns";

/** The guest stops offers from the link in a message (ADR-119); no sign-in. */
export async function unsubscribeAction(token: string) {
  await unsubscribe(token);
  redirect(`/unsubscribe/${token}`);
}
