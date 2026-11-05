import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { TrainingSection } from "@/components/learning/training-section";
import { PageHeader } from "@/components/ui/primitives";
import { myTraining } from "@/modules/learning/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** The signed-in employee's training and certificates (ADR-125). */
export default async function MyTrainingPage({ params }: PageProps<"/o/[orgSlug]/my/training">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const data = await myTraining(ctx).catch(() => null);
  if (!data) notFound();
  const [t, locale] = await Promise.all([getTranslations("learning"), getLocale()]);
  return (
    <>
      <PageHeader title={t("myTraining")} />
      <TrainingSection ctx={ctx} data={data} locale={locale} orgSlug={orgSlug} manage={false} />
    </>
  );
}
