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

  // A contribution rule as the organization enters it (test values, not a country's).
  await page.goto(`/o/${slug}/hr/payroll/rules`);
  await expect(page.getByText(/No statutory rate is built in/)).toBeVisible();
  await page.getByLabel("Code").fill("TEST_SCHEME");
  await page.getByLabel("Name").fill("Test scheme");
  await page.getByLabel("Employee rate (%)").fill("10");
  await page.getByLabel("From").fill("2026-01-01");
  await page.getByLabel("Source").fill("E2E test values");
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByRole("cell", { name: "E2E test values" })).toBeVisible();

  // The run: proration chosen first, then February (a full month).
  await page.goto(`/o/${slug}/hr/payroll`);
  await expect(page.getByText("Choose how part months are paid first.")).toBeVisible();
  await page.getByLabel("Part months").selectOption({ label: "30-day month" });
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("textbox", { name: "Month" }).fill("2026-02");
  await page.getByRole("button", { name: "Work out the month" }).click();
  await expect(page.getByRole("heading", { name: /^PAY-2026-/ })).toBeVisible();
  // 6000 − 10 % of 6000.
  await expect(page.getByTestId("run-net")).toHaveText(/5,400\.00/);
  await page.getByLabel("Category").selectOption({ label: "Overtime" });
  await page.getByLabel("Amount").fill("200");
  await page.getByRole("button", { name: "Add an addition or deduction" }).click();
  await expect(page.getByTestId("run-net")).toHaveText(/5,600\.00/);
  // The preparer cannot approve their own run.
  await expect(page.getByText(/Someone other than the preparer/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  const href = await page.getByRole("link", { name: "PDF" }).getAttribute("href");
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  await context.close();
});
