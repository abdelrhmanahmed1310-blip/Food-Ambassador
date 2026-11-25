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
    page.getByText(/nothing takes effect until a person approves it, unless you let an agent act/),
  ).toBeVisible();
  // ADR-142, ADR-145: invoice matching only proposes; food safety and menu & margin may act within limits.
  for (const [kind, options] of [
    ["INVOICE_MATCHING", 1],
    ["FOOD_SAFETY", 2],
    ["MENU_MARGIN", 2],
  ] as const) {
    const card = page.getByTestId(`agent-${kind}`);
    await expect(card).toContainText("Off");
    await expect(card.getByLabel("How far it may go").locator("option")).toHaveCount(options);
  }
  // The kill switch pauses every agent action and resumes them.
  const actions = page.getByTestId("agent-actions");
  page.once("dialog", (d) => d.accept());
  await actions.getByRole("button", { name: "Pause all agent actions" }).click();
  await expect(actions).toContainText("All agent actions are paused");
  await actions.getByRole("button", { name: "Resume agent actions" }).click();
  await expect(actions).toContainText("carry out actions after their hold");
  await expect(page.getByRole("heading", { name: "Menu & margin agent" })).toBeVisible();
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
  // ADR-141: no explanation while the AI assistant is off; asking says so.
  await expect(page.getByRole("heading", { name: "What this run means" })).toBeVisible();
  await expect(page.getByText(/No explanation yet/)).toBeVisible();
  await page.getByRole("button", { name: "Explain this run" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "The assistant is not switched on." }),
  ).toBeVisible();
  // ADR-150: performance per agent, from the records.
  await page.getByTestId("process-tabs").getByRole("link", { name: "Performance" }).click();
  await expect(page.getByRole("heading", { name: "Agent performance" })).toBeVisible();
  await expect(page.getByTestId("performance-DAILY_CLOSE")).toContainText(
    "Too few decisions to say",
  );
  // ADR-151: what each agent may do, from its record; report-only agents have no step.
  await expect(page.getByTestId("trust-MENU_MARGIN")).toContainText(
    "Switch the agent on in its settings first.",
  );
  await expect(page.getByTestId("trust-DAILY_CLOSE")).toHaveCount(0);
  await context.close();
});
