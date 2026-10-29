import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import {
  contextFor,
  createTenant,
  createUser,
  expectAppError,
} from "../../../test/support/factories";
import {
  acceptInvitation,
  createInvitation,
  listMembers,
  previewInvitation,
  revokeInvitation,
} from "./service";

afterAll(async () => {
  await getDb().$disconnect();
});

async function roleId(organizationId: string, key: string) {
  return (
    await getDb().role.findUniqueOrThrow({ where: { organizationId_key: { organizationId, key } } })
  ).id;
}

describe("invitations", () => {
  it("invited user accepts and gets exactly the invited role", async () => {
    const { ctx } = await createTenant("inv");
    const invitee = await createUser("invitee");
    const { token } = await createInvitation(ctx, {
      email: invitee.email.toUpperCase(),
      roleId: await roleId(ctx.organizationId, "finance"),
    });

    const preview = await previewInvitation(token);
    expect(preview).toMatchObject({ email: invitee.email, roleKey: "finance", valid: true });

    const { organizationSlug } = await acceptInvitation(invitee, token);
    expect(organizationSlug).toBe(ctx.organizationSlug);
    const inviteeCtx = await contextFor(invitee.id, organizationSlug);
    expect(new Set(inviteeCtx.grants.map((g) => g.roleKey))).toEqual(new Set(["finance"]));

    // Single use.
    await expectAppError(acceptInvitation(invitee, token), "BUSINESS_RULE_VIOLATION");
    expect((await previewInvitation(token))?.valid).toBe(false);
  });

  it("rejects acceptance by a different email address", async () => {
    const { ctx } = await createTenant("inv-mismatch");
    const { token } = await createInvitation(ctx, {
      email: "someone-else@example.test",
      roleId: await roleId(ctx.organizationId, "analyst"),
    });
    const intruder = await createUser("intruder");
    await expectAppError(acceptInvitation(intruder, token), "FORBIDDEN");
    expect((await listMembers(ctx)).members).toHaveLength(1);
  });

  it("rejects revoked, expired and unknown tokens", async () => {
    const { ctx } = await createTenant("inv-states");
    const user = await createUser("late");
    const analyst = await roleId(ctx.organizationId, "analyst");

    const revoked = await createInvitation(ctx, { email: user.email, roleId: analyst });
    await revokeInvitation(ctx, revoked.invitationId);
    await expectAppError(acceptInvitation(user, revoked.token), "BUSINESS_RULE_VIOLATION");

    const expired = await createInvitation(ctx, { email: user.email, roleId: analyst });
    await getDb().invitation.update({
      where: { id: expired.invitationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expectAppError(acceptInvitation(user, expired.token), "BUSINESS_RULE_VIOLATION");

    await expectAppError(acceptInvitation(user, "not-a-real-token"), "NOT_FOUND");
    expect(await previewInvitation("not-a-real-token")).toBeNull();
  });

  it("prevents duplicate pending invitations and inviting existing members", async () => {
    const { ctx, owner } = await createTenant("inv-dupe");
    const analyst = await roleId(ctx.organizationId, "analyst");
    await createInvitation(ctx, { email: "dupe@example.test", roleId: analyst });
    await expectAppError(
      createInvitation(ctx, { email: "dupe@example.test", roleId: analyst }),
      "CONFLICT",
    );
    await expectAppError(
      createInvitation(ctx, { email: owner.email, roleId: analyst }),
      "CONFLICT",
    );
  });

  it("validates scope and email input", async () => {
    const { ctx } = await createTenant("inv-validate");
    const analyst = await roleId(ctx.organizationId, "analyst");
    await expectAppError(
      createInvitation(ctx, { email: "not-an-email", roleId: analyst }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createInvitation(ctx, { email: "x@example.test", roleId: analyst, scopeType: "BRANCH" }),
      "VALIDATION_FAILED",
    );
  });

  it("stores only a hash of the token", async () => {
    const { ctx } = await createTenant("inv-hash");
    const { invitationId, token } = await createInvitation(ctx, {
      email: "hash@example.test",
      roleId: await roleId(ctx.organizationId, "analyst"),
    });
    const stored = await getDb().invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(stored.tokenHash).not.toContain(token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
