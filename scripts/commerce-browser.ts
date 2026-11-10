import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const runtime = await readFile(new URL("../dist/portal-runtime.js", import.meta.url), "utf8");
const controls = `<div data-portal-behavior="quantity"><button type="button" data-portal-command="increment" hidden data-portal-enhanced-only>More</button><input aria-label="Quantity" type="number" value="1" min="1" max="3" data-portal-control="value"></div>
<div data-portal-behavior="dialog"><button type="button" data-portal-command="open" hidden data-portal-enhanced-only>Details</button><dialog aria-label="Details"><p>Product details</p><button type="button" data-portal-command="close">Close</button></dialog></div>
<div data-portal-behavior="dialog"><button type="button" data-portal-command="open" command="show-modal" commandfor="shipping-dialog" hidden data-portal-enhanced-only>Shipping options</button><dialog id="shipping-dialog" aria-label="Shipping options"><p>Shipping options</p><button type="button" data-portal-command="close" command="close" commandfor="shipping-dialog">Close</button></dialog></div>
<div data-portal-behavior="copy"><code data-portal-copy-source>
  PF-1042
</code><button type="button" data-portal-command="copy" hidden data-portal-enhanced-only data-portal-copied-message="Order number copied">Copy order number</button></div>
<div data-portal-behavior="tabs"><div data-portal-tablist aria-label="Product information"><button type="button" id="description-tab" data-portal-tab="description" hidden data-portal-enhanced-only>Description</button><button type="button" id="shipping-tab" data-portal-tab="shipping" hidden data-portal-enhanced-only>Shipping</button></div><section id="description" data-portal-panel>Description content</section><section id="shipping" data-portal-panel>Shipping content</section></div>`;
const server = createServer((req, res) => {
  if (req.url === "/runtime.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(runtime); return; }
  const url = new URL(req.url!, "http://localhost");
  const region = `<section data-portal-region="catalog">Page ${url.searchParams.get("page") ?? "1"}</section>`;
  res.writeHead(200, { "content-type": "text/html", "X-Portal-Context": "guest", "X-Portal-Version": "v1" });
  res.end(req.headers["x-portal-region"] ? region : `<!doctype html><html lang="en" data-portal-context="guest" data-portal-version="v1"><head><title>Commerce</title></head><body><main data-portal-page><h1>Catalogue</h1><a href="/?page=2" data-portal-target="catalog" data-portal-history="advance">Next</a><p data-portal-status="catalog"></p>${region}${controls}</main><script type="module" src="/runtime.js"></script></body></html>`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw Error("No address");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext(); await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole("button", { name: "More", exact: true }).click(); assert.equal(await page.getByLabel("Quantity").inputValue(), "2");
  await page.getByRole("button", { name: "Details", exact: true }).click(); assert.equal(await page.locator("dialog").first().evaluate(node => node.matches(":modal")), true);
  await page.keyboard.press("Escape"); assert.equal(await page.locator("dialog").first().evaluate(node => (node as HTMLDialogElement).open), false); assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Details");
  // Native invoker commands open this one; the runtime only restores focus.
  assert.equal(await page.evaluate(() => "commandForElement" in HTMLButtonElement.prototype), true, "Chromium supports invoker commands");
  await page.getByRole("button", { name: "Shipping options", exact: true }).click(); assert.equal(await page.locator("#shipping-dialog").evaluate(node => node.matches(":modal")), true);
  await page.locator("#shipping-dialog").getByRole("button", { name: "Close" }).click(); assert.equal(await page.locator("#shipping-dialog").evaluate(node => (node as HTMLDialogElement).open), false);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Shipping options");
  await page.getByRole("button", { name: "Copy order number" }).click();
  await page.waitForFunction(() => document.querySelector('[data-portal-behavior="copy"]')?.hasAttribute("data-portal-copied"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "PF-1042");
  assert.equal(await page.getByRole("status").filter({ hasText: "Order number copied" }).count(), 1);
  await page.getByRole("tab", { name: "Description", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: "Shipping", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#description").isVisible(), false);
  await page.getByRole("link", { name: "Next" }).click(); await page.waitForURL(origin + "/?page=2"); assert.equal(await page.locator("[data-portal-region]").textContent(), "Page 2");
  await page.goBack(); await page.waitForFunction(() => document.querySelector("[data-portal-region]")?.textContent === "Page 1");
  assert.deepEqual(errors, []);
  const native = await browser.newContext({ javaScriptEnabled: false }); const noJS = await native.newPage(); await noJS.goto(origin);
  assert.equal(await noJS.getByRole("button", { name: "Copy order number" }).count(), 0, "copy is hidden without JavaScript");
  assert.equal(await noJS.locator("#description").isVisible(), true); assert.equal(await noJS.locator("#shipping").isVisible(), true); assert.equal(await noJS.getByLabel("Quantity").isVisible(), true);
  await noJS.getByRole("link", { name: "Next" }).click(); await noJS.waitForURL(origin + "/?page=2"); await native.close();
  console.log("Commerce browser checks passed: native modal/Escape/focus, invoker dialogs, copy, tabs keyboard, quantity, frame history/back, no-JS content/navigation");
} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
