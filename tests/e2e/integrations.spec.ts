import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("an inbound sales connector shows its secret once and imports signed sales", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("integrations"),
    organization: "Connected Foods",
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
  await page.getByLabel("SKU").fill("WATER");
  await page.getByLabel("Name (English)").fill("Water");
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Water" })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "KITCH — Kitchen" });
  await page.getByLabel("Product").selectOption({ label: "WATER — Water (each)" });
  await page.getByLabel("Quantity").fill("10");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "each — Each" });
  await page.getByLabel("Unit cost").fill("5");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  await page.goto(`/o/${slug}/settings/integrations`);
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Till");
  await page.getByLabel("Warehouse for imported sales").selectOption({ label: "KITCH — Kitchen" });
  await page.getByRole("button", { name: "Create connector" }).click();
  const secretField = page.getByLabel("Signing secret");
  await expect(secretField).toHaveValue(/^fa_whsec_/);
  const secret = await secretField.inputValue();
  const endpoint = new URL(await page.getByLabel("Endpoint URL").inputValue());

  const body = JSON.stringify({
    lines: [
      {
        date: "2026-11-01",
        external_id: "T-1",
        item_code: "WATER",
        quantity: "3",
        net_amount: "15",
      },
    ],
  });
  const send = (signature: string, key = "pos-e2e-0001") => {
    const ts = String(Math.floor(Date.now() / 1000));
    return page.request.post(endpoint.pathname, {
      data: body,
      headers: {
        "Content-Type": "application/json",
        "X-FA-Timestamp": ts,
        "X-FA-Signature":
          signature ||
          `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`,
        "Idempotency-Key": key,
      },
    });
  };
  expect((await send("sha256=00")).status()).toBe(401);
  const ok = await send("");
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ imported: 1 });
  expect(await (await send("")).json()).toMatchObject({ duplicate: true });

  // The secret is not shown again; the log shows each request.
  await page.goto(`/o/${slug}/settings/integrations`);
  await expect(page.getByLabel("Signing secret")).toHaveCount(0);
  await page.getByRole("link", { name: "Till" }).click();
  await expect(page.getByRole("heading", { name: "Till" })).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
  await expect(page.getByText("Duplicate", { exact: true })).toBeVisible();
  await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/stock`);
  await expect(page.getByRole("cell", { name: "7 each" })).toBeVisible();
  await context.close();
});
