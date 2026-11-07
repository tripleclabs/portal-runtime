import index from "./fixtures/index.html?raw";
import product from "./fixtures/product.html?raw";
import quote from "./fixtures/quote.html?raw";
import { afterEach, expect, it, vi } from "vitest";
import { PortalRuntime } from "../src/browser.js";
const fixtures = { index, product, quote };
const fixture = (name: keyof typeof fixtures) => fixtures[name];
const headers = {
  "content-type": "text/html",
  "X-Portal-Context": "session-1",
  "X-Portal-Version": "v1",
};
let runtime: PortalRuntime | undefined;
afterEach(() => {
  runtime?.dispose();
  vi.restoreAllMocks();
});
it("enhances actual Swift/DataXML SSR documents and regions", async () => {
  document.open();
  document.write(fixture("index"));
  document.close();
  history.replaceState({}, "", "/");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  expect(document.querySelector("h1")?.textContent).toBe("Booklets & cards");
  expect(document.querySelector("main > div")?.children.length).toBe(0);
  expect(document.querySelector("main > img")).not.toBeNull();
  expect(document.querySelector("style")?.textContent).toBe(
    "p > span { color: red; }",
  );
  const nav = document.querySelector("nav");
  const fetcher = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Response(
        fixture(
          new Headers(init?.headers).has("X-Portal-Region")
            ? "quote"
            : "product",
        ),
        { headers },
      ),
  );
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  await runtime.navigate("/products/booklet");
  expect(document.querySelector("nav")).toBe(nav);
  const input = document.querySelector<HTMLInputElement>(
    'input[name="quantity"]',
  )!;
  input.value = "4";
  input.focus();
  await runtime.refreshRegion("quote", "/products/booklet?quantity=4");
  expect(
    document.querySelector('[data-portal-region="quote"]')?.textContent,
  ).toBe("12");
  expect(document.querySelector('input[name="quantity"]')).toBe(input);
  expect(input.value).toBe("4");
  expect(
    document.querySelector<HTMLInputElement>('input[name="_portal_csrf"]')
      ?.value,
  ).toBe("secret-csrf");
  expect(document.querySelector("form")?.method).toBe("post");
});
