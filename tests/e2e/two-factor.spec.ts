import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { newClient, PASSWORD, signUp, uniqueEmail } from "./helpers";

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as an authenticator app computes it. */
function totp(base32: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("two-step sign-in: turn on, sign in with a code or a backup code, turn off (ADR-073)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const email = uniqueEmail("2fa");
  const slug = await signUp(page, { name: "Owner", email, organization: "Two Step Foods" });

  await page.getByRole("link", { name: "Security" }).click();
  await expect(page.getByTestId("two-factor-status")).toHaveText("Two-step sign-in is off.");
  await page.waitForLoadState("load");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("The password is not right.")).toBeVisible();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Turn on" }).click();
  const secret = (await page.getByTestId("totp-secret").textContent())!.trim();
  const backup = (await page.getByTestId("backup-codes").textContent())!.trim().split(/\s+/);
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  expect(backup.length).toBeGreaterThanOrEqual(5);
  await expect(page.getByAltText("QR code for the authenticator app")).toBeVisible();
  await page.getByLabel("Code", { exact: true }).fill(totp(secret));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Two-step sign-in is on.").first()).toBeVisible();

  // Sign out; signing in now asks for the code.
  await page.goto(`/o/${slug}`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in\/two-factor/);
  // Without the code there is no session.
  await page.goto(`/o/${slug}`);
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goBack();
  await page.goto("/sign-in/two-factor");
  await page.getByLabel("Code", { exact: true }).fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That code is not right, or it has expired.")).toBeVisible();
  await page.getByLabel("Code", { exact: true }).fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}$`));

  // A backup code works once.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in\/two-factor/);
  await page.getByLabel("Code", { exact: true }).fill(backup[0]);
  await page.getByLabel("This is a backup code").check();
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}$`));

  // Turned off with the password.
  await page.goto("/account/security");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("Two-step sign-in is off.").first()).toBeVisible();
  await context.close();
});
