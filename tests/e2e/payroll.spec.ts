import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("payroll: salary, entered rule, run with an addition, payslip (ADR-123)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Payer",
    email: uniqueEmail("payroll"),
    organization: "Paying Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();
  await page.goto(`/o/${slug}/hr/employees/new`);
  await page.getByLabel("First name").fill("Huda");
  await page.getByLabel("Last name").fill("Saleh");
  await page.getByLabel("Job title").fill("Head chef");
  await page.getByLabel("Hire date").fill("2026-01-10");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Huda Saleh" })).toBeVisible();

  // Salary with a housing allowance in the contribution base, and a bank account.
  const pay = page.getByTestId("employee-pay");
  await expect(pay.getByText("No salary on record.")).toBeVisible();
  await pay.getByLabel("From").fill("2026-01-10");
  await pay.getByLabel("Basic salary").fill("5000");
  await pay.getByLabel("Code").first().fill("HOUSING");
  await pay.getByLabel("Allowance").first().fill("Housing");
  await pay.getByLabel("Amount").first().fill("1000");
  await pay.getByLabel("In contribution base").first().check();
  await pay.getByRole("button", { name: "Save salary" }).click();
  await expect(pay.getByRole("cell", { name: /6,000\.00/ })).toBeVisible();
  await pay.getByLabel("Bank", { exact: true }).fill("Al Bank");
  await pay.getByLabel("IBAN").fill("SA0380000000608010167518");
  await pay.getByRole("button", { name: "Save bank account" }).click();
  await expect(pay.getByText("Enter a valid IBAN.")).toBeVisible();
  await pay.getByLabel("IBAN").fill("SA0380000000608010167519");
  await pay.getByRole("button", { name: "Save bank account" }).click();
  await expect(pay.getByText("Bank: Al Bank, IBAN ending 7519.")).toBeVisible();

  // Rules as the organization enters them (test values, not a country's).
  await page.goto(`/o/${slug}/hr/payroll/rules`);
  await expect(page.getByText(/No statutory rate is built in/).first()).toBeVisible();
  const formWith = (button: string) =>
    page.locator("form").filter({ has: page.getByRole("button", { name: button }) });
  const contribution = formWith("Add rule");
  await contribution.getByLabel("Code").fill("TEST_SCHEME");
  await contribution.getByLabel("Name").fill("Test scheme");
  await contribution.getByLabel("Employee rate (%)").fill("10");
  await contribution.getByLabel("From", { exact: true }).fill("2026-01-01");
  await contribution.getByLabel("Source").fill("E2E test values");
  await contribution.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByRole("cell", { name: "E2E test values" }).first()).toBeVisible();
  // Income tax: nothing up to 60,000 a year, 10 % above.
  const tax = formWith("Add income tax table");
  await tax.getByLabel("Code").fill("TEST_TAX");
  await tax.getByLabel("Name").fill("Test tax");
  await tax.getByLabel("From", { exact: true }).fill("2026-01-01");
  await tax.getByLabel("Source").fill("E2E tax values");
  await tax.getByLabel("Bracket 1 up to").first().fill("60000");
  await tax.getByLabel("Bracket 1 rate (%)").first().fill("0");
  await tax.getByLabel("Bracket 2 rate (%)").first().fill("10");
  await tax.getByRole("button", { name: "Add income tax table" }).click();
  await expect(page.getByTestId("tax-TEST_TAX")).toContainText("10% ≤ ∞");
  // End of service: half a month a year, resignation share left as paid in full.
  const eos = formWith("Add end-of-service rule");
  await eos.getByLabel("Code").fill("TEST_EOS");
  await eos.getByLabel("Name").fill("Test EOS");
  await eos.getByLabel("From", { exact: true }).fill("2026-01-01");
  await eos.getByLabel("Source").fill("E2E EOS values");
  await eos.getByLabel("Tier 1 from years").fill("0");
  await eos.getByLabel("Tier 1 months per year").fill("0.5");
  await eos.getByRole("button", { name: "Add end-of-service rule" }).click();
  await expect(page.getByTestId("eos-TEST_EOS")).toContainText("Paid in full");

  // The run: proration chosen first, then February (a full month).
  await page.goto(`/o/${slug}/hr/payroll`);
  await expect(page.getByText("Choose how part months are paid first.")).toBeVisible();
  await page.getByLabel("Part months").selectOption({ label: "30-day month" });
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("textbox", { name: "Month" }).fill("2026-02");
  await page.getByRole("button", { name: "Work out the month" }).click();
  await expect(page.getByRole("heading", { name: /^PAY-2026-/ })).toBeVisible();
  // 6000 − 10 % contribution − tax (72,000 a year: 1,200, so 100 a month).
  await expect(page.getByTestId("run-net")).toHaveText(/5,300\.00/);
  await page.getByLabel("Category").selectOption({ label: "Overtime" });
  await page.getByLabel("Amount").fill("200");
  await page.getByRole("button", { name: "Add an addition or deduction" }).click();
  // 6200 − 600 − 120 tax (74,400 a year).
  await expect(page.getByTestId("run-net")).toHaveText(/5,480\.00/);
  // The preparer cannot approve their own run.
  await expect(page.getByText(/Someone other than the preparer/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  const href = await page.getByRole("link", { name: "PDF" }).getAttribute("href");
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  await context.close();
});
