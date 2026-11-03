import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("notifications: the bell, the list and what to be told (ADR-087)", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("notify"),
    organization: "Notify Foods",
  });
  await page.goto(`/o/${slug}`);
  await page.getByTestId("notification-bell").click();
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(page.getByText("Nothing here.")).toBeVisible();
  // Turn one kind off and keep it off.
  const daily = page.getByLabel("Daily summary of what needs attention");
  await expect(daily).toBeChecked();
  await daily.uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Daily summary of what needs attention")).not.toBeChecked();
  await expect(page.getByLabel("Purchase orders waiting for my approval")).toBeChecked();

  await page.goto(`/o/${slug}/settings/jobs`);
  await expect(page.getByRole("heading", { name: "Background jobs" })).toBeVisible();
  await expect(page.getByText("No jobs yet.")).toBeVisible();
  await context.close();
});
