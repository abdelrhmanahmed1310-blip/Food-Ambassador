import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LinkButton } from "@/components/ui/primitives";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { listUserOrganizations } from "@/modules/organizations/service";
import { getCurrentUser } from "@/server/auth/session";

export default async function Home() {
  const user = await getCurrentUser();
  if (user) {
    const orgs = await listUserOrganizations(user.id);
    redirect(orgs[0] ? `/o/${orgs[0].slug}` : "/organizations/new");
  }
  const t = await getTranslations();
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <span className="font-semibold">{t("common.appName")}</span>
        <LocaleSwitcher />
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-4 py-16">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("home.tagline")}</h1>
        <p className="text-muted max-w-2xl text-base">{t("home.description")}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          <LinkButton href="/sign-up">{t("home.getStarted")}</LinkButton>
          <LinkButton href="/sign-in" variant="secondary">
            {t("home.signIn")}
          </LinkButton>
        </div>
      </main>
    </div>
  );
}
