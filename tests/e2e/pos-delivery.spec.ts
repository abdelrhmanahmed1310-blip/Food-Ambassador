import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
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
  await context.close();
});
