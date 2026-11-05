import { expect, test, type Browser, type Page } from "@playwright/test";
import { PASSWORD, newClient, orgDate, signUp, uniqueEmail } from "./helpers";

async function invite(owner: Page, browser: Browser, slug: string, name: string, role: string) {
  await owner.goto(`/o/${slug}/settings/members`);
  await owner.getByLabel("Email").fill(uniqueEmail(name.toLowerCase().replace(/\s+/g, "-")));
  await owner.getByLabel("Role").selectOption({ label: role });
  await owner.getByRole("button", { name: "Invite member" }).click();
  const link = await owner.getByLabel("Invitation link").inputValue();
  const client = await newClient(browser);
  await client.page.goto(new URL(link).pathname);
  await client.page.getByRole("link", { name: "Create an account" }).click();
  await client.page.getByLabel("Full name").fill(name);
  await client.page.getByLabel("Password").fill(PASSWORD);
  await client.page.getByRole("button", { name: "Create account" }).click();
  await expect(client.page).toHaveURL(new RegExp(`/o/${slug}$`));
  return client;
}

test("recruitment: a planned position, an approved opening, a trial shift scored, a hire (ADR-129)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await newClient(browser);
  const page = owner.page;
  const slug = await signUp(page, {
    name: "Head of HR",
    email: uniqueEmail("recruit"),
    organization: "Hiring Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();

  // The plan: two line cooks at Olaya, none in post.
  await page.goto(`/o/${slug}/hr/workforce`);
  await page.getByLabel("Branch").selectOption({ label: "RUH-01 — Olaya" });
  await page.getByLabel("Job title").fill("Line cook");
  await page.getByLabel("Planned").fill("2");
  await page.getByRole("button", { name: "Set planned positions" }).click();
  await expect(page.getByTestId("plan-row")).toContainText("2 to fill");

  // The branch asks for one; HR approves.
  const lead = await invite(page, browser, slug, "Branch Lead", "Branch Manager");
  await lead.page.goto(`/o/${slug}/hr/recruitment`);
  await lead.page.getByLabel("Branch").selectOption({ label: "RUH-01 — Olaya" });
  await lead.page.getByLabel("Job title").fill("Line cook");
  await lead.page.getByLabel("Places").fill("1");
  await lead.page.getByRole("button", { name: "Request an opening" }).click();
  await expect(lead.page.getByRole("heading", { name: /^JOB-.* · Line cook$/ })).toBeVisible();
  await expect(
    lead.page.getByText("1 beyond plan").or(lead.page.getByText("Within the workforce plan")),
  ).toBeVisible();
  const openingUrl = new URL(lead.page.url()).pathname;
  await page.goto(openingUrl);
  await page.getByLabel("Decision").selectOption({ label: "Approve" });
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();

  // A walk-in candidate, screened, with a trial shift yesterday run by HR.
  await lead.page.goto(openingUrl);
  await lead.page.getByLabel("First name").fill("Sara");
  await lead.page.getByLabel("Last name").fill("Haddad");
  await lead.page.getByLabel("Source").selectOption({ label: "Walk-in" });
  await lead.page.getByRole("button", { name: "Add candidate" }).click();
  await expect(lead.page.getByTestId("application-row")).toContainText("Applied");
  await lead.page.getByRole("link", { name: "Sara Haddad" }).click();
  await lead.page.getByLabel("Move to").selectOption({ label: "Screening" });
  await lead.page.getByRole("button", { name: "Move" }).click();
  await expect(lead.page.getByLabel("Interviewer")).toBeVisible();
  await lead.page.getByLabel("Kind").selectOption({ label: "Trial shift" });
  await lead.page.getByLabel("Date").fill(orgDate(-1));
  await lead.page.getByLabel("Time").fill("10:00");
  await lead.page.getByLabel("Interviewer").selectOption({ label: "Head of HR" });
  await lead.page.getByRole("button", { name: "Schedule interview" }).click();
  await expect(lead.page.getByTestId("interviews")).toContainText("Trial shift");
  const applicationUrl = new URL(lead.page.url()).pathname;

  await page.goto(`/o/${slug}/my/interviews`);
  await page.getByLabel("Rating").selectOption({ label: "4 — strong" });
  await page.getByLabel("Recommendation").selectOption({ label: "Hire" });
  await page.getByRole("button", { name: "Submit scorecard" }).click();
  await expect(page.getByText("4 — strong · Hire")).toBeVisible();

  // An offer, then HR hires: the employee is created from the candidate.
  await lead.page.goto(applicationUrl);
  await expect(lead.page.getByTestId("scorecard-summary")).toContainText("4 / 5 from 1 scorecard");
  await lead.page.getByLabel("Move to").selectOption({ label: "Offer" });
  await lead.page.getByRole("button", { name: "Move" }).click();
  await expect(lead.page.getByText("Offer", { exact: true })).toBeVisible();
  await page.goto(applicationUrl);
  await page.getByLabel("Hire date").fill(orgDate(7));
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sara Haddad" })).toBeVisible();

  await page.goto(`/o/${slug}/hr/workforce`);
  await expect(page.getByTestId("plan-row")).toContainText("1 to fill");
  await lead.context.close();
  await owner.context.close();
});
