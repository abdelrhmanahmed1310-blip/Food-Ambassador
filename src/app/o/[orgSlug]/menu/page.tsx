import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { MenuCategoryForm } from "@/components/menu/forms";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { SALES_CHANNELS } from "@/modules/menu/rules";
import { listMenu } from "@/modules/menu/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { createMenuCategoryAction } from "./actions";

export default async function MenuPage({ params }: PageProps<"/o/[orgSlug]/menu">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "menu.view")) notFound();
  const manage = hasPermission(ctx.grants, "menu.manage");
  const [t, locale, money, menu] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    listMenu(ctx),
  ]);
  const name = (x: { name: string; nameAr: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  const base = `/o/${orgSlug}/menu`;
  return (
    <>
      <PageHeader
        title={t("menu.title")}
        description={t("menu.intro")}
        actions={
          manage ? (
            <>
              <LinkButton href={`${base}/modifiers`} variant="secondary">
                {t("menu.modifiers")}
              </LinkButton>
              {menu.length > 0 ? (
                <LinkButton href={`${base}/items/new`}>{t("menu.newItem")}</LinkButton>
              ) : null}
            </>
          ) : null
        }
      />
      <div className="space-y-6">
        {menu.length === 0 ? (
          <EmptyState title={t("menu.noCategories")} hint={t("menu.noCategoriesHint")} />
        ) : null}
        {menu.map((c) => (
          <Card key={c.id} title={name(c)}>
            {c.items.length === 0 ? (
              <p className="text-muted text-sm">{t("menu.noItems")}</p>
            ) : (
              <Table label={name(c)}>
                <thead>
                  <tr>
                    <Th>{t("menu.code")}</Th>
                    <Th>{t("menu.name")}</Th>
                    <Th>{t("menu.kind")}</Th>
                    {SALES_CHANNELS.map((ch) => (
                      <Th key={ch}>{t(`menu.channels.${ch}`)}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.items.map((i) => (
                    <tr key={i.id} data-testid={`menu-item-${i.code}`}>
                      <Td>
                        <Link
                          href={`${base}/items/${i.id}`}
                          className="ltr-value text-primary font-mono hover:underline"
                        >
                          {i.code}
                        </Link>
                      </Td>
                      <Td>
                        <bdi>{name(i)}</bdi>{" "}
                        {i.archivedAt ? <Badge tone="muted">{t("menu.archived")}</Badge> : null}
                      </Td>
                      <Td>{t(`menu.kinds.${i.kind}`)}</Td>
                      {SALES_CHANNELS.map((ch) => (
                        <Td key={ch} className="tabular-nums">
                          <span className="ltr-value">
                            {i.current[ch] ? money.money(i.current[ch]!.price) : "—"}
                          </span>
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        ))}
        {manage ? (
          <Card title={t("menu.addCategory")}>
            <MenuCategoryForm action={createMenuCategoryAction.bind(null, orgSlug)} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
