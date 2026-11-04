import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { unsubscribePage } from "@/modules/crm/campaigns";
import { unsubscribeAction } from "../actions";

export const dynamic = "force-dynamic";

/** Stop receiving offers (ADR-119). */
export default async function UnsubscribePage({ params }: PageProps<"/unsubscribe/[token]">) {
  const { token } = await params;
  const p = await unsubscribePage(token);
  if (!p) notFound();
  const t = await getTranslations("unsubscribe");
  return (
    <main className="mx-auto w-full max-w-lg space-y-4 p-4">
      <h1 className="text-2xl font-semibold">{t("title", { organization: p.organizationName })}</h1>
      {p.done ? (
        <p role="status">{t("done")}</p>
      ) : (
        <form action={unsubscribeAction.bind(null, token)} className="space-y-3">
          <p>{t("question")}</p>
          <button type="submit" className="bg-primary text-primary-foreground rounded-lg px-4 py-2">
            {t("confirm")}
          </button>
        </form>
      )}
    </main>
  );
}
