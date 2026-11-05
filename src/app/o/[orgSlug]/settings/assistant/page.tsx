import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AssistantSettingsForm, ButtonForm } from "@/components/assistant/forms";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { getAssistantSettings } from "@/modules/assistant/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  saveAssistantSettingsAction,
  setAssistantEnabledAction,
  testAssistantAction,
} from "../../assistant/actions";

/** The assistant's provider key, model and limits (ADR-122). */
export default async function AssistantSettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/assistant">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "assistant.manage")) notFound();
  const [t, format, s] = await Promise.all([
    getTranslations("assistant"),
    getFormatter(),
    getAssistantSettings(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("settingsTitle")} description={t("settingsHint")} />
      <div className="space-y-6">
        <Card title={t("status")}>
          <div className="space-y-3 text-sm">
            <p>
              {s.enabled ? (
                <Badge tone="success">{t("on")}</Badge>
              ) : (
                <Badge tone="muted">{t("offShort")}</Badge>
              )}{" "}
              {s.testedAt ? (
                s.testOk ? (
                  <span>
                    {t("lastTestOk", {
                      at: format.dateTime(s.testedAt, { dateStyle: "medium", timeStyle: "short" }),
                    })}
                  </span>
                ) : (
                  <span className="text-danger">
                    {t("lastTestFailed", { error: s.testError ?? "" })}
                  </span>
                )
              ) : (
                <span className="text-muted">{t("notTested")}</span>
              )}
            </p>
            {s.hasKey ? (
              <div className="flex flex-wrap gap-3">
                <ButtonForm action={testAssistantAction.bind(null, orgSlug)} label={t("test")} />
                {s.enabled ? (
                  <ButtonForm
                    action={setAssistantEnabledAction.bind(null, orgSlug, false)}
                    label={t("switchOff")}
                  />
                ) : s.testOk ? (
                  <ButtonForm
                    action={setAssistantEnabledAction.bind(null, orgSlug, true)}
                    label={t("switchOn")}
                    variant="primary"
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </Card>
        <Card title={t("provider")}>
          <AssistantSettingsForm
            action={saveAssistantSettingsAction.bind(null, orgSlug)}
            defaults={{
              model: s.model,
              dailyQuestionLimit: String(s.dailyQuestionLimit),
              keyHint: s.keyHint,
            }}
          />
        </Card>
        <Alert tone="info">{t("governanceAdmin")}</Alert>
      </div>
    </>
  );
}
