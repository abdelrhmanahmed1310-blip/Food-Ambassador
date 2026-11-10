"use client";

import { useEffect, useMemo, useState } from "react";
import { Decimal } from "@/lib/decimal";
import { paginate } from "@/modules/pos/board-rules";

export interface BoardItem {
  id: string;
  name: string;
  nameAr: string | null;
  price: string;
  photos: string[];
  category: { id: string; name: string; nameAr: string | null };
}

/** Items per page when the board pages: about two rows on a TV. */
const PAGE_SIZE = 8;

/**
 * What a menu board screen shows (ADR-133): the menu by category, in pages
 * that turn every `pageSeconds` (0 = one page), each item's photos in turn.
 */
export function MenuBoard({
  items,
  currency,
  pageSeconds,
}: {
  items: BoardItem[];
  currency: string;
  pageSeconds: number;
}) {
  const pages = useMemo(
    () => paginate(items, pageSeconds > 0 ? PAGE_SIZE : 0),
    [items, pageSeconds],
  );
  const [tick, setTick] = useState(0);
  // Photos change every 6 s on a single page, else with each page turn.
  const interval = (pageSeconds > 0 ? pageSeconds : 6) * 1000;
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
  const money = useMemo(
    () => new Intl.NumberFormat("en-u-nu-latn", { style: "currency", currency }),
    [currency],
  );
  const page = pages[tick % pages.length] ?? [];
  const categories = [...new Map(page.map((i) => [i.category.id, i.category])).values()];
  return (
    <div className="space-y-8" data-testid="board-page">
      {pages.length > 1 ? (
        <p className="text-muted text-lg tabular-nums" aria-hidden="true">
          {(tick % pages.length) + 1} / {pages.length}
        </p>
      ) : null}
      {categories.map((c) => (
        <section key={c.id}>
          <h2 className="mb-3 flex flex-wrap items-baseline gap-3 text-3xl font-semibold">
            <span>{c.name}</span>
            {c.nameAr ? (
              <span dir="rtl" lang="ar" className="text-muted">
                {c.nameAr}
              </span>
            ) : null}
          </h2>
          <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
            {page
              .filter((i) => i.category.id === c.id)
              .map((i) => {
                const photo = i.photos.length > 0 ? i.photos[tick % i.photos.length] : null;
                return (
                  <li
                    key={i.id}
                    className="border-border bg-surface overflow-hidden rounded-2xl border shadow-sm"
                    data-testid="board-item"
                  >
                    {photo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- photos come from /media with long-lived caching
                      <img src={photo} alt="" className="aspect-[4/3] w-full object-cover" />
                    ) : null}
                    <div className="space-y-1 p-4">
                      <p className="text-2xl font-semibold">{i.name}</p>
                      {i.nameAr ? (
                        <p dir="rtl" lang="ar" className="text-muted text-xl">
                          {i.nameAr}
                        </p>
                      ) : null}
                      <p className="ltr-value text-primary text-2xl font-bold tabular-nums">
                        {money.format(new Decimal(i.price).toString() as unknown as number)}
                      </p>
                    </div>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
