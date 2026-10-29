import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Alert, LinkButton } from "@/components/ui/primitives";
import { previewInvitation } from "@/modules/members/service";
import { getCurrentUser } from "@/server/auth/session";
import { acceptInvitationAction, signOutAction } from "../../(auth)/actions";

export default async function InvitationPage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const t = await getTranslations();
  const [invitation, user] = await Promise.all([previewInvitation(token), getCurrentUser()]);
  const roleName = invitation
    ? t.has(`roles.names.${invitation.roleKey}`)
      ? t(`roles.names.${invitation.roleKey}`)
      : invitation.roleName
    : "";

  let body;
  if (!invitation || !invitation.valid) {
    body = <Alert tone="error">{t("invite.invalid")}</Alert>;
  } else if (!user) {
    body = (
      <div className="flex flex-wrap gap-3">
        <LinkButton href={`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}>
          {t("invite.signInToAccept")}
        </LinkButton>
        <LinkButton href={`/sign-up?invite=${encodeURIComponent(token)}`} variant="secondary">
          {t("invite.signUpToAccept")}
        </LinkButton>
      </div>
    );
  } else if (user.email !== invitation.email) {
    body = (
      <div className="space-y-4">
        <Alert tone="error">
          {t("invite.wrongAccount", { current: user.email, email: invitation.email })}
        </Alert>
        <form action={signOutAction}>
          <button type="submit" className="text-primary text-sm font-medium hover:underline">
            {t("nav.signOut")}
          </button>
        </form>
      </div>
    );
  } else {
    body = (
      <ConfirmActionButton
        action={acceptInvitationAction.bind(null, token)}
        label={t("invite.accept")}
        variant="primary"
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <span className="font-semibold">{t("common.appName")}</span>
        <LocaleSwitcher />
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-8">
        <div className="border-border bg-surface space-y-4 rounded-lg border p-6">
          {invitation ? (
            <>
              <h1 className="text-xl font-semibold">
                {t("invite.title", { organization: invitation.organizationName })}
              </h1>
              <p className="text-muted text-sm">{t("invite.body", { role: roleName })}</p>
              <p className="text-muted text-sm">
                {t("invite.forEmail", { email: invitation.email })}
              </p>
            </>
          ) : null}
          {body}
        </div>
      </main>
    </div>
  );
}
