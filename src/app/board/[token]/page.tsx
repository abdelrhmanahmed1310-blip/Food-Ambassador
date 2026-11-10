import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/pos/auto-refresh";
import { Decimal } from "@/lib/decimal";
import { publicMenu } from "@/modules/pos/ordering";

export const dynamic = "force-dynamic";

/**
 * A menu board for a screen in the restaurant (ADR-133): plug a TV or tablet
 * in, open this address full screen, and it shows the branch's menu — photos,
 * names in English and Arabic, prices — refreshing itself every minute.
 * It takes no orders and needs no sign-in.
 */
export default async function MenuBoardPage({ params }: PageProps<"/board/[token]">) {
  const { token } = await params;
  const menu = await publicMenu(token);
  if (!menu || menu.kind !== "BOARD") notFound();
  const money = new Intl.NumberFormat("en-u-nu-latn", {
    style: "currency",
    currency: menu.currency,
  });
  const fmt = (v: string) => money.format(new Decimal(v).toString() as unknown as number);
  // One list: the first sales channel the board shows (eat in, take away…).
  const items = menu.channels[0]?.items ?? [];
  const categories = [...new Map(items.map((i) => [i.category.id, i.category])).values()];
  return (
    <main className="bg-surface min-h-screen w-full p-6" data-testid="menu-board">
      <AutoRefresh seconds={60} />
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-4xl font-bold">{menu.organizationName}</h1>
        <p className="text-muted text-xl">{menu.branchName}</p>
      </header>
      {items.length === 0 ? (
        <p className="text-muted text-2xl">—</p>
      ) : (
        <div className="space-y-8">
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
                {items
                  .filter((i) => i.category.id === c.id)
                  .map((i) => (
                    <li
                      key={i.id}
                      className="border-border bg-background overflow-hidden rounded-2xl border shadow-sm"
                      data-testid="board-item"
                    >
                      {i.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- photos come from /media with long-lived caching
                        <img src={i.imageUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                      ) : null}
                      <div className="space-y-1 p-4">
                        <p className="text-2xl font-semibold">{i.name}</p>
                        {i.nameAr ? (
                          <p dir="rtl" lang="ar" className="text-muted text-xl">
                            {i.nameAr}
                          </p>
                        ) : null}
                        <p className="ltr-value text-primary text-2xl font-bold tabular-nums">
                          {fmt(i.price)}
                        </p>
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
