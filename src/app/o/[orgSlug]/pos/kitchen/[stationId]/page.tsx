import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { AutoRefresh } from "@/components/pos/auto-refresh";
import { KitchenBoard } from "@/components/pos/kitchen-board";
import { LinkButton } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { prepTimes, stationBoard } from "@/modules/pos/kitchen";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { bumpAction, recallAction } from "../../kitchen-actions";

/** A station's kitchen screen: tickets oldest first, bump when ready (ADR-063). */
export default async function StationPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/kitchen/[stationId]">) {
  const { orgSlug, stationId } = await params;
  if (!isUuid(stationId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const board = await notFoundOnAppError(stationBoard(ctx, stationId));
  // Preparation times over the last 24 hours.
  const to = new Date();
  const [t, format, stats] = await Promise.all([
    getTranslations(),
    getFormatter(),
    prepTimes(ctx, stationId, { from: new Date(to.getTime() - 86_400_000), to }),
  ]);
  return (
    <div className="space-y-4">
      <AutoRefresh seconds={5} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          {board.station.name}
          <span className="text-muted ms-2 text-sm font-normal">
            {board.station.branch.name} ·{" "}
            {t("pos.targetIs", { minutes: board.station.targetMinutes })}
          </span>
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {board.lastDone ? (
            <ConfirmActionButton
              action={recallAction.bind(null, orgSlug, board.lastDone.id)}
              label={t("pos.recall", { label: board.lastDone.label })}
              variant="secondary"
            />
          ) : null}
          <LinkButton href={`/o/${orgSlug}/pos/kitchen`} variant="secondary">
            {t("pos.kitchenScreens")}
          </LinkButton>
        </div>
      </div>
      <KitchenBoard
        targetMinutes={board.station.targetMinutes}
        bumpAction={bumpAction.bind(null, orgSlug)}
        tickets={board.tickets.map((k) => ({
          id: k.id,
          label: k.label,
          guests: k.guests,
          createdAt: k.createdAt.toISOString(),
          items: k.items.map((i) => ({
            id: i.id,
            name: i.name,
            quantity: i.quantity.toFixed(),
            options: Array.isArray(i.options) ? (i.options as string[]) : [],
            note: i.note,
            seat: i.seat,
            course: i.course,
            voided: i.voidedAt !== null,
          })),
        }))}
      />
      <p className="text-muted text-sm" data-testid="prep-stats">
        {stats.count === 0
          ? t("pos.noPrepTimes")
          : t("pos.prepStats", {
              count: stats.count,
              average: format.number(stats.average ?? 0, { maximumFractionDigits: 1 }),
              p90: format.number(stats.p90 ?? 0, { maximumFractionDigits: 1 }),
              late: stats.late,
            })}
      </p>
    </div>
  );
}
