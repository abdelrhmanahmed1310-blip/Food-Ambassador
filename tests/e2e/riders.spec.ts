import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("a delivery order sent with an address, assigned, picked up and delivered by the rider (ADR-117)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "riders");

  // The cola also sells for delivery at 25.
  await page.goto(`/o/${slug}/menu`);
  await page.getByRole("link", { name: /COLA/ }).first().click();
  const price = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add price" }) });
  await price.getByLabel("Channel").selectOption("DELIVERY");
  await price.getByLabel(/^Price/).fill("25");
  await price.getByRole("button", { name: "Add price" }).click();
  await expect(page.getByRole("cell", { name: "Delivery" }).first()).toBeVisible();

  await page.goto(`/o/${slug}/pos`);
  await page.getByRole("link", { name: "TILL1" }).click();
  await page.getByRole("link", { name: "Open till" }).click();
  await page.getByRole("tab", { name: "Delivery" }).click();
  await page.getByRole("button", { name: /Cola/ }).first().click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByLabel("Cash received").fill("25");
  await page.getByRole("button", { name: "Take payment" }).click();
  const paid = page.getByText(/Order POS-\d{4}-\d+ paid\./);
  await expect(paid).toBeVisible();
  const number = (await paid.textContent())!.match(/POS-\d{4}-\d+/)![0];

  await page.goto(`/o/${slug}/pos/dispatch`);
  const order = page.getByTestId(`order-${number}`);
  await order.getByLabel(/^Customer name/).fill("Sara");
  await order.getByLabel("Phone").fill("+20 100 123 4567");
  await order.getByLabel("Address", { exact: true }).fill("12 Tahrir Sq, Cairo");
  await order.getByRole("button", { name: "Send for delivery" }).click();
  const delivery = page.getByTestId(`delivery-${number}`);
  await expect(delivery.getByText("Waiting for a rider")).toBeVisible();
  await delivery.getByLabel("Rider").selectOption({ index: 1 });
  await delivery.getByRole("button", { name: "Assign" }).click();
  await expect(delivery.getByText("Assigned", { exact: true })).toBeVisible();

  // The owner rides too (administrators may deliver).
  await page.goto(`/o/${slug}/pos/rider`);
  const ride = page.getByTestId(`ride-${number}`);
  await expect(ride.getByText("12 Tahrir Sq, Cairo")).toBeVisible();
  await expect(ride.getByRole("link", { name: "Open in maps" })).toHaveAttribute(
    "href",
    /google\.com\/maps\/search/,
  );
  await expect(ride.getByRole("link", { name: "+20 100 123 4567" })).toHaveAttribute(
    "href",
    "tel:+201001234567",
  );
  page.once("dialog", (d) => d.accept());
  await ride.getByRole("button", { name: "Picked up" }).click();
  await expect(ride.getByText("On the way")).toBeVisible();
  await ride.getByLabel(/^Received by/).fill("Sara");
  await ride.getByRole("button", { name: "Delivered", exact: true }).click();
  await expect(page.getByText("Nothing to deliver.")).toBeVisible();

  await page.goto(`/o/${slug}/pos/dispatch`);
  await expect(page.getByRole("cell", { name: "Sara" })).toBeVisible();
  await expect(page.getByTestId("rider-Owner").getByRole("cell").nth(2)).toHaveText("1");
  await context.close();
});
