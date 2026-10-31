import { getTranslations } from "next-intl/server";
import { AttentionList } from "@/components/reports/attention-list";
import { PageHeader } from "@/components/ui/primitives";
import { attentionItems } from "@/modules/analytics/attention";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function AttentionPage({ params }: PageProps<"/o/[orgSlug]/attention">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, items] = await Promise.all([getTranslations("attention"), attentionItems(ctx)]);
  return (
    <>
      <PageHeader title={t("title")} description={t("hint")} />
      <AttentionList items={items} base={`/o/${orgSlug}`} currency={ctx.baseCurrency} />
    </>
  );
}
