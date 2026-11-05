import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("assistant: off until a key passes the connection test (ADR-122)", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Asker",
    email: uniqueEmail("asker"),
    organization: "Asking Foods",
  });

  await page.goto(`/o/${slug}/assistant`);
  await expect(page.getByText("The assistant is not switched on.")).toBeVisible();

  await page.goto(`/o/${slug}/settings/assistant`);
  await expect(page.getByRole("heading", { name: "Assistant" })).toBeVisible();
  await page.getByLabel("Anthropic API key").fill("not-a-key");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("Enter an Anthropic API key (it starts with sk-ant-)."),
  ).toBeVisible();

  // A well-formed key the provider will refuse: the test fails and nothing is switched on.
  await page.getByLabel("Anthropic API key").fill("sk-ant-api03-e2e-placeholder-key-000000000000");
  await page.getByLabel("Model").selectOption({ label: "Claude Sonnet 5.5 (faster, lower cost)" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await expect(page.getByText("Stored key …0000. Leave blank to keep it.")).toBeVisible();
  await expect(page.getByText("Connection not tested yet.")).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/The connection failed: /)).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText(/Last test failed: /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch on" })).toHaveCount(0);

  await page.goto(`/o/${slug}/assistant`);
  await expect(page.getByText("The assistant is not switched on.")).toBeVisible();
  await context.close();
});
