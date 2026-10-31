import { getTranslations } from "next-intl/server";
import { Badge, Card } from "@/components/ui/primitives";

export interface ApprovalStepView {
  step: number;
  level: "BRANCH" | "HEAD_OFFICE" | "ANY";
  signedBy: string | null;
  signedAt: Date | null;
  current: boolean;
}

/** The approval chain of a document with who signed each step (ADR-049). */
export async function ApprovalSteps({
  steps,
  formatTime,
}: {
  steps: ApprovalStepView[];
  formatTime: (d: Date) => string;
}) {
  if (steps.length === 0) return null;
  const t = await getTranslations("approvals");
  return (
    <Card title={t("steps")}>
      <ol className="space-y-2 text-sm" data-testid="approval-steps">
        {steps.map((s) => (
          <li key={s.step} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t("step", { step: s.step, of: steps.length })}</span>
            <Badge tone="neutral">{t(`levels.${s.level}`)}</Badge>
            {s.signedAt ? (
              <span>
                <bdi>{s.signedBy ?? "—"}</bdi> · <bdi>{formatTime(s.signedAt)}</bdi>
              </span>
            ) : s.current ? (
              <Badge tone="warning">{t("waiting")}</Badge>
            ) : (
              <span className="text-muted">—</span>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
