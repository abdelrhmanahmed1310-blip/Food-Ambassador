import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("product photo and barcode: shown and scanned at the till, shown on a menu board (ADR-133)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "pos-photos");

  // A photo and a barcode on the product the Cola menu item is sold from.
  const file = join(mkdtempSync(join(tmpdir(), "photo-")), "cola.png");
  writeFileSync(
    file,
    await sharp({ create: { width: 640, height: 480, channels: 3, background: "#c0392b" } })
      .png()
      .toBuffer(),
  );
  await page.goto(`/o/${slug}/catalog/products`);
  await page
    .getByRole("link", { name: /Cola can/ })
    .first()
    .click();
  await page.locator("#photo-file").setInputFiles(file);
  await page.getByRole("button", { name: "Upload photo" }).click();
  await expect(page.getByText("Photo saved.")).toBeVisible();
  await expect(page.getByTestId("photo")).toHaveAttribute("src", /^\/media\//);
  const src = await page.getByTestId("photo").getAttribute("src");
  const served = await page.request.get(src!);
  expect(served.headers()["content-type"]).toBe("image/webp");
  await page.getByLabel("Barcode", { exact: true }).fill("6281000000014");
  await page.getByLabel("Barcode type").selectOption("EAN13");
  await page.getByRole("button", { name: "Add barcode" }).click();
  await expect(page.getByText("6281000000014")).toBeVisible();

  // The till: the item shows the photo; scanning the barcode adds it.
  await page.goto(`/o/${slug}/pos`);
  await page.getByRole("link", { name: "TILL1" }).click();
  await page.getByRole("link", { name: "Open till" }).click();
  await expect(page.getByRole("button", { name: /Cola/ }).first().locator("img")).toHaveAttribute(
    "src",
    src!,
  );
  const scan = page.getByLabel("Scan a barcode");
  await scan.fill("6281000000014");
  await scan.press("Enter");
  await expect(page.getByTestId("till-total")).toHaveText(/EGP\s?25\.00/);
  await scan.fill("4000000000002");
  await scan.press("Enter");
  await expect(page.getByText("No item on sale here has the barcode 4000000000002.")).toBeVisible();
  await expect(page.getByTestId("till-total")).toHaveText(/EGP\s?25\.00/);

  // A menu board for a screen: no floor needed, no sign-in to view it.
  await page.goto(`/o/${slug}/pos/online/setup`);
  await page.getByLabel("Type").selectOption("BOARD");
  await page.getByLabel("Name", { exact: true }).fill("Front screen");
  await page.getByRole("checkbox", { name: "Eat in" }).check();
  await page.getByRole("button", { name: "Add a page or kiosk" }).click();
  const channel = page.getByTestId("ordering-channel").filter({ hasText: "Front screen" });
  await expect(channel).toBeVisible();
  const boardPath = new URL(await channel.getByLabel("Address").inputValue()).pathname;
  expect(boardPath).toMatch(/^\/board\//);
  const screen = await browser.newContext();
  const tv = await screen.newPage();
  await tv.goto(boardPath);
  const item = tv.getByTestId("board-item").filter({ hasText: "Cola" });
  await expect(item).toContainText(/EGP\s?25\.00/);
  await expect(item.locator("img")).toHaveAttribute("src", src!);
  await screen.close();
  await context.close();
});
