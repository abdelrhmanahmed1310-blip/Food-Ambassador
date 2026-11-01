import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("customers: loyalty points and gift cards on the till (ADR-068)", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "pos-customers");
  await expect(page.getByRole("link", { name: "Open till" })).toBeVisible();

  // 1 point per pound paid, a point is worth 0.10, spend at least 10.
  await page.goto(`/o/${slug}/pos/customers`);
  await expect(page.getByText("No customers yet.")).toBeVisible();
  await page.getByLabel("Customers earn and spend points").check();
  await page.getByLabel(/^Points per 1 of the currency/).fill("1");
  await page.getByLabel(/^Value of one point/).fill("0.1");
  await page.getByLabel(/^Minimum points to spend/).fill("10");
  await page.getByRole("button", { name: "Save" }).last().click();
  await expect(page.getByRole("button", { name: "Save" }).last()).toBeEnabled();
  await expect
    .poll(async () => {
      await page.reload();
      return page.getByLabel(/^Value of one point/).inputValue();
    })
    .toBe("0.1");

  const till = async () => {
    await page.goto(`/o/${slug}/pos`);
    await page.getByRole("link", { name: "TILL1" }).click();
    await page.getByRole("link", { name: "Open till" }).click();
    await page.waitForLoadState("load");
  };
  await till();

  // A new customer added at the till earns 25 points on a cola.
  await page.getByRole("button", { name: /Cola/ }).first().click();
  await page.getByText("Customer", { exact: true }).click();
  await page.getByLabel("Phone number").fill("0501234567");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByLabel("Customer name").fill("Sara");
  await page.getByLabel("The customer agrees to receive offers").check();
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByTestId("till-customer")).toContainText("Sara · 0 points");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByLabel("Cash received").fill("25");
  await page.getByRole("button", { name: "Take payment" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();

  // Sell a 50 gift card for cash; its code is shown once.
  await page.getByText("Sell a gift card").click();
  await page.getByLabel("Value", { exact: true }).fill("50");
  await page.getByRole("button", { name: /^Sell for/ }).click();
  const code = (await page.getByTestId("gift-card-code").textContent())!.replace(/\s/g, "");
  expect(code).toMatch(/^\d{16}$/);
  await page.getByRole("button", { name: "Done" }).click();

  // Three colas (75): 20 points take 2.00 off, the gift card pays 50, the card the rest.
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: /Cola/ }).first().click();
  await page.getByText("Customer", { exact: true }).click();
  await page.getByLabel("Phone number").fill("050 123 4567");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByTestId("till-customer")).toContainText("Sara · 25 points");
  await page.getByLabel("Points to spend").fill("20");
  await page.getByRole("button", { name: "Use points" }).click();
  await expect(page.getByTestId("till-total")).toHaveText(/EGP\s?73\.00/);
  await page.getByRole("button", { name: "Gift card", exact: true }).click();
  await page.getByLabel("Gift card code").fill(code);
  await page.getByRole("button", { name: "Use card" }).click();
  await expect(page.getByTestId("till-due")).toHaveText(/EGP\s?23\.00/);
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByRole("button", { name: "Card approved" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();
  const receiptHref = await page.getByRole("link", { name: "Print receipt" }).getAttribute("href");

  await page.goto(receiptHref!);
  await expect(page.getByText(`Gift card •••• ${code.slice(-4)}`)).toBeVisible();
  await expect(page.getByText(/Points earned\s*\+73/)).toBeVisible();
  await page.goto(receiptHref!.replace(/\/receipt$/, ""));
  await expect(page.getByTestId("order-discount")).toContainText("20 points");

  // The gift card is spent; the customer has 25 − 20 + 73 = 78 points.
  await page.goto(`/o/${slug}/pos/gift-cards`);
  await expect(page.getByTestId("gift-owed")).toHaveText(/EGP\s?0\.00/);
  await page.goto(`/o/${slug}/pos/customers`);
  await page.getByRole("link", { name: "Sara" }).click();
  await expect(page.getByTestId("customer-points")).toHaveText("78");

  // Erasing removes the personal data.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Erase personal data" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/pos/customers$`));
  await expect(page.getByText("No customers yet.")).toBeVisible();
  await context.close();
});
