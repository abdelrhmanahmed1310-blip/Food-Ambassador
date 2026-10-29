import "server-only";
import { getLocale } from "next-intl/server";
import type { Decimal } from "@/lib/decimal";

type WarehouseOption = {
  id: string;
  code: string;
  name: string;
  locations: Array<{ id: string; code: string; name: string }>;
};

/** "warehouseId:locationId" picker values: each warehouse, then its locations. */
export function placeOptions(warehouses: WarehouseOption[]) {
  return warehouses.flatMap((w) => [
    { value: `${w.id}:`, label: `${w.code} — ${w.name}` },
    ...w.locations.map((l) => ({
      value: `${w.id}:${l.id}`,
      label: `${w.code} / ${l.code} — ${l.name}`,
    })),
  ]);
}

export function productOptions(
  products: Array<{
    id: string;
    sku: string;
    nameEn: string;
    nameAr: string | null;
    baseUom: { code: string };
  }>,
  locale: string,
) {
  return products.map((p) => ({
    value: p.id,
    label: `${p.sku} — ${(locale === "ar" && p.nameAr) || p.nameEn} (${p.baseUom.code})`,
  }));
}

export function unitOptions(
  units: Array<{ id: string; code: string; nameEn: string; nameAr: string }>,
  locale: string,
) {
  return units.map((u) => ({
    value: u.id,
    label: `${u.code} — ${locale === "ar" ? u.nameAr : u.nameEn}`,
  }));
}

export function productName(p: { nameEn: string; nameAr: string | null }, locale: string) {
  return (locale === "ar" && p.nameAr) || p.nameEn;
}

/**
 * Format a decimal quantity for display without converting it to a float:
 * Intl.NumberFormat formats decimal strings exactly. Latin digits are used
 * in both languages so quantities match codes and exports.
 */
export async function quantityFormatter() {
  const locale = await getLocale();
  const nf = new Intl.NumberFormat(`${locale}-u-nu-latn`, { maximumFractionDigits: 6 });
  return (value: Decimal | { toString(): string }) =>
    nf.format(value.toString() as unknown as number);
}

/**
 * Format money (4 dp) or a unit cost (6 dp) in the organization's base
 * currency, exactly, from its decimal string (same approach as quantities).
 */
export async function moneyFormatter(currency: string) {
  const locale = await getLocale();
  const money = new Intl.NumberFormat(`${locale}-u-nu-latn`, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const unit = new Intl.NumberFormat(`${locale}-u-nu-latn`, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  return {
    money: (value: Decimal | { toString(): string }) =>
      money.format(value.toString() as unknown as number),
    unitCost: (value: Decimal | { toString(): string }) =>
      unit.format(value.toString() as unknown as number),
  };
}
