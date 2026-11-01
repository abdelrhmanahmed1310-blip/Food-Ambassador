import { expect, test, type Page } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

async function product(page: Page, slug: string, sku: string, name: string) {
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill(sku);
  await page.getByLabel("Name (English)").fill(name);
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function menuItem(
  page: Page,
  slug: string,
  code: string,
  name: string,
  sku: string,
  price: string,
) {
  await page.goto(`/o/${slug}/menu/items/new`);
  await page.getByLabel("Code", { exact: true }).fill(code);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Category").selectOption({ label: "Dining" });
  await page.getByLabel("Uses").selectOption("PRODUCT");
  await page
    .getByLabel("Product", { exact: true })
    .selectOption({ label: `${sku} — ${name} (each)` });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: `${code} — ${name}` })).toBeVisible();
  const priceForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add price" }) });
  await priceForm.getByLabel(/^Price/).fill(price);
  await priceForm.getByRole("button", { name: "Add price" }).click();
  await expect(page.getByRole("cell", { name: new RegExp(`EGP\\s?${price}\\.00`) })).toBeVisible();
}

/** A branch with a kitchen, cola (25) and soup (40), a register with an open shift, floor "Main hall" with T1. */
async function setUpRestaurant(page: Page, label: string) {
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail(label),
    organization: "Table Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("KIT");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  await product(page, slug, "COLA", "Cola");
  await product(page, slug, "SOUP", "Soup");
  await page.goto(`/o/${slug}/menu`);
  await page.getByLabel("Name", { exact: true }).fill("Dining");
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByRole("heading", { name: "Dining" })).toBeVisible();
  await menuItem(page, slug, "COLA", "Cola", "COLA", "25");
  await menuItem(page, slug, "SOUP", "Soup", "SOUP", "40");

  // A register with an open shift to take payments.
  await page.goto(`/o/${slug}/pos`);
  await page.getByLabel("Code", { exact: true }).fill("TILL1");
  await page.getByLabel("Name", { exact: true }).fill("Front till");
  await page.getByLabel("Stock warehouse").selectOption({ label: "KIT — Kitchen" });
  await page.getByRole("button", { name: "Add register" }).click();
  await page.getByLabel(/^Opening float/).fill("0");
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByRole("link", { name: "Open till" })).toBeVisible();

  // A floor with two tables.
  await page.goto(`/o/${slug}/pos/floors`);
  await page.getByLabel("Floor name").fill("Main hall");
  await page.getByLabel("Kitchen stock warehouse").selectOption({ label: "KIT — Kitchen" });
  await page.getByRole("button", { name: "Add floor" }).click();
  const floor = page.getByTestId("floor-Main hall");
  await floor.getByLabel("Table", { exact: true }).fill("T1");
  await floor.getByLabel("Seats").fill("4");
  await floor.getByRole("button", { name: "Add table" }).click();
  await expect(floor.getByText("T1")).toBeVisible();

  return slug;
}

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
