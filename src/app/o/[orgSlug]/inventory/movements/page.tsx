import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MovementsTable } from "@/components/inventory/movements-table";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import type { MovementType } from "@/generated/prisma/client";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listMovements, warehouseOptions } from "@/modules/inventory/queries";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const MOVEMENT_TYPES: MovementType[] = [
  "OPENING_BALANCE",
  "ADJUSTMENT",
  "WRITE_OFF",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "STATUS_CHANGE",
  "COUNT_ADJUSTMENT",
  "REVERSAL",
];

export default async function MovementsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory/movements">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) notFound();
  const id = (v: unknown) => (typeof v === "string" && isUuid(v) ? v : undefined);
  const filters = {
    warehouseId: id(sp.warehouseId),
    productId: id(sp.productId),
    lotId: id(sp.lotId),
    movementType: MOVEMENT_TYPES.includes(sp.movementType as MovementType)
      ? (sp.movementType as MovementType)
      : undefined,
  };
  const page = pageSchema.parse(sp.page);
  const [t, result, warehouses] = await Promise.all([
    getTranslations(),
    listMovements(ctx, { ...filters, page }),
    warehouseOptions(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("inventory.movementsTitle")} />
      <form method="get" className="mb-4 flex flex-col gap-2 sm:flex-row">
        {filters.productId ? (
          <input type="hidden" name="productId" value={filters.productId} />
        ) : null}
        {filters.lotId ? <input type="hidden" name="lotId" value={filters.lotId} /> : null}
        <label className="sr-only" htmlFor="warehouseId">
          {t("common.warehouse")}
        </label>
        <select
          id="warehouseId"
          name="warehouseId"
          defaultValue={filters.warehouseId ?? ""}
          className={inputClass}
        >
          <option value="">{t("common.allWarehouses")}</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} — {w.name}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="movementType">
          {t("inventory.movementType")}
        </label>
        <select
          id="movementType"
          name="movementType"
          defaultValue={filters.movementType ?? ""}
          className={inputClass}
        >
          <option value="">{t("inventory.allTypes")}</option>
          {MOVEMENT_TYPES.map((m) => (
            <option key={m} value={m}>
              {t(`inventory.movementTypes.${m}`)}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass("secondary")}>
          {t("common.apply")}
        </button>
      </form>
      {result.items.length === 0 ? (
        <EmptyState title={t("inventory.emptyMovements")} />
      ) : (
        <MovementsTable rows={result.items} orgSlug={orgSlug} timeZone={ctx.timeZone} />
      )}
      <Pagination
        basePath={`/o/${orgSlug}/inventory/movements`}
        params={filters}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
