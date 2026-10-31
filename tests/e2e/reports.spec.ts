import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("reports: waste at stock value and actual food cost per branch from a sales import", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Area Manager",
    email: uniqueEmail("reports"),
    organization: "Report Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("ZAM");
  await page.getByLabel("Name", { exact: true }).fill("Zamalek");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Zamalek" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("KIT");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("WATER");
  await page.getByLabel("Name (English)").fill("Water");
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Water" })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "KIT — Kitchen" });
  await page.getByLabel("Product").selectOption({ label: "WATER — Water (each)" });
  await page.getByLabel("Quantity").fill("50");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "each — Each" });
  await page.getByLabel("Unit cost").fill("4");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  // 3 bottles damaged: 12.00 of waste.
  await page.goto(`/o/${slug}/inventory/stock?status=AVAILABLE`);
  await page.locator("tr", { hasText: "KIT" }).getByRole("link", { name: "Water" }).click();
  const writeOff = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Write off" }) });
  await writeOff.getByLabel("Quantity").fill("3");
  await writeOff.getByLabel("Reason").selectOption("DAMAGED");
  await writeOff.getByRole("button", { name: "Write off" }).click();
  await expect(page.getByRole("heading", { name: /^WO-/ })).toBeVisible();

  // 10 sold for 100.00 net: cost 40.00, food cost 40 %.
  // The organization's business date (Cairo), which dates the write-off.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const file = join(tmpdir(), `reports-${Date.now()}.csv`);
  writeFileSync(
    file,
    `date,external_id,item_code,quantity,net_amount\n${today},R-1,WATER,10,100\n`,
  );
  await page.goto(`/o/${slug}/sales`);
  await page.getByLabel("Warehouse").selectOption({ label: "KIT — Kitchen" });
  await page.getByLabel(/^CSV file/).setInputFiles(file);
  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("1 line imported.")).toBeVisible();

  await page.goto(`/o/${slug}/reports/waste?from=${today}&to=${today}`);
  await expect(page.getByTestId("waste-total")).toHaveText(/12\.00/);
  await expect(page.getByRole("cell", { name: "Damaged" }).first()).toBeVisible();

  await expect(page.getByRole("link", { name: "Food cost by branch" })).toBeVisible();
  await page.goto(`/o/${slug}/reports/food-cost?from=${today}&to=${today}`);
  await expect(page.getByRole("heading", { name: "Food cost by branch" })).toBeVisible();
  const row = page.getByTestId("branch-ZAM");
  await expect(row).toContainText("40.0 %");
  // (40 cost + 12 waste) ÷ 100 = 52 %.
  await expect(row).toContainText("52.0 %");
  const csv = await page.request.get(
    `/o/${slug}/reports/food-cost/export?from=${today}&to=${today}`,
  );
  expect(await csv.text()).toContain("ZAM,1,100.00,40.00,40.00,12.00,0.00,52.00");
  await context.close();
});
