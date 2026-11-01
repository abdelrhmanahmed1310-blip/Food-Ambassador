import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Till } from "@/components/pos/till";
import { LinkButton } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { tillData } from "@/modules/pos/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { submitOrderAction } from "../../../actions";

/** The cashier screen: works on a tablet, a phone or a desktop browser (ADR-057). */
export default async function SellPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/registers/[registerId]/sell">) {
  const { orgSlug, registerId } = await params;
  if (!isUuid(registerId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const [t, data] = await Promise.all([
    getTranslations(),
    notFoundOnAppError(tillData(ctx, registerId)),
  ]);
  if (!data.shift) redirect(`/o/${orgSlug}/pos/registers/${registerId}`);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {data.register.code} — {data.register.name}
          <span className="text-muted ms-2 text-sm font-normal">
            {data.register.branchName} · {data.shift.number}
          </span>
        </h1>
        <LinkButton href={`/o/${orgSlug}/pos/registers/${registerId}`} variant="secondary">
          {t("pos.shiftAndCash")}
        </LinkButton>
      </div>
      <Till orgSlug={orgSlug} data={data} submit={submitOrderAction.bind(null, orgSlug)} />
    </div>
  );
}
