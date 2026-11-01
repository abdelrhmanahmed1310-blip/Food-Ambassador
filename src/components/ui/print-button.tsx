"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { buttonClass } from "./styles";

/** The store apps add this to their user agent (ADR-061). */
const STORE_APP = /\bFoodAmbassadorApp\/\d+/;
const noSubscribe = () => () => undefined;

/**
 * Prints the page with the browser's print dialog. The in-app web views of
 * the App Store / Google Play apps have no print dialog, so there the button
 * says where to print instead of doing nothing.
 */
export function PrintButton({ label }: { label: string }) {
  const t = useTranslations("common");
  const storeApp = useSyncExternalStore(
    noSubscribe,
    () => STORE_APP.test(navigator.userAgent),
    () => false,
  );
  if (storeApp)
    return (
      <p className="text-muted text-sm print:hidden" data-testid="print-unavailable">
        {t("printInBrowser")}
      </p>
    );
  return (
    <button
      type="button"
      className={`${buttonClass("secondary")} print:hidden`}
      onClick={() => window.print()}
    >
      {label}
    </button>
  );
}
