import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("draft a campaign to a segment: audience, preview and SMS parts; launch waits for a provider (ADR-119)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "campaigns");
  // A guest who agrees to offers, added at the till.
  await page.getByRole("link", { name: "Open till" }).click();
  await page.getByRole("button", { name: /Cola/ }).first().click();
  await page.getByText("Customer", { exact: true }).click();
  await page.getByLabel("Phone number").fill("0501234567");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByLabel("Customer name").fill("Sara Ahmed");
  await page.getByLabel("The customer agrees to receive offers").check();
  await page.getByRole("button", { name: "Add customer" }).click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByLabel("Cash received").fill("25");
  await page.getByRole("button", { name: "Take payment" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();

  await page.goto(`/o/${slug}/pos/customers/segments`);
  await page.getByLabel("Name", { exact: true }).fill("Regulars");
  await page.getByLabel(/^At least orders/).fill("1");
  await page.getByRole("button", { name: "Save segment" }).click();
  await expect(page.getByTestId("segment-count")).toHaveText("1 customers, 1 agreed to offers");

  await page.goto(`/o/${slug}/pos/customers/campaigns`);
  await page.getByLabel("Name", { exact: true }).fill("Weekend wraps");
  await page.getByLabel("Segment").selectOption({ index: 1 });
  await page
    .getByRole("textbox", { name: /^Message Use/ })
    .fill("Hi {name}, 20% off wraps this weekend!");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { name: "Weekend wraps" })).toBeVisible();
  await expect(page.getByTestId("will-receive")).toHaveText("1");
  await expect(page.getByTestId("campaign-preview")).toContainText(
    "Hi Sara, 20% off wraps this weekend!",
  );
  await expect(page.getByTestId("campaign-preview")).toContainText("/unsubscribe/");
  await expect(page.getByTestId("sms-parts")).toContainText("GSM-7");
  await expect(page.getByText(/No SMS provider is connected yet/)).toBeVisible();

  await page.getByRole("button", { name: "Launch" }).click();
  await expect(
    page.getByText("No provider is connected for this channel yet, so nothing can be sent."),
  ).toBeVisible();
  await context.close();
});
