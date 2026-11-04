import { getTranslations } from "next-intl/server";
import { ScanInput } from "@/components/scan/scan-input";
import { buttonClass } from "@/components/ui/styles";

/** A plain GET form around the scan field: a scan reloads the page with ?code=. */
export async function ScanGetForm({ label, hint }: { label: string; hint?: string }) {
  const t = await getTranslations("scan");
  return (
    <form method="get" className="space-y-2">
      <ScanInput name="code" label={label} hint={hint} />
      <button type="submit" className={buttonClass("primary")}>
        {t("check")}
      </button>
    </form>
  );
}
