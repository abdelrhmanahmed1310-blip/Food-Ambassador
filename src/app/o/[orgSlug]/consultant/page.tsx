import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChatScreen } from "@/components/assistant/chat-screen";
import { PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { canUseConsultant } from "@/modules/assistant/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** The food consultant, in Arabic or English (ADR-131). */
export default async function ConsultantPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/consultant">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canUseConsultant(ctx)) notFound();
  const t = await getTranslations("consultant");
  return (
    <>
      <PageHeader title={t("title")} description={t("hint")} />
      <ChatScreen
        ctx={ctx}
        orgSlug={orgSlug}
        mode="CONSULTANT"
        chosenId={sp.c}
        intro={hasPermission(ctx.grants, "recipes.view") ? t("withData") : t("generalOnly")}
        examples={[t("example1"), t("example2"), t("example3"), t("example4"), t("example5")]}
      />
    </>
  );
}
