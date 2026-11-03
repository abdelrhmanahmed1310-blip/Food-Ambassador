import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("register a probe, calibrate it, a failed check takes it out of service (ADR-099)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("equipment-owner"),
    organization: "Calibrated Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();

  await page.goto(`/o/${slug}/food-safety/equipment`);
  await page.getByLabel("Branch").selectOption({ label: "CAI-01 — Cairo" });
  await page.getByLabel("Code").fill("PROBE-1");
  await page.getByLabel("Name", { exact: true }).fill("Probe thermometer");
  await page.getByLabel("Type").selectOption({ label: "Thermometer or probe" });
  await page.getByLabel(/^Calibrate every/).fill("30");
  await page.getByRole("button", { name: "Register" }).click();
  await expect(page.getByRole("heading", { name: "PROBE-1 — Probe thermometer" })).toBeVisible();

  const cal = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Record calibration" }) });
  await cal.getByLabel(/^By/).fill("Shift lead");
  await cal.getByLabel(/^Reference value/).fill("0");
  await cal.getByLabel(/^Reading/).fill("0.4");
  await cal.getByLabel(/^Allowed deviation/).fill("1");
  await cal.getByRole("button", { name: "Record calibration" }).click();
  await expect(page.getByText("Calibration passed.")).toBeVisible();

  await cal.getByLabel(/^By/).fill("Shift lead");
  await cal.getByLabel(/^Reference value/).fill("0");
  await cal.getByLabel(/^Reading/).fill("1.6");
  await cal.getByLabel(/^Allowed deviation/).fill("1");
  await cal.getByRole("button", { name: "Record calibration" }).click();
  await expect(
    page.getByText(/Calibration failed: the equipment is out of service and NC-/),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Out of service", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /^NC-/ })).toBeVisible();
  await context.close();
});
