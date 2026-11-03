import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  Badge,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listFsDocuments } from "@/modules/foodsafety/documents";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function DocumentsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/food-safety/documents">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const withdrawn = sp.withdrawn === "1";
  const unread = sp.unread === "1";
  const [t, format, all] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listFsDocuments(ctx, { withdrawn }),
  ]);
  const docs = unread ? all.filter((d) => d.current && !d.current.readByMe) : all;
  const base = `/o/${orgSlug}/food-safety/documents`;
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border hover:bg-surface-muted"
    }`;
  const day = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" }) : "—";
  return (
    <>
      <PageHeader
        title={t("fsDocs.title")}
        description={t("fsDocs.hint")}
        actions={
          holdsAnyGrant(ctx.grants, "foodsafety.manage") ? (
            <LinkButton href={`${base}/new`}>{t("fsDocs.new")}</LinkButton>
          ) : null
        }
      />
      <nav aria-label={t("common.status")} className="mb-4 flex flex-wrap gap-2">
        <Link
          href={base}
          className={chip(!withdrawn && !unread)}
          aria-current={!withdrawn && !unread ? "page" : undefined}
        >
          {t("fsDocs.inUse")}
        </Link>
        <Link
          href={`${base}?unread=1`}
          className={chip(unread)}
          aria-current={unread ? "page" : undefined}
        >
          {t("fsDocs.toRead")}
        </Link>
        <Link
          href={`${base}?withdrawn=1`}
          className={chip(withdrawn)}
          aria-current={withdrawn ? "page" : undefined}
        >
          {t("fsDocs.withdrawn")}
        </Link>
      </nav>
      {docs.length === 0 ? (
        <EmptyState title={t("fsDocs.empty")} />
      ) : (
        <Table label={t("fsDocs.title")}>
          <thead>
            <tr>
              <Th>{t("fsDocs.code")}</Th>
              <Th>{t("fsDocs.docTitle")}</Th>
              <Th>{t("fsDocs.type")}</Th>
              <Th>{t("fsDocs.inForce")}</Th>
              <Th>{t("fsDocs.reviewDueOn")}</Th>
              <Th>{t("fsDocs.read")}</Th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <Td>
                  <Link
                    href={`${base}/${d.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {d.code}
                  </Link>
                </Td>
                <Td>
                  {d.title}
                  <span className="text-muted block text-xs">
                    {d.branch ? `${d.branch.code} — ${d.branch.name}` : t("fsDocs.allBranches")}
                  </span>
                </Td>
                <Td>{t(`fsDocs.types.${d.type}`)}</Td>
                <Td>
                  {d.current ? (
                    <span className="ltr-value">v{d.current.version}</span>
                  ) : (
                    <Badge tone="warning">{t("fsDocs.notApproved")}</Badge>
                  )}
                  {d.draft ? (
                    <span className="text-muted ms-2 text-xs">
                      {t("fsDocs.draftV", { version: d.draft.version })}
                    </span>
                  ) : null}
                </Td>
                <Td
                  className={
                    d.current?.reviewDue ? "text-danger whitespace-nowrap" : "whitespace-nowrap"
                  }
                >
                  {day(d.current?.reviewDueOn ?? null)}
                </Td>
                <Td>
                  {d.current ? (
                    d.current.readByMe ? (
                      <Badge tone="success">{t("fsDocs.readYes")}</Badge>
                    ) : (
                      <Badge tone="warning">{t("fsDocs.readNo")}</Badge>
                    )
                  ) : (
                    "—"
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
