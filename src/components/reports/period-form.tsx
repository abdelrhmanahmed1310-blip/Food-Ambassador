import { getTranslations } from "next-intl/server";

/** GET form choosing a period (and optional extra hidden or select fields). */
export async function PeriodForm({
  from,
  to,
  children,
}: {
  from: string;
  to: string;
  children?: React.ReactNode;
}) {
  const t = await getTranslations();
  const input = (name: string, label: string, value: string) => (
    <label className="text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        type="date"
        name={name}
        defaultValue={value}
        className="border-border bg-surface rounded-md border px-3 py-2"
      />
    </label>
  );
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 print:hidden">
      {input("from", t("tax.from"), from)}
      {input("to", t("tax.to"), to)}
      {children}
      <button
        type="submit"
        className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
      >
        {t("common.apply")}
      </button>
    </form>
  );
}
