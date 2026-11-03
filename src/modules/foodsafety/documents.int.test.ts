import { beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  approveFsDocument,
  confirmFsDocumentRead,
  createFsDocument,
  getFsDocument,
  listFsDocuments,
  newFsDocumentVersion,
  updateFsDocumentDraft,
  withdrawFsDocument,
} from "./documents";

/** Document control (ADR-097). */

let ctx: TenantContext; // owner: approves
let qa: TenantContext; // food safety: writes
let cook: TenantContext; // branch manager at Cairo: reads
let other: string; // another branch

async function expectRule(promise: Promise<unknown>, rule: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; details?: { rule?: string } };
    expect(`${e.code}:${e.details?.rule}`).toBe(`BUSINESS_RULE_VIOLATION:${rule}`);
    return;
  }
  throw new Error(`Expected ${rule} but the call succeeded`);
}

let today: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("fsdocs"));
  today = businessDate(ctx.timeZone);
  qa = (await addMember(ctx, "food_safety")).ctx;
  const cairo = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  other = (await createBranch(ctx, { code: "ALX", name: "Alex", type: "RESTAURANT" })).id;
  cook = (await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: cairo })).ctx;
});

describe("controlled documents (ADR-097)", () => {
  it("goes draft → approved by someone else → read → new version supersedes", async () => {
    const doc = await createFsDocument(qa, {
      code: "sop-01",
      title: "Hand washing",
      type: "SOP",
      content: "1. Wet hands. 2. Soap for 20 seconds. 3. Rinse and dry.",
      changeSummary: "First issue",
    });
    expect(doc.code).toBe("SOP-01");
    await expectAppError(
      createFsDocument(qa, { code: "SOP-01", title: "x", type: "SOP", content: "x" }),
      "CONFLICT",
    );
    await expectRule(
      approveFsDocument(qa, doc.id, { effectiveFrom: today, reviewDueOn: addDays(today, 365) }),
      "DOCUMENT_SELF_APPROVAL",
    );
    await expectRule(
      approveFsDocument(ctx, doc.id, {
        effectiveFrom: addDays(today, -1),
        reviewDueOn: addDays(today, 365),
      }),
      "EFFECTIVE_DATE_PAST",
    );
    await expectRule(
      approveFsDocument(ctx, doc.id, { effectiveFrom: today, reviewDueOn: today }),
      "REVIEW_DATE_PAST",
    );
    // Nothing to read before it is approved.
    await expectRule(confirmFsDocumentRead(cook, doc.id), "NO_APPROVED_VERSION");
    await updateFsDocumentDraft(qa, doc.id, {
      title: "Hand washing",
      content: "1. Wet hands. 2. Soap for 20 seconds. 3. Rinse. 4. Dry with a paper towel.",
    });
    await approveFsDocument(ctx, doc.id, {
      effectiveFrom: today,
      reviewDueOn: addDays(today, 365),
    });

    let view = await getFsDocument(cook, doc.id);
    expect(view.current?.version).toBe(1);
    expect(view.current?.content).toContain("paper towel");
    expect(view.can).toMatchObject({ edit: false, approve: false, confirmRead: true });
    expect((await attentionItems(cook)).map((i) => i.key)).toContain("FS_DOCUMENTS_UNREAD");
    await confirmFsDocumentRead(cook, doc.id);
    await confirmFsDocumentRead(cook, doc.id); // once is enough
    view = await getFsDocument(ctx, doc.id);
    expect(view.current?.readers.map((r) => r.name)).toHaveLength(1);
    expect((await listFsDocuments(cook))[0].current?.readByMe).toBe(true);

    // Fixed once approved; a new version starts from it and stays a draft until approved.
    await expectRule(
      updateFsDocumentDraft(qa, doc.id, { title: "x", content: "x" }),
      "NO_DRAFT_VERSION",
    );
    await expect(
      getDb().fsDocumentVersion.update({
        where: { id: view.current!.id },
        data: { content: "changed" },
      }),
    ).rejects.toThrow(/cannot change/);
    const v2 = await newFsDocumentVersion(qa, doc.id);
    expect(v2.version).toBe(2);
    await expectRule(newFsDocumentVersion(qa, doc.id), "DRAFT_EXISTS");
    await updateFsDocumentDraft(qa, doc.id, {
      title: "Hand washing",
      content: "Use the sensor taps. Soap for 20 seconds. Rinse. Dry with a paper towel.",
      changeSummary: "Sensor taps installed",
    });
    expect((await getFsDocument(cook, doc.id)).current?.version).toBe(1); // still in force
    await approveFsDocument(ctx, doc.id, {
      effectiveFrom: today,
      reviewDueOn: addDays(today, 180),
    });
    view = await getFsDocument(cook, doc.id);
    expect(view.current?.version).toBe(2);
    expect(view.history.map((h) => [h.version, h.status])).toEqual([[1, "SUPERSEDED"]]);
    // The new version needs reading again.
    expect(view.readByMe).toBe(false);

    await expectAppError(withdrawFsDocument(qa, doc.id, { reason: "" }), "VALIDATION_FAILED");
    await withdrawFsDocument(qa, doc.id, { reason: "Replaced by the hygiene manual" });
    await expectRule(confirmFsDocumentRead(cook, doc.id), "DOCUMENT_WITHDRAWN");
    await expectRule(newFsDocumentVersion(qa, doc.id), "DOCUMENT_WITHDRAWN");
    expect((await listFsDocuments(cook)).map((d) => d.code)).not.toContain("SOP-01");
    expect((await listFsDocuments(cook, { withdrawn: true })).map((d) => d.code)).toContain(
      "SOP-01",
    );
  });

  it("is seen only where it applies", async () => {
    const elsewhere = await createFsDocument(ctx, {
      code: "WI-ALX",
      title: "Alex fryer cleaning",
      type: "WORK_INSTRUCTION",
      branchId: other,
      content: "Drain, cool, scrub.",
    });
    await expectAppError(getFsDocument(cook, elsewhere.id), "NOT_FOUND");
    expect((await listFsDocuments(cook)).map((d) => d.code)).not.toContain("WI-ALX");
    await expectAppError(
      createFsDocument(cook, { code: "X", title: "x", type: "SOP", content: "x" }),
      "FORBIDDEN",
    );
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listFsDocuments(cashier.ctx), "FORBIDDEN");
    const { ctx: stranger } = await createTenant("fsdocs-other");
    await expectAppError(getFsDocument(stranger, elsewhere.id), "NOT_FOUND");
  });
});
