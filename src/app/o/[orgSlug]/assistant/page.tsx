import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChatScreen } from "@/components/assistant/chat-screen";
import { PageHeader } from "@/components/ui/primitives";
import { canUseAssistant } from "@/modules/assistant/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** Questions in plain language, answered from the app's own reports (ADR-122). */
export default async function AssistantPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/assistant">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canUseAssistant(ctx)) notFound();
  const t = await getTranslations("assistant");
  return (
    <>
      <PageHeader title={t("title")} description={t("hint")} />
      <ChatScreen ctx={ctx} orgSlug={orgSlug} mode="BUSINESS" chosenId={sp.c} />
    </>
  );
}
