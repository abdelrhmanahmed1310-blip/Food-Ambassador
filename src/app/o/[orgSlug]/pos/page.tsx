import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RegisterForm } from "@/components/pos/forms";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { listRegisters, registerFormOptions } from "@/modules/pos/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createRegisterAction } from "./actions";

export default async function PosPage({ params }: PageProps<"/o/[orgSlug]/pos">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const manage = hasPermission(ctx.grants, "pos.manage");
  if (!manage && !holdsAnyGrant(ctx.grants, "pos.sell") && !holdsAnyGrant(ctx.grants, "pos.view"))
    notFound();
  const [t, registers, branches] = await Promise.all([
    getTranslations(),
    listRegisters(ctx),
    manage ? registerFormOptions(ctx) : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader
        title={t("pos.title")}
        description={t("pos.intro")}
        actions={
          holdsAnyGrant(ctx.grants, "inventory.adjust") ? (
            <LinkButton href={`/o/${orgSlug}/pos/shortfalls`} variant="secondary">
              {t("pos.shortfalls")}
            </LinkButton>
          ) : null
        }
      />
      <div className="space-y-6">
        {registers.length === 0 ? (
          <EmptyState
            title={t("pos.noRegisters")}
            hint={manage ? t("pos.noRegistersHint") : undefined}
          />
        ) : (
          <Table label={t("pos.registers")}>
            <thead>
              <tr>
                <Th>{t("pos.code")}</Th>
                <Th>{t("pos.name")}</Th>
                <Th>{t("pos.branch")}</Th>
                <Th>{t("pos.stockWarehouse")}</Th>
                <Th>{t("pos.shift")}</Th>
              </tr>
            </thead>
            <tbody>
              {registers.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/pos/registers/${r.id}`}
                      className="text-primary ltr-value font-mono hover:underline"
                    >
                      {r.code}
                    </Link>
                  </Td>
                  <Td>{r.name}</Td>
                  <Td>{r.branch.name}</Td>
                  <Td>{r.warehouse.name}</Td>
                  <Td>
                    {r.shifts[0] ? (
                      <Badge tone="success">
                        {t("pos.shiftOpen", { number: r.shifts[0].number })}
                      </Badge>
                    ) : (
                      <Badge tone="muted">{t("pos.noShift")}</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {manage ? (
          <Card title={t("pos.addRegister")}>
            {branches.length === 0 ? (
              <p className="text-muted text-sm">{t("pos.needBranch")}</p>
            ) : (
              <RegisterForm
                action={createRegisterAction.bind(null, orgSlug)}
                branches={branches.map((b) => ({
                  id: b.id,
                  label: `${b.code} — ${b.name}`,
                  warehouses: b.warehouses.map((w) => ({
                    value: w.id,
                    label: `${w.code} — ${w.name}`,
                  })),
                }))}
              />
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
