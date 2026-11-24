import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/brand/logo";
import { buttonClass } from "@/components/ui/styles";
import { checkAuthorizeRequest, consentOrganizations } from "@/modules/oauth/service";
import { requireUser } from "@/server/auth/session";
import { decideAuthorizeAction } from "./actions";
import { AUTHORIZE_PARAMS } from "./params";

export const dynamic = "force-dynamic";

/**
 * Consent for an app that wants to act as the signed-in person over the MCP
 * server (ADR-144): which app, where it sends the person back, the
 * organization and what it may do.
 */
export default async function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  const sp = await searchParams;
  const params = Object.fromEntries(
    AUTHORIZE_PARAMS.map((k) => [k, typeof sp[k] === "string" ? (sp[k] as string) : undefined]),
  );
  const query = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  const user = await requireUser(`/oauth/authorize?${query}`);
  const t = await getTranslations("oauth");
  const check = await checkAuthorizeRequest(params);
  if (!check.ok && "redirect" in check) redirect(check.redirect);
  const shell = (children: React.ReactNode) => (
    <main className="mx-auto w-full max-w-lg space-y-4 p-6">
      <Logo className="h-12 w-auto" />
      {children}
    </main>
  );
  if (!check.ok)
    return shell(
      <p role="alert" className="text-danger" data-testid="oauth-error">
        {t(check.show === "UNKNOWN_CLIENT" ? "unknownClient" : "badRedirect")}
      </p>,
    );
  const orgs = await consentOrganizations(user.id);
  const host = new URL(check.redirectUri).host;
  return shell(
    <>
      <h1 className="text-2xl font-semibold" data-testid="oauth-consent">
        {t("title", { app: check.client.name })}
      </h1>
      <p className="text-sm">{t("intro", { app: check.client.name, name: user.name })}</p>
      <p className="text-muted text-sm">
        {t("returnsTo")} <span className="ltr-value font-mono">{host}</span>
      </p>
      {orgs.length === 0 ? (
        <p role="alert" className="text-danger">
          {t("noOrganizations")}
        </p>
      ) : (
        <form action={decideAuthorizeAction} className="space-y-4">
          {AUTHORIZE_PARAMS.map((k) =>
            params[k] ? <input key={k} type="hidden" name={`p_${k}`} value={params[k]} /> : null,
          )}
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{t("organization")}</span>
            <select
              name="organizationId"
              className="border-border bg-surface w-full rounded-md border px-3 py-2"
              defaultValue={orgs[0].id}
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="space-y-2 text-sm">
            <legend className="font-medium">{t("mayDo")}</legend>
            {check.scopes.map((s) => (
              <label key={s} className="flex items-start gap-2">
                <input type="checkbox" name="scopes" value={s} defaultChecked className="mt-1" />
                <span>{t(`scopes.${s === "mcp:read" ? "read" : "decide"}`)}</span>
              </label>
            ))}
          </fieldset>
          <p className="text-muted text-xs">{t("asYou")}</p>
          <div className="flex gap-3">
            <button type="submit" name="decision" value="allow" className={buttonClass("primary")}>
              {t("allow")}
            </button>
            <button type="submit" name="decision" value="deny" className={buttonClass("secondary")}>
              {t("deny")}
            </button>
          </div>
        </form>
      )}
    </>,
  );
}
