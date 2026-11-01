import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("card payments: slip details and tip on the order, the acquirer's file matched", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "payments");
  await page.getByRole("link", { name: "Open till" }).click();

  // A cola (25) by card with the slip's details and a tip of 5.
  await page.getByRole("button", { name: /Cola/ }).first().click();
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByText("Card details from the slip (optional)").click();
  await page.getByLabel("Card", { exact: true }).selectOption("MADA");
  await page.getByLabel("Approval code").fill("A1B2C3");
  await page.getByLabel("Last 4 digits").fill("4242");
  await page.getByLabel("Tip").fill("5");
  await page.getByRole("button", { name: "Card approved" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();
  const receipt = await page.getByRole("link", { name: "Print receipt" }).getAttribute("href");
  await page.goto(receipt!.replace(/\/receipt$/, ""));
  await expect(page.getByTestId("card-details")).toContainText(
    "mada · •••• 4242 · Approval code A1B2C3",
  );
  await expect(page.getByText(/Tip\s+EGP\s?5\.00/)).toBeVisible();

  // The acquirer paid out 30 (25 + tip) under that approval code.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  await page.goto(`/o/${slug}/pos/settlements`);
  await expect(page.getByTestId("unsettled-count")).toHaveText("1");
  await page.getByLabel("Settlement file (CSV)").setInputFiles({
    name: "acquirer.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`date,terminal_id,approval_code,amount,fee\n${today},,A1B2C3,30.00,0.45\n`),
  });
  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText(/1 lines imported: 1 matched/)).toBeVisible();
  await expect(page.getByTestId("matched-count")).toHaveText("1");
  await expect(page.getByTestId("unsettled-count")).toHaveText("0");
  await context.close();
});
