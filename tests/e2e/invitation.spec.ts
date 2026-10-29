import { expect, test } from "@playwright/test";
import { PASSWORD, newClient, signUp, uniqueEmail } from "./helpers";

test("an invited user joins with the invited role and limited access", async ({ browser }) => {
  const owner = await newClient(browser);
  const slug = await signUp(owner.page, {
    name: "Owner",
    email: uniqueEmail("owner"),
    organization: "Invite Foods",
  });

  const inviteeEmail = uniqueEmail("analyst");
  await owner.page.goto(`/o/${slug}/settings/members`);
  await owner.page.getByLabel("Email").fill(inviteeEmail);
  await owner.page.getByLabel("Role").selectOption({ label: "Read-only Analyst" });
  await owner.page.getByRole("button", { name: "Invite member" }).click();
  const link = await owner.page.getByLabel("Invitation link").inputValue();
  expect(link).toMatch(/\/invite\/[\w-]{20,}$/);
  await expect(owner.page.getByRole("listitem").filter({ hasText: inviteeEmail })).toBeVisible();

  const invitee = await newClient(browser);
  await invitee.page.goto(new URL(link).pathname);
  await expect(invitee.page.getByRole("heading", { name: "Join Invite Foods" })).toBeVisible();
  await invitee.page.getByRole("link", { name: "Create an account" }).click();
  await invitee.page.getByLabel("Full name").fill("Ana Lyst");
  await expect(invitee.page.getByLabel("Email")).toHaveValue(inviteeEmail);
  await invitee.page.getByLabel("Password").fill(PASSWORD);
  await invitee.page.getByRole("button", { name: "Create account" }).click();
  await expect(invitee.page).toHaveURL(new RegExp(`/o/${slug}$`));

  // Read-only: no admin navigation, and admin pages 404 even by direct URL.
  await expect(invitee.page.getByRole("link", { name: "Members" })).toHaveCount(0);
  const response = await invitee.page.goto(`/o/${slug}/settings/roles`);
  expect(response?.status()).toBe(404);
  const createPage = await invitee.page.goto(`/o/${slug}/branches/new`);
  expect(createPage?.status()).toBe(404);

  // The link is single-use.
  await invitee.page.goto(new URL(link).pathname);
  await expect(invitee.page.getByText("This invitation is no longer valid.")).toBeVisible();

  await owner.page.reload();
  await expect(owner.page.getByText("Ana Lyst")).toBeVisible();
  await owner.context.close();
  await invitee.context.close();
});
