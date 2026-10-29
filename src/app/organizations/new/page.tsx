import { getLocale, getTranslations } from "next-intl/server";
import { NewOrganizationForm } from "@/components/auth-forms";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { currencyOptions, timeZoneOptions } from "@/lib/reference-data";
import { listUserOrganizations } from "@/modules/organizations/service";
import { requireUser } from "@/server/auth/session";
import { signUpLabels } from "@/server/auth/signup-labels";
import { createOrganizationAction, signOutAction } from "../../(auth)/actions";

export default async function NewOrganizationPage() {
  const user = await requireUser("/organizations/new");
  const t = await getTranslations();
  const orgs = await listUserOrganizations(user.id);
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <span className="font-semibold">{t("common.appName")}</span>
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          <form action={signOutAction}>
            <button
              type="submit"
              className="hover:bg-surface-muted rounded-md px-2.5 py-1.5 text-sm"
            >
              {t("nav.signOut")}
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-8">
        <div className="border-border bg-surface rounded-lg border p-6">
          <h1 className="text-xl font-semibold">{t("organizations.newTitle")}</h1>
          <p className="text-muted mt-1 mb-6 text-sm">
            {orgs.length === 0 ? t("organizations.none") : t("organizations.newSubtitle")}
          </p>
          <NewOrganizationForm
            action={createOrganizationAction}
            labels={await signUpLabels("create")}
            currencies={currencyOptions(await getLocale())}
            timeZones={timeZoneOptions()}
          />
        </div>
      </main>
    </div>
  );
}
