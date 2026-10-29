import "server-only";
import { getTranslations } from "next-intl/server";
import type { RowError } from "@/modules/inventory/csv";

/** Row errors carry message keys from validation.*, rules.* or errors.*. */
export async function translateRowErrors(errors: RowError[]) {
  const t = await getTranslations();
  return errors.slice(0, 200).map((e) => {
    const key = [`validation.${e.message}`, `rules.${e.message}`, `errors.${e.message}`].find((k) =>
      t.has(k),
    );
    let message = e.message;
    if (key) {
      try {
        message = t(key, { min: 10, available: "?", requested: "?" });
      } catch {
        message = e.message;
      }
    }
    return { row: e.row, column: e.column, message };
  });
}
