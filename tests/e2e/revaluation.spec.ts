import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("exchange revaluation: a USD supplier invoice revalued at the closing rate", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("reval"),
    organization: "Closing Foods",
  });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(
    new Date(Date.now() - 86_400_000),
  );
  // 1 USD = 48.5 EGP yesterday, 50 today.
  await page.goto(`/o/${slug}/purchasing/exchange-rates`);
  await page
    .getByLabel(/^CSV: date, currency, rate/)
    .fill(`date,currency,rate\n${yesterday},USD,48.5\n${today},USD,50\n`);
  await page.getByRole("button", { name: "Import rates" }).click();
  await expect(page.getByText("2 rates saved.")).toBeVisible();

  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("us-foods");
  await page.getByLabel("Name", { exact: true }).fill("US Foods");
  await page.getByLabel("Currency").selectOption("USD");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "US Foods" })).toBeVisible();

  // A USD invoice of 100 dated yesterday: booked at 4,850 EGP.
  await page.goto(`/o/${slug}/purchasing/invoices`);
  await page.getByRole("link", { name: "New supplier invoice" }).click();
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "US-FOODS — US Foods" });
  await page.getByLabel("Supplier invoice no.").fill("USF-1");
  await page.getByLabel("Invoice date").fill(yesterday);
  await page.getByLabel("Total on the invoice").fill("100");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByRole("heading", { name: /^PI-/ })).toBeVisible();
  const charge = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add charge" }) });
  await charge.getByLabel("Charge", { exact: true }).fill("Spices");
  await charge.getByLabel("Net amount").fill("100");
  await charge.getByRole("button", { name: "Add charge" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByText("Posted", { exact: true })).toBeVisible();
  await expect(page.getByTestId("fx-base-amount")).toHaveText(/EGP\s?4,850\.00/);

  // Revalued today at 50: 5,000 EGP, a 150 EGP unrealised loss.
  await page.goto(`/o/${slug}/purchasing/payables/revaluation`);
  await expect(page.getByTestId("revaluation-total-PAYABLE")).toContainText(/EGP\s?150\.00/);
  await page.getByRole("button", { name: "Post revaluation" }).click();
  await expect(page.getByRole("heading", { name: /^REV-/ })).toBeVisible();
  await expect(page.getByTestId("revaluation-difference")).toHaveText(/EGP\s?150\.00/);
  await context.close();
});
