import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("stock ageing and turnover from real stock (ADR-106)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("stock-health"),
    organization: "Ageing Foods",
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
  await page.getByLabel("SKU").fill("TAHINI");
  await page.getByLabel("Name (English)").fill("Tahini");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Tahini" })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "CKW — Kitchen store" });
  await page.getByLabel("Product").selectOption({ label: "TAHINI — Tahini (kg)" });
  await page.getByLabel("Quantity").fill("12");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Unit cost").fill("25");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  await page.goto(`/o/${slug}/reports/stock`);
  await expect(page.getByRole("heading", { name: "Stock ageing and turnover" })).toBeVisible();
  const totals = page.getByTestId("stock-totals");
  await expect(totals.getByText(/300\.00/)).toHaveCount(2); // value now and at period end
  await expect(page.getByText("No use in period")).toBeVisible();
  await expect(page.getByRole("cell", { name: "12 kg" })).toBeVisible();
  const csv = await page.request.get(
    (await page.getByRole("link", { name: "Download CSV" }).getAttribute("href"))!,
  );
  expect(await csv.text()).toContain("CKW,TAHINI,Tahini,12,kg,300.00");
  await context.close();
});
