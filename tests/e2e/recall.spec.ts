import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("trace a lot to its supplier, simulate and run a recall, dispose", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "QA Lead",
    email: uniqueEmail("recall"),
    organization: "Safe Foods",
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

  // Trace the lot back to Delta Mills.
  await page.goto(`/o/${slug}/traceability?q=DM-2611`);
  await page.getByRole("link", { name: "DM-2611" }).click();
  await expect(page.getByRole("heading", { name: "Lot DM-2611" })).toBeVisible();
  await expect(page.getByRole("link", { name: /DELTA-MILLS — Delta Mills/ })).toBeVisible();
  await expect(page.getByTestId("lot-on-hand")).toHaveText("50 kg");

  // Start a recall from the lot: a draft is a simulation.
  await page.getByRole("link", { name: "Start a recall" }).click();
  await page.getByLabel("Title").fill("Delta Mills flour");
  await page.getByLabel("Reason").fill("Supplier notice: foreign matter");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(
    page.getByRole("heading", { name: /^RCL-\d{4}-\d{6} — Delta Mills flour$/ }),
  ).toBeVisible();
  await expect(page.getByText("Draft (simulation)")).toBeVisible();
  await expect(page.getByTestId("on-hand-DM-2611")).toHaveText("50 kg");
  await expect(page.getByRole("cell", { name: "Available" })).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Activate recall" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "On hold" })).toBeVisible();
  await expect(page.getByText("Put on hold")).toBeVisible();

  await page.getByLabel("Outcome").selectOption("DISPOSED");
  await page.getByLabel("What was done").fill("Destroyed with the supplier's agent");
  await page.getByRole("button", { name: "Close recall" }).click();
  await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("on-hand-DM-2611")).toHaveText("0 kg");
  await expect(page.getByText("Written off", { exact: true }).last()).toBeVisible();
  await context.close();
});
