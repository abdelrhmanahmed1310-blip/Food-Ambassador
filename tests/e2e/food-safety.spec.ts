import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("food safety: readings against limits, non-conformance with actions, checklist", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Hygiene Lead",
    email: uniqueEmail("haccp"),
    organization: "Clean Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();

  // A walk-in fridge at 0–5 °C.
  await page.goto(`/o/${slug}/food-safety/checkpoints`);
  await page.getByLabel("Branch").selectOption({ label: "CAI-01 — Cairo" });
  await page.getByLabel("Code").fill("F1");
  await page.getByLabel("Name", { exact: true }).fill("Walk-in fridge");
  await page.getByLabel("Kind").selectOption("FRIDGE");
  await page.getByLabel("Minimum °C").fill("0");
  await page.getByLabel("Maximum °C").fill("5");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("cell", { name: /F1 — Walk-in fridge/ })).toBeVisible();

  // 4 °C is fine; 8 °C needs an immediate action and opens a non-conformance.
  await page.goto(`/o/${slug}/food-safety/records`);
  await page.getByLabel("Point").selectOption({ index: 1 });
  await page.getByLabel("Reading (°C)").fill("4");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByText("Recorded — within limits.")).toBeVisible();
  await page.getByLabel("Point").selectOption({ index: 1 });
  await page.getByLabel("Reading (°C)").fill("8");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByText("Out of spec or failed: say what was done about it.")).toBeVisible();
  await page.getByLabel(/^Immediate action/).fill("Door left open; closed it and moved dairy");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(
    page.getByText(/Recorded out of spec — non-conformance NC-\d{4}-\d{6} opened\./),
  ).toBeVisible();

  await page.goto(`/o/${slug}/food-safety`);
  await expect(page.getByTestId("open-ncs")).toHaveText("1");
  await page.getByRole("link", { name: /^NC-/ }).click();
  await expect(page.getByRole("heading", { name: /^NC-.*Temperature out of range/ })).toBeVisible();
  await page.getByLabel("Action", { exact: true }).fill("Fit a door alarm");
  await page.getByRole("button", { name: "Add action" }).click();
  await expect(page.getByTestId("corrective-action")).toContainText("Fit a door alarm");
  await expect(page.getByText("Action planned").first()).toBeVisible();
  await page.getByLabel("What was done").fill("Alarm installed");
  await page.getByRole("button", { name: "Mark done" }).click();
  // The person who did it cannot verify it, so it cannot be closed yet.
  await expect(page.getByText("Another person must verify this action.")).toBeVisible();
  await expect(
    page.getByText("It can be closed once every corrective action is verified."),
  ).toBeVisible();

  // A checklist with a failed item opens a non-conformance.
  await page.goto(`/o/${slug}/food-safety/checklists`);
  await page.getByLabel("Name").fill("Opening checks");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Opening checks" })).toBeVisible();
  await page.getByLabel("Item", { exact: true }).fill("Hand-wash station stocked");
  await page.getByLabel("Answer", { exact: true }).selectOption("YES_NO");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByText("Hand-wash station stocked").first()).toBeVisible();
  const run = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Submit checklist" }) });
  await run.getByLabel("Answer", { exact: true }).selectOption("no");
  await run.getByLabel("Note", { exact: false }).first().fill("No soap");
  await run.getByRole("button", { name: "Submit checklist" }).click();
  await expect(page.getByText("1 failed")).toBeVisible();
  await expect(page.getByRole("link", { name: /^NC-/ })).toBeVisible();
  await context.close();
});
