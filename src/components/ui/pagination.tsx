import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonClass } from "./styles";

/** Server-rendered pagination that preserves the current query parameters. */
export async function Pagination({
  basePath,
  params,
  page,
  pageCount,
  total,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  pageCount: number;
  total: number;
}) {
  const t = await getTranslations("common");
  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  return (
    <nav
      className="text-muted mt-4 flex flex-wrap items-center justify-between gap-2 text-sm"
      aria-label="Pagination"
    >
      <span>{t("total", { count: total })}</span>
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link className={buttonClass("secondary")} href={href(page - 1)}>
              {t("previous")}
            </Link>
          ) : null}
          <span>{t("pageOf", { page, pageCount })}</span>
          {page < pageCount ? (
            <Link className={buttonClass("secondary")} href={href(page + 1)}>
              {t("next")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
