import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortalRuntime } from "../src/browser.js";
const headers = {
  "content-type": "text/html",
  "X-Portal-Context": "guest-1",
  "X-Portal-Version": "v1",
};
const page = (title: string, body: string) =>
  `<html data-portal-context="guest-1" data-portal-version="v1"><head><title>${title}</title><meta name="description" content="${title}"></head><body><nav>Persistent</nav><main data-portal-page><h1>${title}</h1>${body}</main></body></html>`;
const response = (html: string, extra: Record<string, string> = {}) =>
  new Response(html, { headers: { ...headers, ...extra } });
let runtime: PortalRuntime | undefined;
beforeEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.documentElement.dataset.portalContext = "guest-1";
  document.documentElement.dataset.portalVersion = "v1";
  document.head.innerHTML =
    '<title>First</title><meta name="description" content="First">';
  document.body.innerHTML =
    '<nav>Persistent</nav><main data-portal-page><h1>First</h1><form action="/quote" method="get" data-portal-target="quote"><input name="quantity" value="2"></form><section data-portal-region="quote">Old</section></main>';
  history.replaceState({}, "", "/");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  runtime?.dispose();
  runtime = undefined;
  vi.restoreAllMocks();
});
it("enhances page navigation, retains shell, updates metadata, focuses heading", async () => {
  const nav = document.querySelector("nav"),
    fetcher = vi.fn<typeof fetch>(async () =>
      response(page("Products", "<p>Catalog</p>")),
    );
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  await runtime.navigate("/products");
  expect(location.pathname).toBe("/products");
  expect(document.title).toBe("Products");
  expect(document.querySelector("nav")).toBe(nav);
  expect(document.activeElement?.textContent).toBe("Products");
  expect(
    document.querySelector('meta[name="description"]')?.getAttribute("content"),
  ).toBe("Products");
  expect(fetcher.mock.calls[0]).toBeDefined();
});
it("replaces quote without touching the draft input", async () => {
  const input = document.querySelector("input")!;
  input.value = "7";
  input.focus();
  runtime = new PortalRuntime({
    window,
    fetch: async () =>
      response('<section data-portal-region="quote">€70</section>'),
  });
  runtime.start();
  await runtime.refreshRegion("quote", "/quote?quantity=7");
  expect(document.querySelector("input")).toBe(input);
  expect(input.value).toBe("7");
  expect(document.activeElement).toBe(input);
  expect(document.querySelector("[data-portal-region]")?.textContent).toBe(
    "€70",
  );
});
it("discards a stale quote response when fetch ignores abort", async () => {
  const resolvers: ((r: Response) => void)[] = [];
  runtime = new PortalRuntime({
    window,
    fetch: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  runtime.start();
  const first = runtime.refreshRegion("quote", "/quote?q=1"),
    second = runtime.refreshRegion("quote", "/quote?q=2");
  resolvers[1](response('<section data-portal-region="quote">New</section>'));
  await second;
  resolvers[0](response('<section data-portal-region="quote">Stale</section>'));
  await first;
  expect(document.querySelector("[data-portal-region]")?.textContent).toBe(
    "New",
  );
});
it("hard navigates on identity changes without applying other customer HTML", async () => {
  const hard = vi.fn();
  runtime = new PortalRuntime({
    window,
    hardNavigate: hard,
    fetch: async () =>
      response(page("Private", "Secret"), { "X-Portal-Context": "customer-2" }),
  });
  runtime.start();
  await runtime.navigate("/account");
  expect(hard).toHaveBeenCalledWith("http://localhost:3000/account");
  expect(document.body.textContent).not.toContain("Secret");
});
it("invalidates pending reads when identity changes", async () => {
  let resolve!: (response: Response) => void;
  runtime = new PortalRuntime({
    window,
    fetch: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  runtime.start();
  const pending = runtime.refreshRegion("quote", "/quote");
  runtime.invalidate();
  resolve(
    response('<section data-portal-region="quote">Previous identity</section>'),
  );
  await pending;
  expect(document.body.textContent).not.toContain("Previous identity");
});
it("falls back to native navigation for changed assets", async () => {
  const hard = vi.fn();
  runtime = new PortalRuntime({
    window,
    hardNavigate: hard,
    fetch: async () =>
      response(
        page("New", "").replace(
          "</head>",
          '<link rel="stylesheet" href="/new.css"></head>',
        ),
      ),
  });
  runtime.start();
  await runtime.navigate("/new");
  expect(hard).toHaveBeenCalled();
  expect(document.title).toBe("First");
});
it("preserves native opt-outs and modified clicks", () => {
  document.body.insertAdjacentHTML(
    "beforeend",
    '<a href="#next" data-portal-native>Native</a>',
  );
  const fetcher = vi.fn<typeof fetch>();
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
  });
  document.querySelector("a")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it("fetches a fresh document on popstate and restores scroll without caching HTML", async () => {
  runtime = new PortalRuntime({
    window,
    fetch: async () => response(page("Back", "")),
  });
  runtime.start();
  window.dispatchEvent(
    new PopStateEvent("popstate", {
      state: { __portalPosition: { x: 0, y: 120 } },
    }),
  );
  await vi.waitFor(() => expect(document.title).toBe("Back"));
  expect(window.scrollTo).toHaveBeenCalledWith(0, 120);
});
it("submits native CSRF value, blocks duplicate POST, renders validation without retry", async () => {
  const form = document.querySelector("form")!;
  form.method = "post";
  form.insertAdjacentHTML(
    "beforeend",
    '<input type="hidden" name="_csrf" value="token">',
  );
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  form.requestSubmit();
  form.requestSubmit();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const init = fetcher.mock.calls[0][1] as RequestInit;
  expect(init.method).toBe("POST");
  expect((init.body as URLSearchParams).get("_csrf")).toBe("token");
  expect((init.body as URLSearchParams).get("_portal_region")).toBe("quote");
  expect(new Headers(init.headers).has("X-Portal-Region")).toBe(false);
  expect(form.getAttribute("aria-busy")).toBe("true");
  resolve(
    new Response(
      '<section data-portal-region="quote">Invalid quantity</section>',
      { status: 422, headers },
    ),
  );
  await vi.waitFor(() =>
    expect(document.querySelector("[data-portal-region]")?.textContent).toBe(
      "Invalid quantity",
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(form.hasAttribute("aria-busy")).toBe(false);
});
it("does not retry or navigate after uncertain POST failure", async () => {
  const form = document.querySelector("form")!;
  form.method = "post";
  const hard = vi.fn(),
    fetcher = vi.fn(async () => {
      throw new Error("lost acknowledgement");
    });
  const error = vi.fn();
  form.addEventListener("portal:error", error);
  runtime = new PortalRuntime({ window, fetch: fetcher, hardNavigate: hard });
  runtime.start();
  form.requestSubmit();
  await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(hard).not.toHaveBeenCalled();
});
it("debounces live GET forms and keeps CSRF-independent input query values", async () => {
  const form = document.querySelector("form")!;
  form.dataset.portalLive = "";
  form.dataset.portalDebounce = "10";
  const input = document.querySelector("input")!;
  const fetcher = vi.fn<typeof fetch>(async () =>
    response('<section data-portal-region="quote">Calculated</section>'),
  );
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  input.value = "8";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.value = "9";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(fetcher.mock.calls[0][0]).toContain("quantity=9");
});
it("navigation guard prevents losing drafts", async () => {
  const fetcher = vi.fn<typeof fetch>();
  runtime = new PortalRuntime({
    window,
    fetch: fetcher,
    beforeNavigate: async () => false,
  });
  runtime.start();
  await runtime.navigate("/next");
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.title).toBe("First");
});
it("rejects stale action context without retrying or navigating to the action endpoint", async () => {
  const form = document.querySelector("form")!;
  form.method = "post";
  form.action = "/_portal/actions/order";
  const hard = vi.fn();
  const refused = new Response("stale", { status: 409, headers });
  Object.defineProperty(refused, "url", {
    value: "http://localhost:3000/_portal/actions/order",
  });
  const fetcher = vi.fn<typeof fetch>(async () => refused);
  runtime = new PortalRuntime({ window, fetch: fetcher, hardNavigate: hard });
  runtime.start();
  form.requestSubmit();
  await vi.waitFor(() =>
    expect(hard).toHaveBeenCalledWith("http://localhost:3000/"),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  const requestHeaders = new Headers(fetcher.mock.calls[0][1]?.headers);
  expect(requestHeaders.get("X-Portal-Context")).toBe("guest-1");
  expect(requestHeaders.get("X-Portal-Version")).toBe("v1");
});
it("keeps the latest navigation when async draft guards resolve out of order", async () => {
  const decisions: ((value: boolean) => void)[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => response(page("Latest", "")));
  runtime = new PortalRuntime({
    window,
    fetch: fetcher,
    beforeNavigate: () => new Promise((resolve) => decisions.push(resolve)),
  });
  runtime.start();
  const old = runtime.navigate("/old"),
    latest = runtime.navigate("/latest");
  decisions[1](true);
  await latest;
  decisions[0](true);
  await old;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(location.pathname).toBe("/latest");
});
it("restores the previous history entry when a back navigation guard refuses", async () => {
  let allowed = true;
  runtime = new PortalRuntime({
    window,
    fetch: async () => response(page("Next", "")),
    beforeNavigate: () => allowed,
  });
  runtime.start();
  await runtime.navigate("/next");
  allowed = false;
  const go = vi.spyOn(history, "go").mockImplementation(() => {});
  window.dispatchEvent(
    new PopStateEvent("popstate", { state: { __portalIndex: 0 } }),
  );
  await vi.waitFor(() => expect(go).toHaveBeenCalledWith(1));
  expect(document.title).toBe("Next");
});
