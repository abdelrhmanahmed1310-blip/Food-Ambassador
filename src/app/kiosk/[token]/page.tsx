import { notFound } from "next/navigation";
import { GuestOrdering } from "@/components/pos/guest-ordering";
import { publicMenu } from "@/modules/pos/ordering";
import { placeGuestOrderAction } from "../../order/actions";

export const dynamic = "force-dynamic";

/** A self-order kiosk in the restaurant (ADR-070); no sign-in. */
export default async function KioskPage({ params }: PageProps<"/kiosk/[token]">) {
  const { token } = await params;
  const menu = await publicMenu(token);
  if (!menu || menu.kind !== "KIOSK") notFound();
  return (
    <main className="w-full space-y-4 p-4">
      <header>
        <h1 className="text-3xl font-semibold">{menu.organizationName}</h1>
      </header>
      <GuestOrdering menu={menu} mode="KIOSK" place={placeGuestOrderAction.bind(null, token)} />
    </main>
  );
}
