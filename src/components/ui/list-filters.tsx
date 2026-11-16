import { getTranslations } from "next-intl/server";
import { buttonClass, inputClass } from "./styles";

interface ExtraSelect {
  name: string;
  label: string;
  value?: string;
  options: Array<{ value: string; label: string }>;
}

/** GET form for search + status (+ optional extra selects) on list pages. */
export async function ListFilters({
  q,
  status,
  extra,
}: {
  q?: string;
  status: string;
  extra?: ExtraSelect | Array<ExtraSelect | undefined>;
}) {
  const t = await getTranslations("common");
  const extras = (Array.isArray(extra) ? extra : [extra]).filter(
    (e): e is ExtraSelect => e !== undefined,
  );
  return (
    <form method="get" className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end" role="search">
      <div className="flex-1">
        <label htmlFor="q" className="sr-only">
          {t("search")}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder={t("searchPlaceholder")}
          className={inputClass}
        />
      </div>
      {extras.map((extra) => (
        <div key={extra.name}>
          <label htmlFor={extra.name} className="sr-only">
            {extra.label}
          </label>
          <select
            id={extra.name}
            name={extra.name}
            defaultValue={extra.value ?? ""}
            className={inputClass}
          >
            <option value="">{extra.label}</option>
            {extra.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div>
        <label htmlFor="status" className="sr-only">
          {t("status")}
        </label>
        <select id="status" name="status" defaultValue={status} className={inputClass}>
          <option value="active">{t("active")}</option>
          <option value="archived">{t("archived")}</option>
          <option value="all">{t("all")}</option>
        </select>
      </div>
      <button type="submit" className={buttonClass("secondary")}>
        {t("apply")}
      </button>
    </form>
  );
}
