import { getFormatter, getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import {
  RevealAccountButton,
  SupplierBankAccountForm,
  SupplierDocumentForm,
} from "@/components/procurement/compliance-forms";
import { ReasonForm } from "@/components/procurement/forms";
import { Badge, Card, EmptyState, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import type { supplierCompliance } from "@/modules/procurement/compliance";
import type { TenantContext } from "@/modules/tenancy/context";
import {
  addSupplierBankAccountAction,
  addSupplierDocumentAction,
  approveSupplierAction,
  archiveSupplierBankAccountAction,
  archiveSupplierDocumentAction,
  blockSupplierAction,
  revealSupplierBankAccountAction,
  unblockSupplierAction,
  updateSupplierDocumentAction,
  verifySupplierBankAccountAction,
} from "../actions";

type Compliance = Awaited<ReturnType<typeof supplierCompliance>>;

const STATUS_TONE = {
  PENDING_APPROVAL: "warning",
  APPROVED: "success",
  BLOCKED: "danger",
} as const;
const DOC_TONE = {
  EXPIRED: "danger",
  EXPIRING: "warning",
  VALID: "success",
  NO_EXPIRY: "muted",
} as const;

/** Approval, blocking, documents and bank accounts on the supplier page (ADR-091). */
export async function ComplianceSection({
  ctx,
  orgSlug,
  supplierId,
  compliance: c,
  currencies,
  archived,
}: {
  ctx: TenantContext;
  orgSlug: string;
  supplierId: string;
  compliance: Compliance;
  currencies: Array<{ value: string; label: string }>;
  archived: boolean;
}) {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const canApprove = hasPermission(ctx.grants, "suppliers.approve");
  const canManage = hasPermission(ctx.grants, "suppliers.manage");
  const canBank = hasPermission(ctx.grants, "suppliers.bank.manage");
  const date = (d: string | null) =>
    d ? format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }) : "—";
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeZone: ctx.timeZone });
  const tc = (key: string, values?: Record<string, string | number>) =>
    t(`suppliers.compliance.${key}`, values);

  return (
    <>
      <Card title={tc("title")}>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={STATUS_TONE[c.status]}>{tc(`status.${c.status}`)}</Badge>
          {c.expiredRequired > 0 ? (
            <Badge tone="danger">{tc("expiredRequired", { count: c.expiredRequired })}</Badge>
          ) : null}
        </div>
        <p className="text-muted mt-2 text-sm">
          {c.status === "PENDING_APPROVAL"
            ? tc("pendingHint")
            : c.status === "BLOCKED"
              ? tc("blockedBy", {
                  name: c.blockedBy ?? "—",
                  date: c.blockedAt ? when(c.blockedAt) : "—",
                  reason: c.blockedReason ?? "",
                })
              : c.approvedAt
                ? tc("approvedBy", { name: c.approvedBy ?? "—", date: when(c.approvedAt) })
                : tc("approvedHint")}
        </p>
        {canApprove && !archived ? (
          <div className="mt-4 flex flex-wrap items-start gap-4">
            {c.status === "PENDING_APPROVAL" ? (
              c.createdByUserId === ctx.userId ? (
                <p className="text-muted text-xs">{tc("ownSupplier")}</p>
              ) : (
                <ConfirmActionButton
                  action={approveSupplierAction.bind(null, orgSlug, supplierId)}
                  label={tc("approve")}
                  variant="primary"
                />
              )
            ) : null}
            {c.status === "BLOCKED" ? (
              <ConfirmActionButton
                action={unblockSupplierAction.bind(null, orgSlug, supplierId)}
                label={tc("unblock")}
                variant="secondary"
                confirmMessage={tc("unblockConfirm")}
              />
            ) : (
              <div className="w-full max-w-md">
                <ReasonForm
                  action={blockSupplierAction.bind(null, orgSlug, supplierId)}
                  label={tc("blockReason")}
                  submitLabel={tc("block")}
                  variant="danger"
                />
              </div>
            )}
          </div>
        ) : null}
      </Card>

      <Card title={tc("documentsTitle")}>
        <p className="text-muted mb-3 text-xs">{tc("documentsHint")}</p>
        {c.documents.length === 0 ? (
          <EmptyState title={tc("noDocuments")} />
        ) : (
          <Table label={tc("documentsTitle")}>
            <thead>
              <tr>
                <Th>{tc("documentType")}</Th>
                <Th>{tc("documentNumber")}</Th>
                <Th>{tc("issuedOn")}</Th>
                <Th>{tc("expiresOn")}</Th>
                <Th>{tc("documentState")}</Th>
                <Th>{t("common.actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {c.documents.map((d) => (
                <tr key={d.id}>
                  <Td>
                    {tc(`documentTypes.${d.type}`)}
                    {d.title ? <span className="text-muted block text-xs">{d.title}</span> : null}
                    {d.requiredToBuy ? (
                      <span className="mt-1 block">
                        <Badge tone="neutral">{tc("requiredBadge")}</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{d.number ?? "—"}</span>
                  </Td>
                  <Td className="whitespace-nowrap">{date(d.issuedOn)}</Td>
                  <Td className="whitespace-nowrap">{date(d.expiresOn)}</Td>
                  <Td>
                    <Badge tone={DOC_TONE[d.state]}>{tc(`documentStates.${d.state}`)}</Badge>
                  </Td>
                  <Td>
                    <details>
                      <summary className="text-primary cursor-pointer text-sm">
                        {canManage ? tc("renew") : tc("files")}
                      </summary>
                      <div className="mt-2 min-w-72 space-y-3">
                        <AttachmentsCard
                          ctx={ctx}
                          orgSlug={orgSlug}
                          entityType="SUPPLIER_DOCUMENT"
                          entityId={d.id}
                        />
                        {canManage ? (
                          <SupplierDocumentForm
                            action={updateSupplierDocumentAction.bind(
                              null,
                              orgSlug,
                              supplierId,
                              d.id,
                            )}
                            submitLabel={t("common.save")}
                            defaults={{
                              type: d.type,
                              title: d.title ?? undefined,
                              number: d.number ?? undefined,
                              issuedOn: d.issuedOn ?? undefined,
                              expiresOn: d.expiresOn ?? undefined,
                              note: d.note ?? undefined,
                              requiredToBuy: d.requiredToBuy,
                            }}
                          />
                        ) : null}
                      </div>
                    </details>
                    {canManage ? (
                      <div className="mt-2">
                        <ConfirmActionButton
                          action={archiveSupplierDocumentAction.bind(
                            null,
                            orgSlug,
                            supplierId,
                            d.id,
                          )}
                          label={t("common.remove")}
                          variant="secondary"
                          confirmMessage={tc("removeDocumentConfirm")}
                        />
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {canManage ? (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-semibold">{tc("addDocument")}</h3>
            <SupplierDocumentForm
              action={addSupplierDocumentAction.bind(null, orgSlug, supplierId)}
              submitLabel={tc("addDocument")}
            />
            <p className="text-muted mt-2 text-xs">{tc("attachHint")}</p>
          </div>
        ) : null}
      </Card>

      {c.bankAccounts.length > 0 || canBank ? (
        <Card title={tc("bankTitle")}>
          <p className="text-muted mb-3 text-xs">{tc("bankHint")}</p>
          {c.bankAccounts.length === 0 ? (
            <EmptyState title={tc("noBankAccounts")} />
          ) : (
            <Table label={tc("bankTitle")}>
              <thead>
                <tr>
                  <Th>{tc("bankName")}</Th>
                  <Th>{tc("accountName")}</Th>
                  <Th>{tc("account")}</Th>
                  <Th>{tc("verification")}</Th>
                  <Th>{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody>
                {c.bankAccounts.map((a) => (
                  <tr key={a.id}>
                    <Td>
                      {a.bankName}
                      {a.swiftBic ? (
                        <span className="ltr-value text-muted block font-mono text-xs">
                          {a.swiftBic}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {a.accountName}
                      {a.currency ? (
                        <span className="text-muted block text-xs">{a.currency}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="ltr-value font-mono text-sm" dir="ltr">
                        {a.masked}
                      </span>
                      <span className="text-muted block text-xs">
                        {tc(`accountKinds.${a.kind}`)}
                      </span>
                    </Td>
                    <Td>
                      {a.verifiedAt ? (
                        <>
                          <Badge tone="success">{tc("verified")}</Badge>
                          <span className="text-muted block text-xs">
                            {tc("verifiedBy", {
                              name: a.verifiedBy ?? "—",
                              date: when(a.verifiedAt),
                            })}
                          </span>
                        </>
                      ) : (
                        <>
                          <Badge tone="warning">{tc("notVerified")}</Badge>
                          <span className="text-muted block text-xs">
                            {tc("addedBy", { name: a.createdBy ?? "—", date: when(a.createdAt) })}
                          </span>
                        </>
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-col items-start gap-2">
                        {c.canReveal ? (
                          <RevealAccountButton
                            action={revealSupplierBankAccountAction.bind(
                              null,
                              orgSlug,
                              supplierId,
                              a.id,
                            )}
                          />
                        ) : null}
                        {canApprove && !a.verifiedAt && a.createdByUserId !== ctx.userId ? (
                          <ConfirmActionButton
                            action={verifySupplierBankAccountAction.bind(
                              null,
                              orgSlug,
                              supplierId,
                              a.id,
                            )}
                            label={tc("verify")}
                            variant="primary"
                            confirmMessage={tc("verifyConfirm")}
                          />
                        ) : null}
                        {canBank ? (
                          <ConfirmActionButton
                            action={archiveSupplierBankAccountAction.bind(
                              null,
                              orgSlug,
                              supplierId,
                              a.id,
                            )}
                            label={t("common.remove")}
                            variant="secondary"
                            confirmMessage={tc("removeBankConfirm")}
                          />
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {canBank && !archived ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold">{tc("addBankAccount")}</h3>
              <SupplierBankAccountForm
                action={addSupplierBankAccountAction.bind(null, orgSlug, supplierId)}
                currencies={currencies}
              />
            </div>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
