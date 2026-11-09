import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

// Values are placeholders for the test; the app never ships nutrition data.
test("nutrition engine: own food, serving calculator without guessing, quality and Arabic (ADR-132)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Nutrition Lead",
    email: uniqueEmail("nutrition-engine"),
    organization: "Engine Foods",
  });
  await page.goto(`/o/${slug}`);
  await page.getByRole("link", { name: "Nutrition", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Nutrition", exact: true })).toBeVisible();
  // No USDA key in this environment: the library keeps working on its own.
  await expect(page.getByText(/Live USDA FoodData Central is not connected/)).toBeVisible();
  await expect(page.getByTestId("nutrition-stats")).toContainText("0");

  // A food of our own, from a label; carbohydrate is left empty (unknown).
  await page.getByRole("link", { name: "Foods", exact: true }).click();
  await page.getByRole("link", { name: "New food" }).click();
  await page.getByLabel("Name (English)").fill("Test labneh");
  await page.getByLabel("Name (Arabic)").fill("لبنة تجريبية");
  await page.getByLabel("Energy (kcal)", { exact: true }).fill("160");
  await page.getByLabel("Protein (g)", { exact: true }).fill("6");
  await page.getByLabel("Total lipid (fat) (g)", { exact: true }).fill("11");
  await page.getByRole("button", { name: "Create food" }).click();
  await expect(page.getByRole("heading", { name: "Test labneh" })).toBeVisible();
  await expect(page.getByTestId("nutrient-protein")).toContainText("6 g");
  // Not given is shown as such — never as zero.
  await expect(page.getByTestId("missing-core")).toContainText("Carbohydrate");

  // Serving calculator: grams scale; millilitres need the food's own density.
  await page.getByLabel("Quantity").fill("50");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.getByTestId("calc-result")).toContainText("3 g");
  await page.getByLabel("Quantity").fill("100");
  await page.getByLabel("Unit").selectOption("ml");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.getByText(/so volume cannot be converted to weight/)).toBeVisible();
  await page.getByLabel("Description", { exact: true }).fill("1 cup");
  await page.getByLabel("Grams").fill("250");
  await page.getByLabel("Millilitres").fill("240");
  await page.getByRole("button", { name: "Add serving" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await page.getByLabel("Quantity").fill("240");
  await page.getByLabel("Unit").selectOption("ml");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.getByTestId("calc-result")).toContainText("250 g");
  await expect(page.getByTestId("calc-result")).toContainText("15 g");

  // Verify, then find it from the search by its Arabic name.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Mark verified" }).click();
  await expect(page.getByRole("button", { name: "Remove verification" })).toBeVisible();
  await page.goto(`/o/${slug}/nutrition/foods?q=${encodeURIComponent("لبنة")}`);
  await expect(page.getByTestId("food-row")).toHaveCount(1);
  await expect(
    page.getByText(/USDA FoodData Central is not connected, so only your library/),
  ).toBeVisible();

  // Dictionary, quality scan, sources and the API reference.
  await page.goto(`/o/${slug}/nutrition/nutrients?q=vitamin`);
  await expect(page.getByTestId("nutrient-row").first()).toBeVisible();
  await page.goto(`/o/${slug}/nutrition/quality`);
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByText(/Scan done: 0 new findings/)).toBeVisible();
  await page.goto(`/o/${slug}/nutrition/sources`);
  await expect(page.getByTestId("source-priority")).toContainText(
    "Laboratory analysis of the product",
  );
  await page.goto(`/o/${slug}/settings/api/reference`);
  await expect(page.getByText("/api/v1/nutrition/foods/search")).toBeVisible();

  // Arabic interface, right to left, with the Arabic food name.
  await page.goto(`/o/${slug}/nutrition/foods`);
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "الأغذية" })).toBeVisible();
  await expect(page.getByRole("link", { name: "لبنة تجريبية" })).toBeVisible();
  await context.close();
});
