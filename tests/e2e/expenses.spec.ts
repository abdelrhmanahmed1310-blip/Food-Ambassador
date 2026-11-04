import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("set up a category, record an expense with VAT, then reverse it (ADR-109)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("expenses"),
    organization: "Spend Foods",
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
  await page.getByLabel("Description").fill("Electricity October");
  await page.getByLabel(/^Supplier invoice/).fill("INV-5531");
  await page.getByLabel("Net", { exact: true }).fill("1200");
  await page.getByLabel(/^VAT/).fill("168");
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("heading", { name: /^EXP-.* — Electricity October$/ })).toBeVisible();
  await expect(page.getByText(/1,368\.00/)).toBeVisible();

  await page.goto(`/o/${slug}/finance/expenses`);
  await expect(page.getByText("Utilities").first()).toBeVisible();
  await expect(page.getByRole("cell", { name: /1,200\.00/ })).toBeVisible();

  await page.getByRole("link", { name: /^EXP-/ }).click();
  await page.getByLabel("Reason for reversing").fill("Entered on the wrong branch");
  await page.getByRole("button", { name: "Reverse expense" }).click();
  await expect(page.getByText("Reversed", { exact: true }).first()).toBeVisible();
  await context.close();
});
