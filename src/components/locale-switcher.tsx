import { getLocale, getTranslations } from "next-intl/server";
import { LOCALES } from "@/i18n/config";
import { setLocaleAction } from "@/server/actions/locale";

/** Server-rendered language switch: one submit button per other language. */
export async function LocaleSwitcher() {
  const locale = await getLocale();
  const t = await getTranslations("locale");
  return (
    <form action={setLocaleAction} className="inline-flex" aria-label={t("label")}>
      {LOCALES.filter((l) => l !== locale).map((l) => (
        <button
          key={l}
          type="submit"
          name="locale"
          value={l}
          lang={l}
          className="text-foreground hover:bg-surface-muted rounded-md px-2.5 py-1.5 text-sm"
        >
          {t(l)}
        </button>
      ))}
    </form>
  );
}
