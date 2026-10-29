"use client";

import { useTranslations } from "next-intl";
import { buttonClass } from "@/components/ui/styles";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorPage");
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-muted">{t("body")}</p>
      {error.digest ? (
        <p className="ltr-value text-muted text-xs">{t("reference", { digest: error.digest })}</p>
      ) : null}
      <button type="button" className={buttonClass("secondary")} onClick={reset}>
        {t("retry")}
      </button>
    </main>
  );
}
