import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("a guest rates an order from the receipt link; a manager reviews it; a segment is saved (ADR-118)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "feedback");
  await page.getByRole("link", { name: "Open till" }).click();
  await page.getByRole("button", { name: /Cola/ }).first().click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByLabel("Cash received").fill("25");
  await page.getByRole("button", { name: "Take payment" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();
  const receiptHref = await page.getByRole("link", { name: "Print receipt" }).getAttribute("href");
  await page.goto(receiptHref!);
  await expect(page.getByTestId("feedback-qr").locator("svg")).toBeVisible();
  const link = await page
    .getByRole("link", { name: "Scan or tap to rate this order" })
    .getAttribute("href");

  // The guest, signed out, on their phone.
  const guest = await browser.newContext();
  const g = await guest.newPage();
  await g.goto(new URL(link!).pathname);
  await expect(g.getByRole("heading", { name: "How was your order at Cairo?" })).toBeVisible();
  await g.getByRole("radio", { name: "2 stars" }).click();
  await g.getByLabel(/^Anything to tell us/).fill("Cola was warm");
  await g.getByRole("button", { name: "Send" }).click();
  await expect(g.getByText("Thank you — we read every rating.")).toBeVisible();
  await g.reload();
  await expect(g.getByText("this order has already been rated")).toBeVisible();
  await g.goto(new URL(link!).pathname.replace(/\.[^.]+$/, ".forged0000000000000000"));
  await expect(g.getByText(/could not be found|404/i).first()).toBeVisible();
  await guest.close();

  await page.goto(`/o/${slug}/pos/customers/feedback`);
  await expect(page.getByTestId("feedback-summary").getByText("2.0")).toBeVisible();
  await expect(page.getByText("Cola was warm")).toBeVisible();
  await expect(page.getByText("To review")).toBeVisible();
  await page.getByLabel(/^What was done/).fill("Fridge fixed");
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();

  await page.goto(`/o/${slug}/pos/customers/segments`);
  await expect(page.getByTestId("rfm-CHAMPIONS")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Lapsed regulars");
  await page.getByLabel(/^At least orders/).fill("3");
  await page.getByLabel(/^Not visited for/).fill("45");
  await page.getByRole("button", { name: "Save segment" }).click();
  await expect(page.getByRole("heading", { name: "Lapsed regulars" })).toBeVisible();
  await expect(page.getByTestId("segment-count")).toHaveText("0 customers, 0 agreed to offers");
  await context.close();
});
