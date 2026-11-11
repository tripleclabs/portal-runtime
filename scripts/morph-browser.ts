import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Same URL morphs, another URL swaps: a basket page served the way the Portal
// host serves component events. A pure export (`preview`) answers with its
// instance fragment; a privileged export (`remove`) with the whole page.
const runtime = await readFile(process.env.PORTAL_RUNTIME_JS ?? new URL("../dist/portal-runtime.js", import.meta.url), "utf8");
const action = "/_portal/actions/_portal_event?returnTo=%2F";
let lines = ["a", "b", "c"];
const instanceForm = (id: string) =>
  `<form action="${action}" data-portal-instance="" hidden id="${id}" method="post"><input name="_portal_instance" type="hidden" value="token-${id}"></form>`;
/** A pure component with a live note: it echoes the visitor's text. */
const notes = (echo: string) =>
  `<div class="portal-note" data-portal-change="preview" data-portal-region="c1"><label for="note">Note</label>` +
  `<input form="c1" id="note" name="note" value=""><p data-portal-region="c1-echo">${echo}</p></div>`;
/** A privileged basket: removing a line changes the total in the header. */
const basket = () =>
  `<ul class="portal-basket" data-portal-region="c2">${lines
    .map((line, index) => `<li id="line-${line}">${line.toUpperCase()} <button form="c2" name="_portal_export" type="submit" value="${index ? `remove#${index + 1}` : "remove"}">Remove ${line}</button></li>`)
    .join("")}</ul>`;
const page = (main: string, title: string) =>
  `<!doctype html><html lang="en" data-portal-context="guest" data-portal-version="v1"><head><title>${title}</title></head>` +
  `<body><header><a href="/other">Other page</a> <span id="basket-total">Total £${lines.length * 10}</span></header>` +
  `<main data-portal-page>${main}</main><script type="module" src="/runtime.js"></script></body></html>`;
const home = (echo = "") =>
  page(`<h1>Basket</h1><details id="help"><summary>Help</summary><p>Remove lines below.</p></details>${notes(echo)}${basket()}` +
    `<div style="height:3000px"></div>${instanceForm("c1")}${instanceForm("c2")}`, "Basket");
const body = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString());
};
const server = createServer(async (request, response) => {
  if (request.url === "/runtime.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(runtime); return; }
  const headers = { "content-type": "text/html", "X-Portal-Context": "guest", "X-Portal-Version": "v1", "cache-control": "no-store" };
  if (request.method === "POST" && request.url?.startsWith("/_portal/actions/_portal_event")) {
    const fields = await body(request);
    const exported = fields.get("_portal_export") ?? "";
    if (exported === "preview") {
      // Slow enough that the visitor is still typing when it lands.
      await new Promise((resolve) => setTimeout(resolve, 150));
      response.writeHead(200, headers);
      response.end(`<div data-portal-fragment="" data-portal-context="guest" data-portal-version="v1">${notes(`You wrote ${fields.get("note")}`)}${instanceForm("c1")}</div>`);
      return;
    }
    const index = exported === "remove" ? 0 : Number(exported.split("#")[1]) - 1;
    lines = lines.filter((_, at) => at !== index);
    response.writeHead(200, headers);
    response.end(home());
    return;
  }
  response.writeHead(200, headers);
  response.end(request.url === "/other" ? page("<h1>Other</h1><p>Another page.</p>", "Other") : home());
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing test server address");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  // Mark the live nodes so identity can be checked across morphs.
  await page.evaluate(() => {
    for (const node of document.querySelectorAll("li, #help, #note, h1")) (node as Element & { mark?: string }).mark = node.id || node.localName;
  });

  // 1. A pure event's fragment morphs while the visitor keeps typing: the
  // draft, the caret and focus survive; the sibling echo updates.
  const note = page.locator("#note");
  await note.click();
  await page.keyboard.type("hello world");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector('[data-portal-region="c1-echo"]')?.textContent === "You wrote hello world");
  const caret = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#note")!;
    return { focused: document.activeElement === input, same: (input as HTMLInputElement & { mark?: string }).mark === "note", value: input.value, start: input.selectionStart, end: input.selectionEnd };
  });
  assert.deepEqual(caret, { focused: true, same: true, value: "hello world", start: 9, end: 9 });

  // 2. A privileged event answers with the whole page: the morph updates the
  // header total elsewhere on the page, removes exactly the middle line, and
  // keeps the others (and the open disclosure, and the scroll) as they were.
  await page.locator("#help summary").click();
  await page.evaluate(() => window.scrollTo(0, 120));
  const scrolled = await page.evaluate(() => window.scrollY);
  assert.ok(scrolled > 0, "the page scrolled");
  await page.getByRole("button", { name: "Remove b" }).click();
  await page.waitForFunction(() => document.querySelector("#basket-total")?.textContent === "Total £20");
  const after = await page.evaluate(() => ({
    lines: Array.from(document.querySelectorAll("li"), (node) => (node as Element & { mark?: string }).mark ?? "new"),
    help: (document.querySelector("#help") as HTMLDetailsElement & { mark?: string }).mark,
    open: (document.querySelector("#help") as HTMLDetailsElement).open,
    note: document.querySelector<HTMLInputElement>("#note")!.value,
    url: location.pathname,
    scroll: window.scrollY,
  }));
  assert.deepEqual(after, { lines: ["line-a", "line-c"], help: "help", open: true, note: "hello world", url: "/", scroll: scrolled });

  // 3. Another URL swaps: focus moves to the new page's heading and scroll resets.
  await page.getByRole("link", { name: "Other page" }).click();
  await page.waitForURL(origin + "/other");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Other");
  const swapped = await page.evaluate(() => ({ focus: document.activeElement?.textContent, scroll: window.scrollY, title: document.title }));
  assert.deepEqual(swapped, { focus: "Other", scroll: 0, title: "Other" });
  assert.deepEqual(errors, []);
  console.log("Morph browser checks passed: pure fragment keeps draft/caret/focus, privileged page morph updates a second element and keeps keyed lines/disclosure/scroll, navigation swaps focus and scroll");
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
