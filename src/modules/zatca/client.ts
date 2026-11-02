/**
 * ZATCA Fatoora API (DECISIONS.md ADR-064): onboarding (compliance CSID,
 * compliance checks, production CSID) and reporting of simplified
 * documents. `fetch` is passed in.
 *
 * NOT YET TESTED against ZATCA: the development environment's network
 * policy blocks gw-fatoora.zatca.gov.sa. Paths and headers follow ZATCA's
 * API documentation (Accept-Version V2, Basic auth with the CSID token and
 * secret).
 */

export type ZatcaEnv = "DEVELOPER_PORTAL" | "SIMULATION" | "CORE";

export const ZATCA_BASE: Record<ZatcaEnv, string> = {
  DEVELOPER_PORTAL: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
  SIMULATION: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation",
  CORE: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core",
};

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface Csid {
  requestId: string;
  /** base64 of the certificate body (itself base64 DER). */
  token: string;
  secret: string;
}

export interface SubmitBody {
  invoiceHash: string;
  uuid: string;
  /** base64 of the signed XML. */
  invoice: string;
}

export class ZatcaHttpError extends Error {
  constructor(
    readonly status: number | null,
    readonly body: unknown,
  ) {
    super(`ZATCA answered ${status ?? "no response"}`);
  }
}

const basic = (c: { token: string; secret: string }) =>
  `Basic ${Buffer.from(`${c.token}:${c.secret}`).toString("base64")}`;

async function call(
  fetchImpl: Fetch,
  env: ZatcaEnv,
  path: string,
  init: { headers?: Record<string, string>; body: unknown; method?: string },
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetchImpl(`${ZATCA_BASE[env]}${path}`, {
      method: init.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "en",
        "Accept-Version": "V2",
        ...init.headers,
      },
      body: JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ZatcaHttpError(null, null);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep the text
  }
  return { status: res.status, body };
}

function csidFrom(status: number, body: unknown): Csid {
  const b = body as { requestID?: string | number; binarySecurityToken?: string; secret?: string };
  if (status !== 200 || !b?.binarySecurityToken || !b.secret)
    throw new ZatcaHttpError(status, body);
  return { requestId: String(b.requestID ?? ""), token: b.binarySecurityToken, secret: b.secret };
}

/** Step 1: the CSR and the one-time password from the Fatoora portal give a compliance CSID. */
export async function requestComplianceCsid(
  fetchImpl: Fetch,
  env: ZatcaEnv,
  csr: string,
  otp: string,
): Promise<Csid> {
  const r = await call(fetchImpl, env, "/compliance", { headers: { OTP: otp }, body: { csr } });
  return csidFrom(r.status, r.body);
}

/** Step 2: sample documents signed with the compliance certificate must pass. */
export async function checkCompliance(
  fetchImpl: Fetch,
  env: ZatcaEnv,
  csid: { token: string; secret: string },
  doc: SubmitBody,
) {
  const r = await call(fetchImpl, env, "/compliance/invoices", {
    headers: { Authorization: basic(csid) },
    body: doc,
  });
  const b = r.body as { reportingStatus?: string; validationResults?: { status?: string } };
  const passed =
    r.status === 200 || (r.status === 202 && b?.validationResults?.status === "WARNING");
  return { passed, status: r.status, body: r.body };
}

/** Step 3: the production CSID that signs real documents. */
export async function requestProductionCsid(
  fetchImpl: Fetch,
  env: ZatcaEnv,
  compliance: Csid,
): Promise<Csid> {
  const r = await call(fetchImpl, env, "/production/csids", {
    headers: { Authorization: basic(compliance) },
    body: { compliance_request_id: compliance.requestId },
  });
  return csidFrom(r.status, r.body);
}

export type ReportOutcome = "REPORTED" | "REPORTED_WITH_WARNINGS" | "REJECTED" | "RETRY";

/** What a reporting answer means for the document (pure). */
export function reportOutcome(status: number | null): ReportOutcome {
  if (status === 200) return "REPORTED";
  if (status === 202) return "REPORTED_WITH_WARNINGS";
  if (status === 400) return "REJECTED";
  return "RETRY"; // no answer, 401/403 (certificate), 429, 5xx: try again later
}

/** Report a simplified document (within 24 hours of issue). */
export async function reportDocument(
  fetchImpl: Fetch,
  env: ZatcaEnv,
  csid: { token: string; secret: string },
  doc: SubmitBody,
) {
  try {
    const r = await call(fetchImpl, env, "/invoices/reporting/single", {
      headers: { Authorization: basic(csid), "Clearance-Status": "0" },
      body: doc,
    });
    return { outcome: reportOutcome(r.status), status: r.status, body: r.body };
  } catch (error) {
    if (error instanceof ZatcaHttpError)
      return { outcome: "RETRY" as const, status: null, body: null };
    throw error;
  }
}

export type ClearOutcome = "CLEARED" | "CLEARED_WITH_WARNINGS" | "REJECTED" | "RETRY";

/** What a clearance answer means (pure): 200 cleared, 202 cleared with warnings, 400 rejected. */
export function clearOutcome(status: number | null, clearedInvoice: string | null): ClearOutcome {
  if ((status === 200 || status === 202) && clearedInvoice)
    return status === 200 ? "CLEARED" : "CLEARED_WITH_WARNINGS";
  if (status === 400) return "REJECTED";
  return "RETRY"; // no answer, 401/403, 429, 5xx, or no cleared document: try again later
}

/**
 * Clear a standard (B2B) document (ADR-072): ZATCA validates it, stamps it
 * and returns the cleared document — the legal invoice given to the buyer.
 */
export async function clearDocument(
  fetchImpl: Fetch,
  env: ZatcaEnv,
  csid: { token: string; secret: string },
  doc: SubmitBody,
) {
  try {
    const r = await call(fetchImpl, env, "/invoices/clearance/single", {
      headers: { Authorization: basic(csid), "Clearance-Status": "1" },
      body: doc,
    });
    const cleared = (r.body as { clearedInvoice?: unknown } | null)?.clearedInvoice;
    const clearedInvoice =
      typeof cleared === "string" && cleared.length > 0
        ? Buffer.from(cleared, "base64").toString("utf8")
        : null;
    return {
      outcome: clearOutcome(r.status, clearedInvoice),
      status: r.status,
      body: r.body,
      clearedInvoice,
    };
  } catch (error) {
    if (error instanceof ZatcaHttpError)
      return { outcome: "RETRY" as const, status: null, body: null, clearedInvoice: null };
    throw error;
  }
}

/** The QR of a cleared document (its "QR" additional document reference), or null. */
export function qrOf(xml: string): string | null {
  const m =
    /<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)<\/cbc:EmbeddedDocumentBinaryObject>/.exec(
      xml,
    );
  return m ? m[1].trim() : null;
}
