import { notFound } from "next/navigation";
import { GuestOrdering } from "@/components/pos/guest-ordering";
import { publicMenu } from "@/modules/pos/ordering";
import { placeGuestOrderAction } from "../actions";

export const dynamic = "force-dynamic";

/** The public online ordering page of a branch (ADR-070); no sign-in. */
export default async function OrderPage({ params }: PageProps<"/order/[token]">) {
  const { token } = await params;
  const menu = await publicMenu(token);
  if (!menu || menu.kind !== "WEB") notFound();
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 p-4">
      <header>
        <h1 className="text-2xl font-semibold">{menu.organizationName}</h1>
        <p className="text-muted">{menu.branchName}</p>
      </header>
      <GuestOrdering menu={menu} mode="WEB" place={placeGuestOrderAction.bind(null, token)} />
    </main>
  );
}
