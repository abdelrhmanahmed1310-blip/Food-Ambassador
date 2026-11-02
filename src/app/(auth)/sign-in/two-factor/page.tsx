import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SecondFactorForm } from "@/components/two-factor-forms";
import { safeNextPath } from "@/server/auth/session";
import { verifySecondFactorAction } from "../../actions";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("auth"))("twoFactorTitle") };
}

/** The second step of signing in (ADR-073). */
export default async function TwoFactorPage({ searchParams }: PageProps<"/sign-in/two-factor">) {
  const next = safeNextPath((await searchParams).next) ?? undefined;
  const t = await getTranslations("auth");
  return (
    <div className="border-border bg-surface rounded-lg border p-6">
      <h1 className="text-xl font-semibold">{t("twoFactorTitle")}</h1>
      <p className="text-muted mt-1 mb-6 text-sm">{t("twoFactorSubtitle")}</p>
      <SecondFactorForm action={verifySecondFactorAction} next={next} />
    </div>
  );
}
