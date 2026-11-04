import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("plan a trip, deliver with a signature and record a cold-chain excursion (ADR-116)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Fleet Lead",
    email: uniqueEmail("fleet"),
    organization: "Cold Fleet Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CK");
  await page.getByLabel("Name", { exact: true }).fill("Central kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Central kitchen" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("CKW");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen store");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen store" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("HUMMUS");
  await page.getByLabel("Name (English)").fill("Hummus");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Hummus" })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "CKW — Kitchen store" });
  await page.getByLabel("Product").selectOption({ label: "HUMMUS — Hummus (kg)" });
  await page.getByLabel("Quantity").fill("20");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Unit cost").fill("15");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  await page.goto(`/o/${slug}/b2b/customers`);
  await page.getByLabel("Code").fill("HOTEL");
  await page.getByLabel("Name", { exact: true }).fill("Nile Hotel");
  await page.getByLabel(/^Payment terms/).fill("30");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("link", { name: "HOTEL" })).toBeVisible();

  await page.goto(`/o/${slug}/b2b/orders/new`);
  await page.getByLabel("Customer", { exact: true }).selectOption({ label: "HOTEL — Nile Hotel" });
  await page.getByLabel("Ship from").selectOption({ label: "CKW — Kitchen store" });
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("heading", { name: /^SO-/ })).toBeVisible();
  const line = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await line.getByLabel("Product").selectOption({ label: "HUMMUS — Hummus (kg)" });
  await line.getByLabel("Quantity").fill("8");
  await line.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await line.getByLabel("Net price").fill("40");
  await line.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: "8 kg" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();

  // 8 kg delivered at 15 = 120 cost; invoiced 8 × 40 = 320 (no VAT set up), margin 200.
  await page.getByRole("button", { name: "Deliver" }).click();
  await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();

  await page.goto(`/o/${slug}/logistics/vehicles`);
  const vehicle = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add vehicle" }) });
  await vehicle.getByLabel("Code").fill("R1");
  await vehicle.getByLabel("Plate number").fill("ABC 1234");
  await vehicle.getByLabel("Based at").selectOption({ label: "CKW — Kitchen store" });
  await vehicle.getByLabel(/^Lowest/).fill("0");
  await vehicle.getByLabel(/^Highest/).fill("5");
  await vehicle.getByLabel("Refrigerated").check();
  await vehicle.getByRole("button", { name: "Add vehicle" }).click();
  await expect(page.getByRole("cell", { name: "ABC 1234" })).toBeVisible();

  await page.goto(`/o/${slug}/logistics/trips/new`);
  await page.getByLabel("Vehicle").selectOption({ index: 1 });
  await page.getByLabel("Driver").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Plan trip" }).click();
  await expect(page.getByRole("heading", { name: /^TRP-.* — R1$/ })).toBeVisible();
  await page.getByLabel("Customer delivery from this warehouse").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add stop" }).click();
  await expect(page.getByTestId("stop-1").getByText("HOTEL — Nile Hotel")).toBeVisible();
  await page.getByRole("button", { name: "Start trip" }).click();
  await expect(page.getByText("On the road", { exact: true })).toBeVisible();

  const reading = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Record reading" }) });
  await reading.getByLabel("Temperature (°C)").fill("8.5");
  await reading.getByRole("button", { name: "Record reading" }).click();
  await expect(page.getByText("Out of range")).toBeVisible();

  const stop = page.getByTestId("stop-1");
  await stop.getByLabel("Received by").fill("Front desk");
  await stop.getByLabel(/^Temperature at handover/).fill("4");
  const pad = await stop.getByTestId("signature-pad").boundingBox();
  await page.mouse.move(pad!.x + 20, pad!.y + 60);
  await page.mouse.down();
  await page.mouse.move(pad!.x + 120, pad!.y + 30, { steps: 5 });
  await page.mouse.move(pad!.x + 220, pad!.y + 90, { steps: 5 });
  await page.mouse.up();
  await stop.getByRole("button", { name: "Confirm delivery" }).click();
  await expect(stop.getByText("Received by Front desk", { exact: false })).toBeVisible();
  await expect(stop.locator("svg path").first()).toHaveAttribute("d", /^M \d+ \d+ L/);

  await page.getByRole("button", { name: "Complete trip" }).click();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/1 temperature excursion/).first()).toBeVisible();
  await context.close();
});
