import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { setUpRestaurant } from "./restaurant-setup";

test("table service: floor, check with a held course, fire, pay one seat then the rest", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await setUpRestaurant(page, "tables");

  // Seat two guests at T1.
  await page.goto(`/o/${slug}/pos/floor`);
  await page.getByRole("link", { name: "Table T1, free" }).click();
  // Forms submit once the page is interactive (as after page.goto).
  await expect(page).toHaveURL(/\/pos\/tables\//);
  await page.waitForLoadState("load");
  await page.getByLabel("Guests").fill("2");
  await page.getByRole("button", { name: "Open check" }).click();
  await expect(page).toHaveURL(/\/pos\/tabs\//);

  // Seat 1 a cola now; seat 2 a soup as course 2 (held until fired).
  const add = page.getByRole("region", { name: "Add items" });
  await add.getByLabel("Seat").selectOption("1");
  await add.getByRole("button", { name: /Cola/ }).click();
  await add.getByLabel("Course").selectOption("2");
  await add.getByLabel("Seat").selectOption("2");
  await add.getByRole("button", { name: /Soup/ }).click();
  await page.getByRole("button", { name: "Add 2 items to the check" }).click();
  await expect(page.getByTestId("check-line-2").getByTestId("line-status")).toHaveText("Held");
  await page.getByRole("button", { name: "Send 1 item to the kitchen" }).click();
  await expect(page.getByTestId("check-line-1").getByTestId("line-status")).toHaveText(
    "Sent to kitchen",
  );
  await page.getByRole("button", { name: "Fire course 2" }).click();
  await expect(page.getByTestId("check-line-2").getByTestId("line-status")).toHaveText(
    "Sent to kitchen",
  );

  // Seat 1 pays by card; then the rest in cash with change.
  const pay = page.getByRole("region", { name: "Payment" });
  await expect(pay.getByTestId("check-total")).toHaveText(/EGP\s?65\.00/);
  await pay.getByRole("radio", { name: "By seat" }).click();
  await pay.getByLabel("Seat").selectOption("1");
  await expect(pay.getByTestId("check-total")).toHaveText(/EGP\s?25\.00/);
  await pay.getByRole("button", { name: "Take payment" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();
  await expect(page.getByTestId("check-line-1").getByTestId("line-status")).toHaveText("Paid");
  await pay.getByRole("radio", { name: "Everything left" }).click();
  await expect(pay.getByTestId("check-total")).toHaveText(/EGP\s?40\.00/);
  await pay.getByLabel("Payment method").selectOption("CASH");
  await pay.getByLabel("Cash received").fill("50");
  await pay.getByRole("button", { name: "Take payment" }).click();
  await expect(page.getByText(/Change\s+EGP\s?10\.00/)).toBeVisible();
  await expect(page.getByText(/Check closed/)).toBeVisible();

  await page.goto(`/o/${slug}/pos/floor`);
  await expect(page.getByRole("link", { name: "Table T1, free" })).toBeVisible();
  await context.close();
});

test("kitchen display: a sent item appears on its station, is bumped, and shows ready on the check", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await setUpRestaurant(page, "kitchen");
  await page.goto(`/o/${slug}/pos/kitchen/setup`);
  await page.getByLabel("Code", { exact: true }).fill("GRILL");
  await page.getByLabel("Name", { exact: true }).fill("Grill");
  await page.getByLabel(/Default station/).check();
  await page.getByRole("button", { name: "Add station" }).click();
  await expect(page.getByTestId("station-GRILL")).toBeVisible();

  await page.goto(`/o/${slug}/pos/floor`);
  await page.getByRole("link", { name: "Table T1, free" }).click();
  await expect(page).toHaveURL(/\/pos\/tables\//);
  await page.waitForLoadState("load");
  await page.getByRole("button", { name: "Open check" }).click();
  await expect(page).toHaveURL(/\/pos\/tabs\//);
  const check = page.url();
  const add = page.getByRole("region", { name: "Add items" });
  await add.getByRole("button", { name: /Soup/ }).click();
  await page.getByRole("button", { name: "Add 1 item to the check" }).click();
  await page.getByRole("button", { name: "Send 1 item to the kitchen" }).click();
  await expect(page.getByTestId("check-line-1").getByTestId("line-status")).toHaveText("Preparing");

  await page.goto(`/o/${slug}/pos/kitchen`);
  await page.getByRole("link", { name: /Grill/ }).click();
  const ticket = page.getByTestId("ticket-T1");
  await expect(ticket).toContainText("Soup");
  await expect(ticket).toHaveAttribute("data-urgency", "ok");
  await ticket.getByRole("button", { name: "Bump — ready" }).click();
  await expect(page.getByText("No tickets — all caught up.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Recall T1" })).toBeVisible();

  await page.goto(check);
  await expect(page.getByTestId("check-line-1").getByTestId("line-status")).toHaveText("Ready");
  await context.close();
});

test("pay by QR: the Moyasar key is set up and the check offers QR payment", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await setUpRestaurant(page, "payqr");
  await page.goto(`/o/${slug}/settings/payments`);
  await expect(page.getByTestId("provider-status")).toContainText("Not set up");
  await page.getByLabel("Mode").selectOption("LIVE");
  await page.getByLabel("Secret API key").fill("sk_test_e2e-not-a-real-key");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("The key does not match the mode")).toBeVisible();
  await page.getByLabel("Mode").selectOption("TEST");
  await page.getByLabel("Secret API key").fill("sk_test_e2e-not-a-real-key");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await expect(page.getByTestId("provider-status")).toContainText("Test");
  await expect(page.getByText("sk_test_e2e-not-a-real-key")).toHaveCount(0);

  await page.goto(`/o/${slug}/pos/floor`);
  await page.getByRole("link", { name: "Table T1, free" }).click();
  await expect(page).toHaveURL(/\/pos\/tables\//);
  await page.waitForLoadState("load");
  await page.getByRole("button", { name: "Open check" }).click();
  await expect(page).toHaveURL(/\/pos\/tabs\//);
  await page
    .getByRole("region", { name: "Add items" })
    .getByRole("button", { name: /Cola/ })
    .click();
  await page.getByRole("button", { name: "Add 1 item to the check" }).click();
  const pay = page.getByRole("region", { name: "Payment" });
  await pay.getByLabel("Payment method").selectOption("QR");
  await pay.getByRole("button", { name: "Show QR to pay" }).click();
  // The key is not a real Moyasar key: the provider's refusal is shown, nothing is recorded.
  await expect(page.getByText(/The payment provider did not accept the request/)).toBeVisible();
  await expect(page.getByTestId("check-line-1").getByTestId("line-status")).toHaveText("Not sent");
  await context.close();
});
