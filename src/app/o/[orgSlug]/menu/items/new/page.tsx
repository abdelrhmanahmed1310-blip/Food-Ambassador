import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { MenuItemForm } from "@/components/menu/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { menuFormOptions } from "@/modules/menu/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createMenuItemAction } from "../../actions";

export default async function NewMenuItemPage({
  params,
}: PageProps<"/o/[orgSlug]/menu/items/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "menu.manage")) notFound();
  const [t, locale, o] = await Promise.all([getTranslations(), getLocale(), menuFormOptions(ctx)]);
  return (
    <>
      <PageHeader title={t("menu.newItem")} />
      <Card>
        <MenuItemForm
          action={createMenuItemAction.bind(null, orgSlug)}
          submitLabel={t("common.create")}
          categories={o.categories.map((c) => ({
            value: c.id,
            label: (locale === "ar" && c.nameAr) || c.name,
          }))}
          recipes={o.dishes.map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` }))}
          products={o.products.map((p) => ({
            value: p.id,
            label: `${p.sku} — ${p.nameEn} (${p.baseUom.code})`,
          }))}
          taxCodes={o.taxCodes.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))}
        />
      </Card>
    </>
  );
}
