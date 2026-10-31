import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("production: a preparation made in the central kitchen enters stock at the value of its ingredients", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Kitchen Lead",
    email: uniqueEmail("production"),
    organization: "Central Kitchen Co",
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
  for (const [sku, name] of [
    ["TOMATO", "Tomato"],
    ["SAUCE-K", "Sauce batch"],
  ]) {
    await page.goto(`/o/${slug}/catalog/products/new`);
    await page.getByLabel("SKU").fill(sku);
    await page.getByLabel("Name (English)").fill(name);
    await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "CKW — Kitchen store" });
  await page.getByLabel("Product").selectOption({ label: "TOMATO — Tomato (kg)" });
  await page.getByLabel("Quantity").fill("10");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Unit cost").fill("20");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  // Sauce: 2 kg from 2 kg tomato.
  await page.goto(`/o/${slug}/recipes/new`);
  await page.getByLabel("Code").fill("SAUCE");
  await page.getByLabel("Type").selectOption("PREPARATION");
  await page.getByLabel("Name (English)").fill("Tomato sauce");
  await page.getByLabel("Yield quantity").fill("2");
  await page.getByLabel("Yield unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  const ingredient = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add ingredient" }) });
  await ingredient.getByLabel("Ingredient").selectOption({ label: "TOMATO — Tomato (kg)" });
  await ingredient.getByLabel("Net quantity").fill("2");
  await ingredient.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await ingredient.getByRole("button", { name: "Add ingredient" }).click();
  await expect(page.getByRole("cell", { name: /TOMATO/ }).first()).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Activate version" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await page.goto(page.url().replace(/\/versions\/.*$/, ""));
  const produces = page.locator("form").filter({ has: page.getByLabel(/^Product made/) });
  await produces.getByLabel(/^Product made/).selectOption({ label: "SAUCE-K — Sauce batch" });
  await produces.getByRole("button", { name: "Save" }).click();
  await expect(produces.getByText("Changes saved.")).toBeVisible();

  // Too big a batch is refused with the shortage; a 4 kg batch uses 4 kg of tomato (80.00).
  await page.goto(`/o/${slug}/production/new`);
  await page
    .getByLabel("Preparation")
    .selectOption({ label: "SAUCE — Tomato sauce (batch of 2 kg)" });
  await page.getByLabel("Production site").selectOption({ label: "CKW — Kitchen store" });
  await page.getByLabel(/^Planned quantity/).fill("40");
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("heading", { name: /^PRD-/ })).toBeVisible();
  await expect(page.getByTestId("needed-TOMATO")).toContainText("10 kg");
  await page.getByRole("button", { name: "Record as made" }).click();
  await expect(page.getByText(/Not enough usable stock for: TOMATO/)).toBeVisible();
  await page.getByLabel("Reason").fill("Too big");
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();

  await page.goto(`/o/${slug}/production/new`);
  await page
    .getByLabel("Preparation")
    .selectOption({ label: "SAUCE — Tomato sauce (batch of 2 kg)" });
  await page.getByLabel("Production site").selectOption({ label: "CKW — Kitchen store" });
  await page.getByLabel(/^Planned quantity/).fill("4");
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("heading", { name: /^PRD-/ })).toBeVisible();
  await page.getByRole("button", { name: "Record as made" }).click();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("produced")).toHaveText("4 kg");
  await expect(page.getByTestId("production-cost")).toHaveText(/80\.00/);

  await page.goto(`/o/${slug}/inventory/valuation`);
  await expect(page.getByTestId("total-value")).toHaveText(/EGP\s?200\.00/); // 6 kg tomato 120 + 4 kg sauce 80
  await context.close();
});
