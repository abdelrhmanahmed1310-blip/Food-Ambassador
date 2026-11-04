import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("set a monthly target and see it in sales analytics (ADR-105)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("sales-analytics"),
    organization: "Target Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();

  // Nothing sold yet: zeros and no comparisons rather than invented ones.
  await page.goto(`/o/${slug}/reports/sales`);
  await expect(page.getByRole("heading", { name: "Sales analytics" })).toBeVisible();
  await expect(page.getByText("No sales in this period.").first()).toBeVisible();

  await page.getByRole("link", { name: "Targets" }).click();
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const card = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Save targets" }) });
  await card.getByLabel(new RegExp(`^${month}`)).fill("31000");
  await card.getByRole("button", { name: "Save targets" }).click();
  await expect(page.getByText("Changes saved.").first()).toBeVisible();
  await page.reload();
  await expect(card.getByLabel(new RegExp(`^${month}`))).toHaveValue("31000.00");

  await page.goto(`/o/${slug}/reports/sales`);
  const totals = page.getByTestId("sales-totals");
  await expect(totals.getByText("Target", { exact: true })).toBeVisible();
  await expect(totals.getByText("0.0 %")).toBeVisible();
  await context.close();
});
