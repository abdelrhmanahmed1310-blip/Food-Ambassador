import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/brand/logo";
import { ClockPad } from "@/components/hr/attendance-forms";
import { terminalInfo } from "@/modules/hr/attendance";
import { clockAction } from "../actions";

export const dynamic = "force-dynamic";

/** A branch clock-in tablet (ADR-080); opened with its secret link, no sign-in. */
export default async function ClockPage({ params }: PageProps<"/clock/[token]">) {
  const { token } = await params;
  const terminal = await terminalInfo(token);
  if (!terminal) notFound();
  const t = await getTranslations("attendance");
  return (
    <main className="flex min-h-dvh flex-col items-center gap-8 p-6">
      <Logo className="h-28 w-auto" />
      <header className="text-center">
        <h1 className="text-3xl font-bold">{t("clockTitle")}</h1>
        <p className="text-muted mt-1">
          {terminal.organization.name} · {terminal.branch.name} · {terminal.name}
        </p>
      </header>
      <ClockPad action={clockAction.bind(null, token)} />
    </main>
  );
}
