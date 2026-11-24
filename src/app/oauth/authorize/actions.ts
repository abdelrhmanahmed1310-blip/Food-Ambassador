"use server";

import { redirect } from "next/navigation";
import { approveAuthorization, denyAuthorization } from "@/modules/oauth/service";
import { requireUser } from "@/server/auth/session";
import { AUTHORIZE_PARAMS } from "./params";

/** Allow or deny an app's request (ADR-144); either way the person goes back to the app. */
export async function decideAuthorizeAction(formData: FormData) {
  const user = await requireUser();
  const params = Object.fromEntries(
    AUTHORIZE_PARAMS.map((k) => [k, String(formData.get(`p_${k}`) ?? "") || undefined]),
  );
  if (formData.get("decision") !== "allow") {
    const url = await denyAuthorization(params);
    redirect(url ?? "/");
  }
  const url = await approveAuthorization(user.id, params, {
    organizationId: String(formData.get("organizationId") ?? ""),
    scopes: formData.getAll("scopes").map(String),
  });
  redirect(url);
}
