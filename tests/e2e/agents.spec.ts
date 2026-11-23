import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("agents: switch on, run now, see the run and the inbox (ADR-140)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("agents"),
    organization: "Agent Foods",
  });
  await page.goto(`/o/${slug}`);
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent inbox" })).toBeVisible();
  await expect(page.getByText("Nothing here.")).toBeVisible();

  // Settings: both agents, off, draft-only at most.
  await page.getByTestId("process-tabs").getByRole("link", { name: "Agents", exact: true }).click();
  await expect(
    page.getByText(/nothing they prepare takes effect until a person approves it/),
  ).toBeVisible();
  const daily = page.getByTestId("agent-DAILY_CLOSE");
  await expect(daily).toContainText("Off");
  await daily.getByLabel("Switched on (runs every day)").check();
  await daily.getByRole("button", { name: "Save" }).click();
  await expect(daily.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("agent-DAILY_CLOSE")).toContainText("Runs as Owner");

  // Run it now: it checks yesterday and records the run.
  await page.getByTestId("agent-DAILY_CLOSE").getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Run finished. See Runs for the result.")).toBeVisible();
  await page.getByTestId("agent-REPLENISHMENT").getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Run finished. See Runs for the result.").last()).toBeVisible();

  await page.getByTestId("process-tabs").getByRole("link", { name: "Runs" }).click();
  await expect(page.getByTestId("agent-run")).toHaveCount(2);
  await page
    .getByTestId("agent-run")
    .filter({ hasText: "Daily close agent" })
    .getByRole("link")
    .click();
  await expect(page.getByText("Done").first()).toBeVisible();
  await expect(page.getByText("Day checked")).toBeVisible();
  await expect(page.getByText(/service calls/)).toBeVisible();
  await context.close();
});
