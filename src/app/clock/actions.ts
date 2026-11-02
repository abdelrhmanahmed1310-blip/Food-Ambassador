"use server";

import { headers } from "next/headers";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { clockAtTerminal, terminalInfo } from "@/modules/hr/attendance";
import { formValues } from "@/server/actions/handle";

/** The branch tablet (ADR-080): no sign-in; the link, the PIN and rate limits protect it. */
export async function clockAction(
  token: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const [t, format, h, terminal] = await Promise.all([
    getTranslations("attendance"),
    getFormatter(),
    headers(),
    terminalInfo(token),
  ]);
  const seq = (previous.seq ?? 0) + 1;
  const r = await clockAtTerminal(
    token,
    formValues(formData),
    h.get(CLIENT_IP_HEADER) ?? "unknown",
  );
  if (!r.ok) return { ok: false, seq, formError: t(`errors.${r.error}`) };
  const timeZone = terminal?.branch.timeZone ?? terminal?.organization.timeZone ?? "UTC";
  return {
    ok: true,
    seq,
    data: {
      kind: r.kind,
      name: r.firstName,
      time: format.dateTime(r.at, { timeStyle: "short", timeZone }),
    },
  };
}
