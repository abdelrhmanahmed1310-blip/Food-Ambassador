import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("set a branch budget line and compare it with a posted expense (ADR-110)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("budgets"),
    organization: "Budget Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();

  await page.goto(`/o/${slug}/finance/expenses/setup`);
  const category = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add category" }) });
  await category.getByLabel("Code").fill("POWER");
  await category.getByLabel("Name", { exact: true }).fill("Electricity");
  await category.getByLabel(/^P&L group/).selectOption("UTILITIES");
  await category.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByRole("cell", { name: "Electricity" })).toBeVisible();

  await page.goto(`/o/${slug}/finance/expenses/new`);
  await page.getByLabel("Category").selectOption({ index: 1 });
  await page.getByLabel("Description").fill("Electricity");
  await page.getByLabel("Net", { exact: true }).fill("1200");
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("heading", { name: /^EXP-/ })).toBeVisible();

  await page.goto(`/o/${slug}/finance/budgets`);
  await expect(page.getByRole("heading", { name: "Budgets" })).toBeVisible();
  // The current month is the one the comparison opens on.
  const month = (await page.getByLabel("Month").inputValue()) as string;
  const monthName = new Date(Date.UTC(2000, Number(month) - 1, 1)).toLocaleString("en-GB", {
    month: "long",
    timeZone: "UTC",
  });
  const utilities = page.getByTestId("budget-line-UTILITIES");
  await utilities.locator("summary").click();
  await utilities.getByLabel(new RegExp(`^${monthName} `)).fill("1000");
  await utilities.getByRole("button", { name: "Save line" }).click();
  await expect(utilities.getByText("Changes saved.")).toBeVisible();

  await page.reload();
  const row = page.getByTestId("budget-row-UTILITIES");
  await expect(row.getByText(/1,000\.00/).first()).toBeVisible();
  await expect(row.getByText(/1,200\.00/).first()).toBeVisible();
  await expect(row.getByText("Unfavourable").first()).toBeVisible();
  // No sales target yet: the sales line has no variance.
  await expect(page.getByTestId("budget-row-SALES").getByText("Unfavourable")).toHaveCount(0);
  await context.close();
});
