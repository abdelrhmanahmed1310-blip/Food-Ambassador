import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { newClient, orgDate } from "./helpers";
import { openTill } from "./pos-setup";

test("delivery: a platform order is mapped, accepted and recorded (ADR-069)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "pos-delivery");
  await expect(page.getByRole("link", { name: "Open till" })).toBeVisible();

  // Connect HungerStation to the till; the address and secret are shown once.
  await page.goto(`/o/${slug}/pos/delivery/setup`);
  await expect(page.getByText("No delivery platforms connected yet.")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("HungerStation Cairo");
  await page.getByLabel("Platform").selectOption("HUNGERSTATION");
  await page.getByLabel(/^Register/).selectOption({ label: "TILL1 — Front till (Cairo)" });
  await page.getByRole("button", { name: "Connect a platform" }).click();
  const endpoint = await page.getByLabel("Endpoint URL").inputValue();
  const secret = await page.getByLabel("Signing secret").inputValue();
  expect(secret.length).toBeGreaterThan(20);

  // The platform (or its middleware) sends an order, signed.
  const body = JSON.stringify({
    event: "order.placed",
    order: {
      id: "HS-5001",
      displayCode: "#501",
      placedAt: new Date().toISOString(),
      customerName: "Omar",
      items: [{ externalId: "HS-COLA", name: "Cola can", quantity: 2, unitPrice: "22" }],
      total: "44",
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const response = await page.request.post(new URL(endpoint).pathname, {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-fa-timestamp": timestamp,
      "x-fa-signature": signature,
      "idempotency-key": `evt-${randomUUID()}`,
    },
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).status).toBe("NEEDS_MAPPING");

  // The item is mapped to the menu, then the branch accepts the order.
  await page.goto(`/o/${slug}/pos/delivery`);
  const order = page.getByTestId("delivery-order").filter({ hasText: "#501" });
  await expect(order).toContainText("Needs mapping");
  await expect(order).toContainText("Omar");
  await order.getByRole("link", { name: "Map the items to the menu" }).click();
  await page.getByLabel("Cola can (HS-COLA)").selectOption({ label: "COLA — Cola" });
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await expect(page.getByRole("cell", { name: "HS-COLA" })).toBeVisible();

  await page.goto(`/o/${slug}/pos/delivery`);
  await expect(order).toContainText("Waiting");
  await order.getByRole("button", { name: "Accept" }).click();
  await expect(order).toContainText("Accepted");
  await order.getByRole("link", { name: /^POS-/ }).click();
  await expect(page.getByText("Delivery platform").first()).toBeVisible();
  await expect(page.getByText(/HUNGERSTATION #501 · Omar/)).toBeVisible();

  // Finance imports the platform's statement and reconciles it (ADR-075).
  await page.goto(`/o/${slug}/pos/delivery`);
  await page.getByRole("link", { name: "Payouts" }).click();
  const today = orgDate();
  const yesterday = orgDate(-1);
  const tomorrow = orgDate(1);
  await page.getByLabel("Statement reference").fill("HS-W44");
  await page.getByLabel("Orders from").fill(yesterday);
  await page.getByLabel("Orders until").fill(tomorrow);
  await page.getByLabel("Paid on").fill(today);
  await page.getByLabel(/^Received in the bank/).fill("25.00");
  await page.getByLabel("Statement (CSV)").setInputFiles({
    name: "hs-w44.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "order_id,description,gross,commission,fees,vat_on_fees,net\n" +
        "HS-5001,,44.00,8.80,1.00,1.47,32.73\n" +
        "HS-9999,,20.00,4.00,0,0.60,15.40\n" +
        ",Marketing campaign,0,0,10.00,1.50,-11.50\n",
    ),
  });
  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByRole("heading", { name: "Statement HS-W44" })).toBeVisible();
  const lines = page.getByTestId("payout-line");
  await expect(lines.filter({ hasText: "HS-5001" })).toContainText("Matches");
  await expect(
    lines.filter({ hasText: "HS-5001" }).getByRole("link", { name: /^POS-/ }),
  ).toBeVisible();
  await expect(lines.filter({ hasText: "HS-9999" })).toContainText("Order not received");
  await expect(lines.filter({ hasText: "Marketing campaign" })).toContainText("Adjustment");
  const summary = page.getByTestId("payout-summary");
  await expect(summary).toContainText(/EGP\s?36\.63/); // net
  await expect(summary).toContainText(/-EGP\s?11\.63|EGP\s?-11\.63/); // bank minus statement
  await expect(page.getByText("None.")).toBeVisible();

  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Confirm statement" }).click();
  await expect(summary).toContainText("Confirmed");
  await expect(page.getByRole("button", { name: "Confirm statement" })).toHaveCount(0);
  await page.goto(`/o/${slug}/pos/delivery/payouts`);
  await expect(page.getByRole("row").filter({ hasText: "HS-W44" })).toContainText("Confirmed");
  await context.close();
});
