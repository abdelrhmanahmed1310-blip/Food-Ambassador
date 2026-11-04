import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { setUpRestaurant } from "./restaurant-setup";

test("kitchen performance shows a bumped ticket against its station target (ADR-108)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await setUpRestaurant(page, "kitchen-report");
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

  await page.goto(`/o/${slug}/reports/kitchen`);
  await expect(page.getByRole("heading", { name: "Kitchen performance" })).toBeVisible();
  const totals = page.getByTestId("kitchen-totals");
  await expect(totals.getByText("100.0 %")).toBeVisible();
  const row = page.getByRole("row", { name: /Grill/ });
  await expect(row.getByRole("cell", { name: "12 min" })).toBeVisible();
  await expect(page.getByTestId("kitchen-hours").getByRole("listitem")).toHaveCount(1);
  await context.close();
});
