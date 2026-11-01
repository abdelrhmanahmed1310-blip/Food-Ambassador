import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("menu: category, item from a product, channel prices, modifiers, branch availability", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("menu"),
    organization: "Menu Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("COLA");
  await page.getByLabel("Name (English)").fill("Cola can");
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cola can" })).toBeVisible();

  await page.goto(`/o/${slug}/menu`);
  await expect(page.getByText("No menu categories yet.")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Drinks");
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByRole("heading", { name: "Drinks" })).toBeVisible();

  await page.getByRole("link", { name: "New menu item" }).click();
  await page.getByLabel("Code", { exact: true }).fill("COLA");
  await page.getByLabel("Name", { exact: true }).fill("Cola");
  await page.getByLabel("Category").selectOption({ label: "Drinks" });
  await page.getByLabel("Uses").selectOption("PRODUCT");
  await page
    .getByLabel("Product", { exact: true })
    .selectOption({ label: "COLA — Cola can (each)" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "COLA — Cola" })).toBeVisible();
  await expect(page.getByText("No prices yet")).toBeVisible();

  // Dine-in 25, takeaway 22.
  const priceForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add price" }) });
  await priceForm.getByLabel(/^Price/).fill("25");
  await priceForm.getByRole("button", { name: "Add price" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?25\.00/ })).toBeVisible();
  await priceForm.getByLabel("Channel").selectOption("TAKEAWAY");
  await priceForm.getByLabel(/^Price/).fill("22");
  await priceForm.getByRole("button", { name: "Add price" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?22\.00/ })).toBeVisible();

  // A modifier group with one option, attached to the item.
  await page.goto(`/o/${slug}/menu/modifiers`);
  const groupForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add modifier group" }) });
  await groupForm.getByLabel("Name", { exact: true }).fill("Ice");
  await groupForm.getByRole("button", { name: "Add modifier group" }).click();
  const group = page.getByTestId("group-Ice");
  await group.getByLabel("Option", { exact: true }).fill("No ice");
  await group.getByRole("button", { name: "Add option" }).click();
  await expect(group.getByText("No ice")).toBeVisible();
  await page.goto(`/o/${slug}/menu`);
  await expect(page.getByTestId("menu-item-COLA")).toContainText(/25\.00/);
  await expect(page.getByTestId("menu-item-COLA")).toContainText(/22\.00/);
  await page.getByRole("link", { name: "COLA" }).click();
  const attach = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add modifier group" }) });
  await attach.getByLabel("Modifier group").selectOption({ label: "Ice" });
  await attach.getByRole("button", { name: "Add modifier group" }).click();
  await expect(page.getByText(/No ice \(\+/)).toBeVisible();

  // Not offered at the Cairo branch, then offered again.
  const cairo = page.getByTestId("availability-CAI-01");
  await expect(cairo).toContainText("Offered");
  await cairo.getByRole("button", { name: "Stop offering here" }).click();
  await expect(cairo).toContainText("Not offered");
  await cairo.getByRole("button", { name: "Offer here" }).click();
  await expect(cairo).toContainText("Offered");
  await context.close();
});
