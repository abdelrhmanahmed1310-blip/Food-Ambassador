import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("build a HACCP plan with a CCP from the decision tree (ADR-096)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "QA Lead",
    email: uniqueEmail("haccp-owner"),
    organization: "Safe Kitchens",
  });

  await page.goto(`/o/${slug}/food-safety/haccp/new`);
  await page.getByLabel("Code").fill("CHK");
  await page.getByLabel("Product or process").fill("Grilled chicken");
  await page
    .getByLabel(/Scope and description/)
    .fill("Marinated chicken thighs, grilled, served hot");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /CHK v1 — Grilled chicken/ })).toBeVisible();
  await expect(page.getByTestId("haccp-problems")).toContainText("Add at least one process step.");

  const step = page.locator("form").filter({ has: page.getByRole("button", { name: "Add step" }) });
  await step.getByLabel("Step", { exact: true }).fill("Grilling");
  await step.getByRole("button", { name: "Add step" }).click();
  await expect(page.getByTestId("haccp-step")).toContainText("1. Grilling");

  const hazard = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add hazard" }) });
  await hazard.getByLabel("Step", { exact: true }).selectOption({ label: "1. Grilling" });
  await hazard.getByLabel("Type").selectOption({ label: "Biological" });
  await hazard.getByLabel("Hazard", { exact: true }).fill("Salmonella survives cooking");
  await hazard.getByLabel("Likelihood (1–5)").selectOption("4");
  await hazard.getByLabel("Severity (1–5)").selectOption("5");
  await hazard.getByLabel("Significant hazard").check();
  await hazard.getByLabel(/^Q1/).selectOption({ label: "Yes" });
  await hazard.getByLabel(/^Q2/).selectOption({ label: "Yes" });
  await hazard.getByRole("button", { name: "Add hazard" }).click();
  await expect(page.getByTestId("haccp-step")).toContainText("CCP");
  await expect(page.getByTestId("haccp-step")).toContainText("risk 20 (4 × 5)");
  await expect(page.getByTestId("haccp-problems")).toContainText(
    "Set the critical limit and monitoring",
  );

  await page.getByText("Set limits and monitoring").click();
  const cp = page.locator("form").filter({ has: page.getByLabel("Critical limit") });
  await cp.getByLabel("Critical limit").fill("Core at least 75 °C");
  await cp.getByLabel(/^Minimum/).fill("75");
  await cp.getByLabel(/^Unit/).fill("°C");
  await cp.getByLabel("Frequency").fill("Every batch");
  await cp.getByLabel("Monitoring", { exact: true }).fill("Probe the thickest piece");
  await cp.getByLabel("Corrective action").fill("Keep cooking to 75 °C");
  await cp.getByLabel("Verification").fill("Daily log review");
  await cp.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("The plan is complete and can be approved.")).toBeVisible();
  await expect(page.getByText("Someone other than the author approves the plan.")).toBeVisible();

  const pdf = await page.request.get(`${new URL(page.url()).pathname}/pdf`);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  await context.close();
});
