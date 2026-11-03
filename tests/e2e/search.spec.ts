import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("global search: find a product from the header and open it (ADR-088)", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("search"),
    organization: "Search Foods",
  });
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("TAHINI");
  await page.getByLabel("Name (English)").fill("Tahini paste");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Tahini paste" })).toBeVisible();

  const box = page.locator("#global-search");
  await box.fill("tahin");
  await box.press("Enter");
  await expect(page.getByRole("heading", { name: "Search", exact: true })).toBeVisible();
  const products = page.getByTestId("search-products");
  await expect(products).toContainText("TAHINI");
  await products.getByRole("link", { name: /Tahini paste/ }).click();
  await expect(page.getByRole("heading", { name: "Tahini paste" })).toBeVisible();

  await page.goto(`/o/${slug}/search?q=nothing-like-this`);
  await expect(page.getByText("Nothing found for “nothing-like-this”.")).toBeVisible();
  await context.close();
});
