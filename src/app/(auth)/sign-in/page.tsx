import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SignInForm } from "@/components/auth-forms";
import { getCurrentUser, safeNextPath } from "@/server/auth/session";
import { signInAction } from "../actions";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("auth"))("signInTitle") };
}

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const next = safeNextPath((await searchParams).next) ?? undefined;
  if (await getCurrentUser()) redirect(next ?? "/");
  const t = await getTranslations("auth");
  return (
    <div className="border-border bg-surface rounded-lg border p-6">
      <h1 className="text-xl font-semibold">{t("signInTitle")}</h1>
      <p className="text-muted mt-1 mb-6 text-sm">{t("signInSubtitle")}</p>
      <SignInForm
        action={signInAction}
        next={next}
        labels={{
          email: t("email"),
          password: t("password"),
          submit: t("signIn"),
          pending: t("signIn"),
        }}
      />
      <p className="text-muted mt-6 text-sm">
        {t("noAccount")}{" "}
        <Link
          href="/sign-up"
          className="text-primary font-medium underline-offset-2 hover:underline"
        >
          {t("signUp")}
        </Link>
      </p>
    </div>
  );
}
