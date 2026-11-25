import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("usage & limits: set a limit and download the monthly statement (ADR-146)", async ({
  browser,
}) => {
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("usage"),
    organization: "Usage Foods",
  });
  await page.goto(`/o/${slug}/settings`);
  await page.getByRole("link", { name: "Usage & limits" }).first().click();
  await expect(page.getByRole("heading", { name: "Usage & limits" })).toBeVisible();
  await expect(page.getByTestId("usage-limits")).toContainText("No limit");
  // ADR-147: no plan yet; the platform console is not for organization members.
  await expect(page.getByTestId("billing-plan")).toContainText("No plan is set");
  await page.getByLabel("MCP calls a day").fill("500");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("MCP calls a day")).toHaveValue("500");
  const res = await page
    .context()
    .request.get(
      (await page.getByRole("link", { name: "Statement (CSV)" }).getAttribute("href")) ?? "",
    );
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("organization,month,day,metric,dimension,quantity");
  const platform = await page.goto("/platform");
  expect(platform?.status()).toBe(404);
  await context.close();
});
