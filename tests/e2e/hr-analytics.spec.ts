import { expect, test } from "@playwright/test";
import { newClient, orgDate, signUp, uniqueEmail } from "./helpers";

test("HR analytics: headcount and hires for the last twelve months, with a CSV (ADR-130)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Head of HR",
    email: uniqueEmail("hr-analytics"),
    organization: "Counted Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();
  for (const [first, hired] of [
    ["Huda", "2024-03-01"],
    ["Omar", orgDate(-20)],
  ]) {
    await page.goto(`/o/${slug}/hr/employees/new`);
    await page.getByLabel("First name").fill(first);
    await page.getByLabel("Last name").fill("Test");
    await page.getByLabel("Job title").fill("Cook");
    await page.getByLabel("Hire date").fill(hired);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: `${first} Test` })).toBeVisible();
  }

  await page.goto(`/o/${slug}/hr/analytics`);
  await expect(page.getByRole("heading", { name: "HR analytics" })).toBeVisible();
  await expect(page.getByTestId("stat-end")).toContainText("2");
  await expect(page.getByTestId("stat-hires")).toContainText("1");
  await expect(page.getByTestId("stat-leavers")).toContainText("0");
  await expect(page.getByText("Under 3 months")).toBeVisible();

  const href = await page.getByRole("link", { name: "Export CSV" }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect((await res.text()).replace(/^﻿/, "").split("\r\n")[0]).toBe(
    "month,headcount_start,headcount_end,hires,leavers,turnover_percent",
  );
  await context.close();
});
