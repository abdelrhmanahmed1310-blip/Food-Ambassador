import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("payables: invoice, part payment, supplier balance, statement and journal export", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Finance Lead",
    email: uniqueEmail("payables"),
    organization: "Delta Payables",
  });
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("nile");
  await page.getByLabel("Name", { exact: true }).fill("Nile Foods");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Nile Foods" })).toBeVisible();

  // An invoice of one delivery charge (no VAT set up): 300.
  await page.goto(`/o/${slug}/purchasing/invoices/new`);
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "NILE — Nile Foods" });
  await page.getByLabel("Supplier invoice no.").fill("NF-1");
  await page.getByLabel("Invoice date").fill("2026-10-01");
  await page.getByLabel("Total on the invoice").fill("300");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByRole("heading", { name: /^PI-/ })).toBeVisible();
  const charge = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add charge" }) });
  await charge.getByLabel("Charge").fill("Catering supplies");
  await charge.getByLabel("Net amount").fill("300");
  await charge.getByRole("button", { name: "Add charge" }).click();
  await expect(page.getByTestId("invoice-line-1")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByText("Unpaid", { exact: true })).toBeVisible();

  await page.goto(`/o/${slug}/purchasing/payables?asOf=2026-10-31`);
  await expect(page.getByTestId("balance-NILE")).toContainText(/300\.00/);
  await page.getByRole("link", { name: /NILE/ }).click();

  // Pay 120 against the invoice.
  const pay = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Record payment" }) });
  await pay.getByLabel("Date").fill("2026-10-15");
  await pay.getByLabel(/^Amount/).fill("120");
  await pay.getByLabel("Reference").fill("TRF-889");
  await pay.getByLabel(/^PI-/).fill("150");
  await pay.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText(/exceed what is available/)).toBeVisible();
  await pay.getByLabel(/^PI-/).fill("120");
  await pay.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByRole("heading", { name: /^PAY-/ })).toBeVisible();
  await expect(page.getByTestId("unapplied")).toHaveText(/0\.00/);
  await page.getByRole("link", { name: /^PI-/ }).click();
  await expect(page.getByText("Partly paid", { exact: true })).toBeVisible();
  await expect(page.getByTestId("invoice-open")).toHaveText(/180\.00/);

  await page.goto(`/o/${slug}/purchasing/payables?asOf=2026-11-30`);
  await expect(page.getByTestId("balance-NILE")).toContainText(/180\.00/);
  await expect(page.getByText("Set your account codes")).toBeVisible();

  await page.goto(`/o/${slug}/settings/purchasing`);
  const accounts = page.locator("form").filter({ has: page.getByLabel(/^Supplier payables/) });
  await accounts.getByLabel(/^Supplier payables/).fill("2100");
  await accounts.getByLabel(/^Purchases/).fill("5100");
  await accounts.getByLabel(/^Bank/).fill("1010");
  await accounts.getByRole("button", { name: "Save" }).click();
  await expect(accounts.getByText("Changes saved.")).toBeVisible();

  const res = await page.request.get(
    `/o/${slug}/purchasing/payables/export/journal?from=2026-10-01&to=2026-10-31`,
  );
  expect(res.status()).toBe(200);
  const csv = await res.text();
  expect(csv).toContain("5100,300.00,");
  expect(csv).toContain("2100,,300.00");
  expect(csv).toContain("1010,,120.00");
  await context.close();
});
