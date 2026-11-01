import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("discounts: a promotion, a coupon and a manual discount on the till (ADR-067)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "pos-discounts");
  await expect(page.getByRole("link", { name: "Open till" })).toBeVisible();

  // 20 % off drinks, and a coupon for 5 off the order, used once.
  await page.goto(`/o/${slug}/pos/promotions`);
  await expect(page.getByText("No promotions yet.")).toBeVisible();
  const promo = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add promotion", exact: true }) });
  await promo.getByLabel("Name", { exact: true }).fill("Drinks 20");
  await promo.getByLabel("Percent off").fill("20");
  await promo.getByRole("checkbox", { name: "Drinks" }).check();
  await promo.getByRole("button", { name: "Add promotion", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Drinks 20" })).toBeVisible();
  const coupon = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add coupon", exact: true }) });
  await coupon.getByLabel("Code", { exact: true }).fill("save5");
  await coupon.getByLabel("Type").selectOption("AMOUNT");
  await coupon.getByLabel("Value").fill("5");
  await coupon.getByLabel(/^Maximum uses/).fill("1");
  await coupon.getByRole("button", { name: "Add coupon", exact: true }).click();
  await expect(page.getByRole("cell", { name: "SAVE5" })).toBeVisible();

  // On the till: cola 25 − 20 % = 20; the coupon takes 5 more.
  await page.goto(`/o/${slug}/pos`);
  await page.getByRole("link", { name: "TILL1" }).click();
  await page.getByRole("link", { name: "Open till" }).click();
  await page.waitForLoadState("load");
  await page.getByRole("button", { name: /Cola/ }).first().click();
  await expect(page.getByTestId("till-promotions")).toHaveText(/EGP\s?5\.00/);
  await expect(page.getByTestId("till-total")).toHaveText(/EGP\s?20\.00/);
  await page.getByText("Discount", { exact: true }).click();
  await page.getByLabel("Coupon code").fill("SAVE5");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByTestId("discount-chosen")).toContainText("Coupon SAVE5");
  await expect(page.getByTestId("till-total")).toHaveText(/EGP\s?15\.00/);
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByLabel("Cash received").fill("20");
  await page.getByRole("button", { name: "Take payment" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();
  await expect(page.getByText(/Change:\s+EGP\s?5\.00/)).toBeVisible();
  const receiptHref = await page.getByRole("link", { name: "Print receipt" }).getAttribute("href");

  // The coupon is used up.
  await page.getByRole("button", { name: /Cola/ }).first().click();
  await page.getByText("Discount", { exact: true }).click();
  await page.getByLabel("Coupon code").fill("SAVE5");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("This coupon has been used up.")).toBeVisible();

  // A manager's 100 % discount with a reason: nothing to pay.
  await page.getByLabel("Type").selectOption("PERCENT");
  await page.getByLabel("Value").fill("100");
  await page.getByLabel("Reason").fill("Staff meal");
  await page.getByRole("button", { name: "Apply discount" }).click();
  await expect(page.getByTestId("till-total")).toHaveText(/EGP\s?0\.00/);
  await page.getByRole("button", { name: "Complete (nothing to pay)" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();

  // The receipt shows what was taken off.
  await page.goto(receiptHref!);
  await expect(page.getByText(/1 × Cola/)).toBeVisible();
  await expect(page.getByText(/Promotions\s*−\s*EGP\s?5\.00/)).toBeVisible();
  await expect(page.getByText(/Coupon SAVE5\s*−\s*EGP\s?5\.00/)).toBeVisible();

  await page.goto(`/o/${slug}/pos/promotions`);
  const row = page.getByRole("row", { name: /SAVE5/ });
  await expect(row.getByRole("cell", { name: "1 / 1" })).toBeVisible();
  await context.close();
});
