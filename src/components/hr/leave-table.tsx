import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Badge, Table, Td, Th } from "@/components/ui/primitives";
import type { ActionState } from "@/components/forms/action-state";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
const TONE = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "muted",
} as const;
const day = (d: Date) => d.toISOString().slice(0, 10);

export interface LeaveRow {
  id: string;
  status: keyof typeof TONE;
  startDate: Date;
  endDate: Date;
  days: { toString(): string };
  reason: string | null;
  decisionNote: string | null;
  employee: { firstName: string; lastName: string; number: string };
  leaveType: { name: string; paid: boolean };
}

/** Leave requests with the actions the viewer may take on each (ADR-081). */
export async function LeaveTable({
  rows,
  showEmployee,
  actions,
}: {
  rows: LeaveRow[];
  showEmployee: boolean;
  actions: (r: LeaveRow) => { approve?: Action; reject?: Action; cancel?: Action };
}) {
  const t = await getTranslations("leave");
  return (
    <Table label={t("requests")}>
      <thead>
        <tr>
          {showEmployee ? <Th>{t("employee")}</Th> : null}
          <Th>{t("type")}</Th>
          <Th>{t("dates")}</Th>
          <Th>{t("days")}</Th>
          <Th>{t("status")}</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const a = actions(r);
          return (
            <tr key={r.id} data-testid="leave-row">
              {showEmployee ? (
                <Td>
                  {r.employee.firstName} {r.employee.lastName}
                  <span className="ltr-value text-muted block font-mono text-xs">
                    {r.employee.number}
                  </span>
                </Td>
              ) : null}
              <Td>
                {r.leaveType.name}
                {r.reason ? <span className="text-muted block text-xs">{r.reason}</span> : null}
              </Td>
              <Td className="ltr-value">
                {day(r.startDate)} → {day(r.endDate)}
              </Td>
              <Td className="tabular-nums">{Number(r.days.toString())}</Td>
              <Td>
                <Badge tone={TONE[r.status]}>{t(`statuses.${r.status}`)}</Badge>
                {r.decisionNote ? (
                  <span className="text-muted block text-xs">{r.decisionNote}</span>
                ) : null}
              </Td>
              <Td>
                <span className="flex flex-wrap gap-2">
                  {a.approve ? (
                    <ConfirmActionButton
                      action={a.approve}
                      label={t("approve")}
                      variant="primary"
                    />
                  ) : null}
                  {a.reject ? (
                    <ConfirmActionButton
                      action={a.reject}
                      label={t("reject")}
                      confirmMessage={t("rejectConfirm")}
                    />
                  ) : null}
                  {a.cancel ? (
                    <ConfirmActionButton
                      action={a.cancel}
                      label={t("cancel")}
                      confirmMessage={t("cancelConfirm")}
                    />
                  ) : null}
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
