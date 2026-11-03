import { getTranslations } from "next-intl/server";
import { inputClass } from "@/components/ui/styles";

/** Company choice inside a report's period form; empty = the whole group (ADR-086). */
export async function CompanySelect({
  companies,
  value,
}: {
  companies: Array<{ id: string; code: string; name: string }>;
  value: string;
}) {
  if (companies.length < 2) return null;
  const t = await getTranslations("dashboard");
  return (
    <label className="text-sm">
      <span className="mb-1 block font-medium">{t("company")}</span>
      <select name="company" defaultValue={value} className={`${inputClass} w-auto`}>
        <option value="">{t("wholeGroup")}</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} — {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
