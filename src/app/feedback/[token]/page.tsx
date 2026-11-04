import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { GuestRatingForm } from "@/components/crm/forms";
import { feedbackPage } from "@/modules/crm/feedback";
import { submitFeedbackAction } from "../actions";

export const dynamic = "force-dynamic";

/** The guest rates their order (ADR-118). Nothing about them is asked. */
export default async function GuestFeedbackPage({ params }: PageProps<"/feedback/[token]">) {
  const { token } = await params;
  const p = await feedbackPage(token);
  if (!p) notFound();
  const t = await getTranslations("feedback");
  return (
    <main className="mx-auto w-full max-w-lg space-y-4 p-4">
      <header>
        <p className="text-muted text-sm">{p.organizationName}</p>
        <h1 className="text-2xl font-semibold">{t("title", { branch: p.branchName })}</h1>
        <p className="text-muted ltr-value text-sm">{p.orderNumber}</p>
      </header>
      {p.given ? (
        <p role="status">{t("already")}</p>
      ) : p.closed ? (
        <p role="status">{t("closed")}</p>
      ) : (
        <GuestRatingForm submit={submitFeedbackAction.bind(null, token)} />
      )}
      <p className="text-muted text-xs">{t("privacy")}</p>
    </main>
  );
}
