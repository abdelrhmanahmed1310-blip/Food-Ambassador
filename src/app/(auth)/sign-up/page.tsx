import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { SignUpForm } from "@/components/auth-forms";
import { currencyOptions, timeZoneOptions } from "@/lib/reference-data";
import { previewInvitation } from "@/modules/members/service";
import { getCurrentUser } from "@/server/auth/session";
import { signUpLabels } from "@/server/auth/signup-labels";
import { signUpAction } from "../actions";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("auth"))("signUpTitle") };
}

export default async function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  if (await getCurrentUser()) redirect("/");
  const { invite } = await searchParams;
  const token = typeof invite === "string" ? invite : undefined;
  const invitation = token ? await previewInvitation(token) : null;
  const joining = invitation?.valid && token ? { token, email: invitation.email } : undefined;
  const t = await getTranslations("auth");
  return (
    <div className="border-border bg-surface rounded-lg border p-6">
      <h1 className="text-xl font-semibold">{joining ? t("joinTitle") : t("signUpTitle")}</h1>
      <p className="text-muted mt-1 mb-6 text-sm">
        {joining ? t("joinSubtitle") : t("signUpSubtitle")}
      </p>
      <SignUpForm
        action={signUpAction}
        labels={await signUpLabels(joining ? "createAccount" : "signUp")}
        currencies={currencyOptions(await getLocale())}
        timeZones={timeZoneOptions()}
        invite={joining}
      />
      <p className="text-muted mt-6 text-sm">
        {t("haveAccount")}{" "}
        <Link
          href="/sign-in"
          className="text-primary font-medium underline-offset-2 hover:underline"
        >
          {t("signIn")}
        </Link>
      </p>
    </div>
  );
}
