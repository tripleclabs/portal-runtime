import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Fixtures are emitted by PortalSiteKit's real Swift/DataXML renderer.
const fixture = async (name: string) =>
  readFile(new URL(`../test/fixtures/${name}.html`, import.meta.url), "utf8");
const runtime = await readFile(
  new URL(
    "../dist/portal-runtime.js",
    import.meta.url,
  ),
  "utf8",
);
let submittedFields: URLSearchParams | undefined;
let submittedRegionHeader: string | string[] | undefined;
const server = createServer(async (request, response) => {
  if (request.url === "/_portal/runtime.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(runtime);
    return;
  }
  if (
    request.method === "POST" &&
    request.url?.startsWith("/_portal/actions/submit")
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    submittedFields = new URLSearchParams(Buffer.concat(chunks).toString());
    submittedRegionHeader = request.headers["x-portal-region"];
    response.writeHead(303, { location: "/" });
    response.end();
    return;
  }
  const region = request.headers["x-portal-region"];
  let html = await fixture(
    region
      ? "quote"
      : request.url?.startsWith("/products/")
        ? "product"
        : "index",
  );
  if (!region)
    html = html.replace(
      "</body>",
      '<script type="module" src="/_portal/runtime.js"></script></body>',
    );
  response.writeHead(200, {
    "content-type": "text/html",
    "X-Portal-Context": "session-1",
    "X-Portal-Version": "v1",
    "cache-control": "no-store",
  });
  response.end(html);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Missing test server address");
const origin = `http://127.0.0.1:${address.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  assert.equal(await page.locator("h1").textContent(), "Booklets & cards");
  assert.equal(
    await page.locator("main > div").evaluate((node) => node.children.length),
    0,
  );
  assert.equal(await page.locator("main > img").count(), 1);
  await page
    .locator("nav")
    .evaluate((node) => node.setAttribute("data-retained", "yes"));
  await page.locator('nav a[href="/products/booklet"]').click();
  await page.waitForURL("**/products/booklet");
  assert.equal(await page.locator("nav").getAttribute("data-retained"), "yes");
  await page.locator('input[name="quantity"]').fill("4");
  await page.evaluate(async () => {
    const moduleURL: string = "/_portal/runtime.js";
    const { runtime } = (await import(moduleURL)) as {
      runtime: { refreshRegion(name: string, href: string): Promise<void> };
    };
    await runtime.refreshRegion("quote", "/products/booklet?quantity=4");
  });
  assert.equal(
    await page.locator('[data-portal-region="quote"]').textContent(),
    "12",
  );
  assert.equal(await page.locator('input[name="quantity"]').inputValue(), "4");
  assert.equal(
    await page.locator('input[name="_portal_csrf"]').inputValue(),
    "secret-csrf",
  );
  await page.locator("form").evaluate((form) => {
    form.dataset.portalTarget = "quote";
  });
  await page.locator("button").click();
  await page.waitForURL(origin + "/");
  assert.equal(await page.locator("h1").textContent(), "Booklets & cards");
  assert.equal(submittedFields?.get("_portal_region"), "quote");
  assert.equal(submittedFields?.get("_portal_csrf"), "secret-csrf");
  assert.equal(submittedFields?.get("quantity"), "4");
  assert.equal(submittedRegionHeader, undefined);
  await page.goBack();
  await page.waitForFunction(
    () => document.querySelector("h1")?.textContent === "booklet",
  );
  assert.deepEqual(errors, []);
  const native = await browser.newContext({ javaScriptEnabled: false });
  const nativePage = await native.newPage();
  await nativePage.goto(origin + "/products/booklet");
  assert.equal(await nativePage.locator("h1").textContent(), "booklet");
  assert.equal(await nativePage.locator("form").getAttribute("method"), "post");
  await native.close();
  console.log(
    "Chromium SSR smoke passed: HTML parsing, shell retention, region update, POST/303 navigation, back navigation, JS-disabled deep link",
  );
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
