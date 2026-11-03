import { expect, test, type Browser, type Page } from "@playwright/test";
import { PASSWORD, newClient, signUp, uniqueEmail } from "./helpers";

async function invite(owner: Page, browser: Browser, slug: string, name: string, role: string) {
  await owner.goto(`/o/${slug}/settings/members`);
  await owner.getByLabel("Email").fill(uniqueEmail(name.toLowerCase().replace(/\s+/g, "-")));
  await owner.getByLabel("Role").selectOption({ label: role });
  await owner.getByRole("button", { name: "Invite member" }).click();
  const link = await owner.getByLabel("Invitation link").inputValue();
  const client = await newClient(browser);
  await client.page.goto(new URL(link).pathname);
  await client.page.getByRole("link", { name: "Create an account" }).click();
  await client.page.getByLabel("Full name").fill(name);
  await client.page.getByLabel("Password").fill(PASSWORD);
  await client.page.getByRole("button", { name: "Create account" }).click();
  await expect(client.page).toHaveURL(new RegExp(`/o/${slug}$`));
  return client;
}

test("supplier approval, documents and a verified bank account (ADR-091)", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await newClient(browser);
  const page = owner.page;
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("compliance-owner"),
    organization: "Compliance Foods",
  });

  await page.goto(`/o/${slug}/settings/purchasing`);
  await page.getByLabel(/New suppliers need approval/).check();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Changes saved.").first()).toBeVisible();

  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("delta-dairy");
  await page.getByLabel("Name", { exact: true }).fill("Delta Dairy");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Delta Dairy" })).toBeVisible();
  const supplierUrl = page.url();
  await expect(page.getByText("Waiting for approval").first()).toBeVisible();
  await expect(
    page.getByText("You added this supplier, so someone else must approve it."),
  ).toBeVisible();

  // A required certificate that has already expired.
  const docs = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add document" }) });
  await docs.getByLabel("Type").selectOption({ label: "Halal certificate" });
  await docs.getByLabel("Number").fill("HAL-2025-17");
  await docs.getByLabel("Expires").fill("2026-01-31");
  await docs.getByLabel(/Required to buy/).check();
  await docs.getByRole("button", { name: "Add document" }).click();
  await expect(page.getByText("1 required document expired")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Expired" })).toBeVisible();

  // A bank account: shown masked, full number on request.
  const bank = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add bank account" }) });
  await bank.getByLabel("Bank", { exact: true }).fill("Saudi National Bank");
  await bank.getByLabel(/Account holder/).fill("Delta Dairy Co");
  await bank.getByLabel("IBAN or account number").fill("SA04 8000 0000 6080 1016 7519");
  await bank.getByRole("button", { name: "Add bank account" }).click();
  await expect(page.getByText("check digits do not match")).toBeVisible();
  await bank.getByLabel("IBAN or account number").fill("SA03 8000 0000 6080 1016 7519");
  await bank.getByRole("button", { name: "Add bank account" }).click();
  await expect(page.getByText("•••• 7519")).toBeVisible();
  await expect(page.getByText("Not verified")).toBeVisible();
  await page.getByRole("button", { name: "Show full number" }).click();
  await expect(page.getByText("SA03 8000 0000 6080 1016 7519")).toBeVisible();

  // Finance approves the supplier and verifies the account.
  const finance = await invite(page, browser, slug, "Finance Lead", "Finance");
  const f = finance.page;
  await f.goto(`/o/${slug}/attention`);
  await expect(f.getByText("1 supplier waiting for approval")).toBeVisible();
  await expect(f.getByText("1 supplier bank account to verify")).toBeVisible();
  await f.goto(new URL(supplierUrl).pathname);
  await f.getByRole("button", { name: "Approve supplier" }).click();
  await expect(f.getByText(/Approved by Finance Lead/)).toBeVisible();
  f.once("dialog", (d) => d.accept());
  await f.getByRole("button", { name: "Mark as verified" }).click();
  await expect(f.getByText("Verified", { exact: true })).toBeVisible();

  await finance.context.close();
  await owner.context.close();
});
