import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("batch report PDF, a timed mock recall that finds stock missing, compliance score (ADR-100)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "QA Lead",
    email: uniqueEmail("mock-recall"),
    organization: "Drill Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("MAIN");
  await page.getByLabel("Name", { exact: true }).fill("Main store");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Main store" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("FLOUR");
  await page.getByLabel("Name (English)").fill("Flour");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Lot tracking").selectOption("LOT");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Flour" })).toBeVisible();
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("delta-mills");
  await page.getByLabel("Name", { exact: true }).fill("Delta Mills");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Delta Mills" })).toBeVisible();
  await page.getByRole("link", { name: "New purchase order" }).click();
  await page.getByLabel("Deliver to").selectOption({ label: "MAIN — Main store" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  const line = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await line.getByLabel("Product").selectOption({ label: "FLOUR — Flour (kg)" });
  await line.getByLabel("Quantity").fill("50");
  await line.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await line.getByLabel("Unit price").fill("12");
  await line.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: "50 kg" }).first()).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Receive delivery" }).click();
  await page.getByLabel("Lot").fill("DM-2611");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: /^GRN-/ })).toBeVisible();

  await page.goto(`/o/${slug}/traceability?q=DM-2611`);
  await page.getByRole("link", { name: "DM-2611" }).click();
  await expect(page.getByRole("heading", { name: "Lot DM-2611" })).toBeVisible();

  // One-click batch report.
  const href = await page.getByRole("link", { name: "Batch report (PDF)" }).getAttribute("href");
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Mock recall: the clock runs, the team finds 48 of the 50 kg on the book.
  await page.getByRole("link", { name: "Mock recall", exact: true }).click();
  await page.getByLabel(/^Scenario/).fill("Supplier reports possible glass");
  await page.getByLabel(/^Target time/).fill("240");
  await page.getByRole("button", { name: "Start the clock" }).click();
  await expect(page.getByRole("heading", { name: /^MRC-.* — DM-2611$/ })).toBeVisible();
  await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();
  await page.getByLabel(/^Found/).fill("48");
  await page.getByLabel(/^Findings/).fill("Two kg not located");
  await page.getByRole("button", { name: "Stop the clock and complete" }).click();
  // The page now shows the finished exercise.
  await expect(page.getByText("Not passed", { exact: true })).toBeVisible();
  await expect(page.getByText("The stock found differs from the book.")).toBeVisible();
  await expect(page.getByRole("link", { name: /^NC-/ })).toBeVisible();
  await expect(page.getByText("96 %")).toBeVisible();

  // The stock itself did not change.
  await page.goto(`/o/${slug}/traceability?q=DM-2611`);
  await page.getByRole("link", { name: "DM-2611" }).click();
  await expect(page.getByTestId("lot-on-hand")).toHaveText("50 kg");

  // Compliance score: nothing recorded yet, so no score rather than a made-up one.
  await page.goto(`/o/${slug}/food-safety/compliance`);
  await expect(page.getByRole("heading", { name: "Compliance score" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /CAI-01/ })).toBeVisible();
  await expect(page.getByText("No data", { exact: true }).first()).toBeVisible();
  await context.close();
});
