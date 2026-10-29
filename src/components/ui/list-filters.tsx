import { getTranslations } from "next-intl/server";
import { buttonClass, inputClass } from "./styles";

/** GET form for search + status (+ optional extra select) on list pages. */
export async function ListFilters({
  q,
  status,
  extra,
}: {
  q?: string;
  status: string;
  extra?: {
    name: string;
    label: string;
    value?: string;
    options: Array<{ value: string; label: string }>;
  };
}) {
  const t = await getTranslations("common");
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
      {extra ? (
        <div>
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
      ) : null}
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
