import { getTranslations } from "next-intl/server";
import { LinkButton } from "@/components/ui/primitives";

export default async function NotFound() {
  const t = await getTranslations("notFound");
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <p className="text-muted text-sm font-medium">404</p>
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-muted">{t("body")}</p>
      <LinkButton href="/" variant="secondary">
        {t("home")}
      </LinkButton>
    </main>
  );
}
