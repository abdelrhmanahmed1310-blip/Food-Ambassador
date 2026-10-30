import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("requisition: branch request → buyer orders from a supplier", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Head Buyer",
    email: uniqueEmail("req"),
    organization: "Requesting Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("KITCH");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("OIL");
  await page.getByLabel("Name (English)").fill("Sunflower oil");
  await page.getByLabel("Base unit").selectOption({ label: "l — Litre" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Sunflower oil" })).toBeVisible();
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("oils-co");
  await page.getByLabel("Name", { exact: true }).fill("Oils Co");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Oils Co" })).toBeVisible();

  // The branch asks for 40 l of oil.
  await page.goto(`/o/${slug}/purchasing/requisitions`);
  await page.getByRole("link", { name: "New requisition" }).click();
  await page.getByLabel("Needed by").fill("2026-11-10");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^REQ-\d{4}-\d{6}$/ })).toBeVisible();
  const line = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await line.getByLabel("Product").selectOption({ label: "OIL — Sunflower oil (l)" });
  await line.getByLabel("Quantity").fill("40");
  await line.getByLabel("Unit", { exact: true }).selectOption({ label: "l — Litre" });
  await line.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: "40 l" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit to purchasing" }).click();
  await expect(page.getByText("Submitted", { exact: true })).toBeVisible();

  // The buyer orders it: supplier, price, draft order.
  await page.getByLabel("Supplier").selectOption({ label: "OILS-CO — Oils Co" });
  await page.getByRole("button", { name: "Use this supplier" }).click();
  await page.getByRole("button", { name: "Create draft order" }).click();
  await expect(page.getByText("This field is required.")).toBeVisible();
  await page.getByLabel(/^Unit price/).fill("55");
  await page.getByRole("button", { name: "Create draft order" }).click();
  await expect(page.getByRole("heading", { name: /^PO-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /EGP\s?2,200\.00/ })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();

  await page.goto(`/o/${slug}/purchasing/requisitions?status=ORDERED`);
  await page.getByRole("link", { name: /^REQ-/ }).click();
  await expect(page.getByRole("heading", { name: /^REQ-/ })).toBeVisible();
  await expect(page.getByText("Ordered", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^PO-/ })).toBeVisible();
  await context.close();
});
