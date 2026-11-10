import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/pos/auto-refresh";
import { MenuBoard } from "@/components/pos/menu-board";
import { clockIn, inWindow } from "@/modules/pos/board-rules";
import { publicMenu } from "@/modules/pos/ordering";

export const dynamic = "force-dynamic";

/**
 * A menu board for a screen in the restaurant (ADR-133): plug a TV or tablet
 * in, open this address full screen, and it shows the branch's menu — photos,
 * names in English and Arabic, prices — in its own light or dark theme, in
 * pages if set, with categories shown only in their hours (breakfast in the
 * morning). It re-reads the menu every minute, takes no orders and needs no
 * sign-in.
 */
export default async function MenuBoardPage({ params }: PageProps<"/board/[token]">) {
  const { token } = await params;
  const menu = await publicMenu(token);
  if (!menu || menu.kind !== "BOARD") notFound();
  const now = clockIn(menu.timeZone);
  // One list: the first sales channel the board shows (eat in, take away…).
  const items = (menu.channels[0]?.items ?? []).filter((i) =>
    inWindow(now, i.category.boardFrom, i.category.boardTo),
  );
  return (
    <main
      className={`${menu.boardTheme === "DARK" ? "board-dark" : "board-light"} bg-background text-foreground min-h-screen w-full p-6`}
      data-testid="menu-board"
      data-theme={menu.boardTheme}
    >
      <AutoRefresh seconds={60} />
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-4xl font-bold">{menu.organizationName}</h1>
        <p className="text-muted text-xl">{menu.branchName}</p>
      </header>
      {items.length === 0 ? (
        <p className="text-muted text-2xl">—</p>
      ) : (
        <MenuBoard
          items={items.map((i) => ({
            id: i.id,
            name: i.name,
            nameAr: i.nameAr,
            price: i.price,
            photos: i.photos,
            category: { id: i.category.id, name: i.category.name, nameAr: i.category.nameAr },
          }))}
          currency={menu.currency}
          pageSeconds={menu.boardPageSeconds}
        />
      )}
    </main>
  );
}
