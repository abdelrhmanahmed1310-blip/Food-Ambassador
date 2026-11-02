import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/brand/logo";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ClearOfflinePages } from "@/components/pos/offline-support";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("common");
  return (
    <div className="flex flex-1 flex-col">
      <ClearOfflinePages />
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <Link href="/" aria-label={t("appName")}>
          <Logo className="h-9 w-auto" />
        </Link>
        <LocaleSwitcher />
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
