import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("attach a PDF to a purchase order, download it; large and wrong files are refused", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("attach"),
    organization: "Paper Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("MAIN");
  await page.getByLabel("Name", { exact: true }).fill("Main store");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Main store" })).toBeVisible();
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("paper-co");
  await page.getByLabel("Name", { exact: true }).fill("Paper Co");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Paper Co" })).toBeVisible();
  await page.getByRole("link", { name: "New purchase order" }).click();
  await page.getByLabel("Deliver to").selectOption({ label: "MAIN — Main store" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();

  const card = page.getByTestId("attachments");
  await expect(card).toContainText("No files attached.");
  const content = "%PDF-1.4\n% quotation from Paper Co\n%%EOF\n";
  await card.getByLabel("File").setInputFiles({
    name: "quotation.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(content),
  });
  await card.getByRole("button", { name: "Attach file" }).click();
  await expect(card.getByText("File attached.")).toBeVisible();
  const link = card.getByRole("link", { name: "quotation.pdf" });
  await expect(link).toBeVisible();
  const response = await page.request.get((await link.getAttribute("href"))!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  expect(response.headers()["content-disposition"]).toContain("attachment");
  // Downloads keep their own sandbox policy, not the pages' (ADR-051, ADR-074).
  expect(response.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(await response.text()).toBe(content);

  // Not a PDF or image, whatever its name.
  await card.getByLabel("File").setInputFiles({
    name: "fake.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("<html>hello</html>"),
  });
  await card.getByRole("button", { name: "Attach file" }).click();
  await expect(card.getByText("Attach a PDF, JPEG, PNG or WebP file.")).toBeVisible();
  // A 2.5 MB scan goes through (above the default 1 MB action limit).
  const scan = Buffer.alloc(2.5 * 1024 * 1024, 0x20);
  scan.write("%PDF-1.4\n");
  await card
    .getByLabel("File")
    .setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: scan });
  await card.getByRole("button", { name: "Attach file" }).click();
  await expect(card.getByRole("link", { name: "scan.pdf" })).toBeVisible();
  // Over 3 MB is refused.
  const huge = Buffer.alloc(3 * 1024 * 1024 + 10, 0x20);
  huge.write("%PDF-1.4\n");
  await card
    .getByLabel("File")
    .setInputFiles({ name: "huge.pdf", mimeType: "application/pdf", buffer: huge });
  await card.getByRole("button", { name: "Attach file" }).click();
  await expect(card.getByText("Files can be at most 3 MB.")).toBeVisible();
  await context.close();
});
