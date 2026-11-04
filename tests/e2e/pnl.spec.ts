import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("a posted expense shows on the branch P&L (ADR-111)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("pnl"),
    organization: "Ledger Foods",
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

  await page.goto(`/o/${slug}/finance/pnl`);
  await expect(page.getByRole("heading", { name: "Branch P&L" })).toBeVisible();
  const utilities = page.getByTestId("pnl-row-UTILITIES");
  await expect(utilities.getByText(/1,200\.00/)).toBeVisible();
  // No sales: the result is the expense, with no percentages of sales.
  const result = page.getByTestId("pnl-row-OPERATING_RESULT");
  await expect(result.getByText("-EGP 1,200.00")).toBeVisible();
  await expect(result.getByText("%")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  expect((await download).suggestedFilename()).toBe("branch-pnl.csv");
  await context.close();
});
