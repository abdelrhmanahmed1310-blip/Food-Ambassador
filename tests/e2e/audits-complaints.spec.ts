import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("audit findings and food safety complaints open non-conformances (ADR-098)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("quality-owner"),
    organization: "Quality Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();

  // An inspection with a major finding.
  await page.goto(`/o/${slug}/food-safety/audits`);
  await page.getByLabel("Branch").selectOption({ label: "CAI-01 — Cairo" });
  await page.getByLabel("Type").selectOption({ label: "Authority inspection" });
  await page.getByLabel("Auditor").fill("Municipality health inspector");
  await page.getByLabel("Scope").fill("Kitchen and cold storage");
  await page.getByRole("button", { name: "Plan audit" }).click();
  await expect(page.getByRole("heading", { name: /^AUD-.* — Authority inspection/ })).toBeVisible();
  const finding = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add finding" }) });
  await finding.getByLabel("Severity").selectOption({ label: "Major" });
  await finding.getByLabel("Finding", { exact: true }).fill("Walk-in fridge at 9 °C");
  await finding.getByRole("button", { name: "Add finding" }).click();
  await expect(page.getByRole("link", { name: /^NC-/ })).toBeVisible();
  await page.getByLabel(/^Result/).fill("Grade B");
  await page.getByRole("button", { name: "Complete audit" }).click();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();

  // A foreign object complaint.
  await page.goto(`/o/${slug}/food-safety/complaints/new`);
  await page.getByLabel("How it came").selectOption({ label: "Phone" });
  await page.getByLabel("Category").selectOption({ label: "Foreign object" });
  await page.getByLabel("What happened").fill("Plastic piece in the salad");
  await page.getByRole("button", { name: "Log complaint" }).click();
  await expect(page.getByRole("heading", { name: /^CMP-.* — Foreign object/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^NC-/ })).toBeVisible();
  const resolve = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Resolve complaint" }) });
  await resolve.getByLabel("Resolution", { exact: true }).fill("Salad station containers replaced");
  await resolve.getByRole("button", { name: "Resolve complaint" }).click();
  await expect(page.getByText("Resolved", { exact: true }).first()).toBeVisible();
  await context.close();
});
