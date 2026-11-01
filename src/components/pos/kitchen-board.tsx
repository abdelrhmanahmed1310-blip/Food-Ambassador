"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ticketUrgency, type Urgency } from "@/modules/pos/kitchen-rules";

export interface BoardTicket {
  id: string;
  label: string;
  guests: number | null;
  createdAt: string;
  items: Array<{
    id: string;
    name: string;
    quantity: string;
    options: string[];
    note: string | null;
    seat: number | null;
    course: number | null;
    voided: boolean;
  }>;
}

const tone: Record<Urgency, string> = {
  ok: "border-border",
  warning: "border-amber-500 bg-warning-surface",
  late: "border-danger bg-danger-surface",
};

/**
 * A station's tickets, oldest first, with how long each has waited against
 * the station's target (ADR-063). The clock ticks on the device; the list
 * itself refreshes from the server every few seconds.
 */
export function KitchenBoard({
  tickets,
  targetMinutes,
  bumpAction,
}: {
  tickets: BoardTicket[];
  targetMinutes: number;
  bumpAction: (ticketId: string, state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const t = useTranslations();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  if (tickets.length === 0)
    return <p className="text-muted py-12 text-center text-lg">{t("pos.noTickets")}</p>;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tickets.map((k) => {
        const elapsed = now === null ? 0 : now - new Date(k.createdAt).getTime();
        const urgency = now === null ? "ok" : ticketUrgency(elapsed, targetMinutes);
        return (
          <li
            key={k.id}
            className={`bg-surface flex flex-col gap-2 rounded-lg border-2 p-3 ${tone[urgency]}`}
            data-testid={`ticket-${k.label}`}
            data-urgency={urgency}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-lg font-bold">
                <bdi>{k.label}</bdi>
              </span>
              <span className="ltr-value font-mono tabular-nums" aria-label={t("pos.waiting")}>
                {now === null ? "" : t("pos.minutes", { count: Math.floor(elapsed / 60_000) })}
              </span>
            </div>
            {k.guests ? (
              <span className="text-muted text-xs">
                {t("pos.guestsCount", { count: k.guests })}
              </span>
            ) : null}
            <ul className="space-y-1">
              {k.items.map((i) => (
                <li key={i.id} className={i.voided ? "text-muted line-through" : ""}>
                  <span className="font-semibold">
                    <span className="ltr-value tabular-nums">{i.quantity}</span> ×{" "}
                    <bdi>{i.name}</bdi>
                  </span>
                  {i.voided ? (
                    <span className="text-danger ms-1 text-xs font-bold">{t("pos.voidedTag")}</span>
                  ) : null}
                  {i.options.length > 0 ? (
                    <span className="block text-sm">{i.options.join(" · ")}</span>
                  ) : null}
                  {i.note ? (
                    <span className="block text-sm font-medium italic">“{i.note}”</span>
                  ) : null}
                  {i.seat || i.course ? (
                    <span className="text-muted block text-xs">
                      {[
                        i.course ? t("pos.courseN", { n: i.course }) : "",
                        i.seat ? t("pos.seatN", { n: i.seat }) : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="mt-auto">
              <ConfirmActionButton
                action={bumpAction.bind(null, k.id)}
                label={t("pos.bump")}
                variant="primary"
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
