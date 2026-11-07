import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortalRuntime } from "../src/browser.js";
const headers = {
  "content-type": "text/html",
  "X-Portal-Context": "identity-1",
  "X-Portal-Version": "v1",
};
const html = (body: string) =>
  `<html data-portal-context="identity-1" data-portal-version="v1"><head><title>Page</title></head><body><main data-portal-page>${body}</main></body></html>`;
const response = (body: string, status = 200) =>
  new Response(body, { headers, status });
const quote = (text: string) =>
  `<section data-portal-region="quote">${text}</section>`;
let runtime: PortalRuntime | undefined;
beforeEach(() => {
  document.open();
  document.write(
    html(
      `<form method="post" action="/_portal/actions/save" data-portal-target="quote"><input name="name" value="draft"><button>Save</button></form>${quote("Original")}`,
    ),
  );
  document.close();
  history.replaceState({}, "", "/");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  runtime?.dispose();
  vi.restoreAllMocks();
});
it("disposal or identity invalidation cancels navigation awaiting a guard", async () => {
  let decide!: (allowed: boolean) => void;
  const fetcher = vi.fn<typeof fetch>();
  runtime = new PortalRuntime({
    window,
    fetch: fetcher,
    beforeNavigate: () =>
      new Promise((resolve) => {
        decide = resolve;
      }),
  });
  runtime.start();
  const navigation = runtime.navigate("/later");
  runtime.invalidate();
  decide(true);
  await navigation;
  expect(fetcher).not.toHaveBeenCalled();
  const disposed = runtime.navigate("/disposed");
  runtime.dispose();
  decide(true);
  await disposed;
  await runtime.navigate("/after-dispose");
  await runtime.refreshRegion("quote", "/quote");
  expect(fetcher).not.toHaveBeenCalled();
});
it("guard errors are observable without starting a navigation", async () => {
  const error = new Error("guard failed"),
    event = vi.fn(),
    fetcher = vi.fn<typeof fetch>();
  document.documentElement.addEventListener("portal:error", event, {
    once: true,
  });
  runtime = new PortalRuntime({
    window,
    fetch: fetcher,
    beforeNavigate: async () => {
      throw error;
    },
  });
  runtime.start();
  await runtime.navigate("/next");
  expect(event).toHaveBeenCalledTimes(1);
  expect(runtime.state.getSnapshot().error).toBe(error);
  expect(fetcher).not.toHaveBeenCalled();
});
it("parent replacement invalidates child requests even when IDs are reused", async () => {
  document.querySelector("[data-portal-page]")!.innerHTML =
    `<div data-portal-region="parent">${quote("Before")}</div>`;
  let child!: (value: Response) => void;
  runtime = new PortalRuntime({
    window,
    fetch: async (_url, options) => {
      if (new Headers(options?.headers).get("X-Portal-Region") === "quote")
        return new Promise((resolve) => {
          child = resolve;
        });
      return response(
        `<div data-portal-region="parent">${quote("Replacement")}</div>`,
      );
    },
  });
  runtime.start();
  const pending = runtime.refreshRegion("quote", "/child");
  await runtime.refreshRegion("parent", "/parent");
  child(response(quote("Stale child")));
  await pending;
  expect(
    document.querySelector('[data-portal-region="quote"]')?.textContent,
  ).toBe("Replacement");
});
it("navigation commit disposes region work started while navigation was pending", async () => {
  let page!: (value: Response) => void, region!: (value: Response) => void;
  runtime = new PortalRuntime({
    window,
    fetch: (_url, options) =>
      new Promise((resolve) => {
        if (new Headers(options?.headers).has("X-Portal-Region"))
          region = resolve;
        else page = resolve;
      }),
  });
  runtime.start();
  const navigation = runtime.navigate("/next");
  const pending = runtime.refreshRegion("quote", "/quote");
  page(response(html(quote("New page"))));
  await navigation;
  region(response(quote("Previous page response")));
  await pending;
  expect(
    document.querySelector('[data-portal-region="quote"]')?.textContent,
  ).toBe("New page");
});
it("detached form action responses cannot update the replacement page", async () => {
  let action!: (value: Response) => void;
  runtime = new PortalRuntime({
    window,
    fetch: (_url, options) =>
      options?.method === "POST"
        ? new Promise((resolve) => {
            action = resolve;
          })
        : Promise.resolve(response(html(quote("New page")))),
  });
  runtime.start();
  document.querySelector("form")!.requestSubmit();
  await runtime.navigate("/next");
  action(response(quote("Old action")));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    document.querySelector('[data-portal-region="quote"]')?.textContent,
  ).toBe("New page");
});
it("action completion fences reads of the same region without retrying writes", async () => {
  let action!: (value: Response) => void, read!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    (_url, options) =>
      new Promise((resolve) => {
        if (options?.method === "POST") action = resolve;
        else read = resolve;
      }),
  );
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  document.querySelector("form")!.requestSubmit();
  const pending = runtime.refreshRegion("quote", "/quote");
  action(response(quote("Saved")));
  await vi.waitFor(() =>
    expect(document.querySelector("[data-portal-region]")?.textContent).toBe(
      "Saved",
    ),
  );
  read(response(quote("Old read")));
  await pending;
  expect(document.querySelector("[data-portal-region]")?.textContent).toBe(
    "Saved",
  );
  expect(
    fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(1);
});
it("server write failures preserve drafts and emit errors without reload", async () => {
  const hard = vi.fn(),
    error = vi.fn(),
    form = document.querySelector("form")!;
  form.addEventListener("portal:error", error);
  runtime = new PortalRuntime({
    window,
    hardNavigate: hard,
    fetch: async () =>
      new Response('{"error":"unavailable"}', {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  });
  runtime.start();
  form.requestSubmit();
  await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  expect(hard).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
    "draft",
  );
  expect(form.hasAttribute("aria-busy")).toBe(false);
});
it("native submitter target overrides are preserved", () => {
  const fetcher = vi.fn<typeof fetch>(),
    button = document.querySelector("button")!;
  button.setAttribute("formtarget", "_blank");
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  const event = new SubmitEvent("submit", {
    bubbles: true,
    cancelable: true,
    submitter: button,
  });
  document.querySelector("form")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it("invalid region targets report a form error rather than an unhandled rejection", async () => {
  const form = document.querySelector("form")!,
    error = vi.fn();
  form.method = "get";
  form.dataset.portalTarget = "missing";
  form.addEventListener("portal:error", error);
  runtime = new PortalRuntime({ window, fetch: vi.fn<typeof fetch>() });
  runtime.start();
  form.requestSubmit();
  await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
});
it("does not replace current DOM with an external redirect response", async () => {
  const hard = vi.fn(),
    external = response(html("<h1>Foreign</h1>"));
  Object.defineProperty(external, "url", {
    value: "https://other.example/account",
  });
  runtime = new PortalRuntime({
    window,
    hardNavigate: hard,
    fetch: async () => external,
  });
  runtime.start();
  await runtime.navigate("/redirect");
  expect(hard).toHaveBeenCalledWith("https://other.example/account");
  expect(document.body.textContent).not.toContain("Foreign");
});
it("new navigation intent cancels an old fetch while its own guard is pending", async () => {
  const decisions: ((allowed: boolean) => void)[] = [];
  let oldResponse!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>((url) =>
    String(url).endsWith("/old")
      ? new Promise((resolve) => {
          oldResponse = resolve;
        })
      : Promise.resolve(response(html("<h1>Latest</h1>"))),
  );
  runtime = new PortalRuntime({
    window,
    fetch: fetcher,
    beforeNavigate: () => new Promise((resolve) => decisions.push(resolve)),
  });
  runtime.start();
  const old = runtime.navigate("/old");
  decisions[0](true);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const latest = runtime.navigate("/latest");
  oldResponse(response(html("<h1>Stale</h1>")));
  await old;
  expect(document.body.textContent).not.toContain("Stale");
  decisions[1](true);
  await latest;
  expect(location.pathname).toBe("/latest");
  expect(document.querySelector("h1")?.textContent).toBe("Latest");
});
it("scroll during a pending pop guard does not corrupt destination history state", async () => {
  let decide!: (allowed: boolean) => void;
  let first = true;
  runtime = new PortalRuntime({
    window,
    fetch: async () => response(html("<h1>Next</h1>")),
    beforeNavigate: () =>
      first
        ? true
        : new Promise((resolve) => {
            decide = resolve;
          }),
  });
  runtime.start();
  await runtime.navigate("/next");
  first = false;
  history.replaceState(
    { __portalIndex: 0, __portalPosition: { x: 0, y: 123 } },
    "",
    "/",
  );
  window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  window.dispatchEvent(new Event("scroll"));
  expect(history.state).toEqual({
    __portalIndex: 0,
    __portalPosition: { x: 0, y: 123 },
  });
  decide(true);
  await vi.waitFor(() => expect(window.scrollTo).toHaveBeenCalledWith(0, 123));
});
it("malformed fragment leaves current content intact and clears pending state", async () => {
  const target = document.querySelector("[data-portal-region]")!,
    failed = vi.fn();
  target.addEventListener("portal:error", failed);
  runtime = new PortalRuntime({
    window,
    fetch: async () => response(quote("one") + quote("two")),
  });
  runtime.start();
  await runtime.refreshRegion("quote", "/quote");
  expect(document.querySelector("[data-portal-region]")).toBe(target);
  expect(target.textContent).toBe("Original");
  expect(target.hasAttribute("aria-busy")).toBe(false);
  expect(failed).toHaveBeenCalledTimes(1);
});
it("freezes submitted controls after capture and restores their original disabled state", async () => {
  const form = document.querySelector("form")!;
  form.insertAdjacentHTML(
    "beforeend",
    '<input name="locked" disabled value="server-owned">',
  );
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  form.requestSubmit();
  expect(
    document.querySelector<HTMLInputElement>('input[name="name"]')!.disabled,
  ).toBe(true);
  expect((fetcher.mock.calls[0][1]?.body as URLSearchParams).get("name")).toBe(
    "draft",
  );
  expect(
    (fetcher.mock.calls[0][1]?.body as URLSearchParams).has("locked"),
  ).toBe(false);
  finish(response(quote("Validation"), 422));
  await vi.waitFor(() => expect(form.hasAttribute("aria-busy")).toBe(false));
  expect(
    document.querySelector<HTMLInputElement>('input[name="name"]')!.disabled,
  ).toBe(false);
  expect(
    document.querySelector<HTMLInputElement>('input[name="locked"]')!.disabled,
  ).toBe(true);
});
it("old action completion cannot unlock a newer action after context invalidation", async () => {
  const replies: ((response: Response) => void)[] = [];
  const form = document.querySelector("form")!;
  runtime = new PortalRuntime({
    window,
    fetch: () => new Promise((resolve) => replies.push(resolve)),
  });
  runtime.start();
  form.requestSubmit();
  runtime.invalidate();
  expect(form.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
  form.requestSubmit();
  replies[0](response(quote("Old")));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(form.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  expect(form.getAttribute("aria-busy")).toBe("true");
  replies[1](response(quote("New")));
  await vi.waitFor(() =>
    expect(form.querySelector<HTMLInputElement>("input")!.disabled).toBe(false),
  );
});
it("navigation replaces social and structured metadata and removes stale values", async () => {
  document.head.insertAdjacentHTML(
    "beforeend",
    '<meta name="twitter:title" content="Old"><meta property="og:description" content="Remove"><script type="application/ld+json">{"name":"Old"}</script>',
  );
  const next = html("<h1>New</h1>").replace(
    "<head>",
    '<head><meta name="twitter:title" content="New"><link rel="canonical" href="/new"><script type="application/ld+json">{"name":"New"}</script>',
  );
  runtime = new PortalRuntime({ window, fetch: async () => response(next) });
  runtime.start();
  await runtime.navigate("/new");
  expect(
    document
      .querySelector('meta[name="twitter:title"]')
      ?.getAttribute("content"),
  ).toBe("New");
  expect(document.querySelector('meta[property="og:description"]')).toBeNull();
  expect(
    document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
  ).toBe("/new");
  expect(
    document.querySelector('script[type="application/ld+json"]')?.textContent,
  ).toBe('{"name":"New"}');
});
it("changed viewport requires native navigation instead of leaving incompatible head state", async () => {
  document.head.insertAdjacentHTML(
    "beforeend",
    '<meta name="viewport" content="width=500">',
  );
  const hard = vi.fn();
  runtime = new PortalRuntime({
    window,
    hardNavigate: hard,
    fetch: async () =>
      response(
        html("<h1>Next</h1>").replace(
          "<head>",
          '<head><meta name="viewport" content="width=device-width">',
        ),
      ),
  });
  runtime.start();
  await runtime.navigate("/next");
  expect(hard).toHaveBeenCalledTimes(1);
  expect(
    document.querySelector('meta[name="viewport"]')?.getAttribute("content"),
  ).toBe("width=500");
});
it("locks HTML controls associated through form attributes outside the form subtree", async () => {
  const form = document.querySelector("form")!;
  form.id = "order";
  document.body.insertAdjacentHTML(
    "beforeend",
    '<input name="reference" form="order" value="draft-reference">',
  );
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  form.requestSubmit();
  const external = document.querySelector<HTMLInputElement>(
    'input[name="reference"]',
  )!;
  expect(external.disabled).toBe(true);
  expect(
    (fetcher.mock.calls[0][1]?.body as URLSearchParams).get("reference"),
  ).toBe("draft-reference");
  runtime.invalidate();
  expect(external.disabled).toBe(false);
  finish(response(quote("stale")));
});
it("a publication version change cannot patch the current page even with the same identity", async () => {
  const hard = vi.fn();
  runtime = new PortalRuntime({
    window,
    hardNavigate: hard,
    fetch: async () =>
      new Response(quote("New publication"), {
        headers: { ...headers, "X-Portal-Version": "v2" },
      }),
  });
  runtime.start();
  await runtime.refreshRegion("quote", "/quote");
  expect(hard).toHaveBeenCalledWith("http://localhost:3000/");
  expect(document.querySelector("[data-portal-region]")?.textContent).toBe(
    "Original",
  );
  expect(
    document.querySelector("[data-portal-region]")?.hasAttribute("aria-busy"),
  ).toBe(false);
});
it("changed server-rendered layout content forces native navigation", async () => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    "<nav><span data-cart-count>1</span></nav>",
  );
  const hard = vi.fn();
  const next = html("<h1>Next</h1>").replace(
    "<body>",
    "<body><nav><span data-cart-count>2</span></nav>",
  );
  runtime = new PortalRuntime({
    window,
    hardNavigate: hard,
    fetch: async () => response(next),
  });
  runtime.start();
  await runtime.navigate("/next");
  expect(hard).toHaveBeenCalledWith("http://localhost:3000/next");
  expect(document.querySelector("[data-cart-count]")?.textContent).toBe("1");
  expect(document.querySelector("h1")).toBeNull();
});
it("unchanged server shell preserves live client mutations and ordinary head updates", async () => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    "<nav><span data-cart-count>1</span></nav>",
  );
  const nav = document.querySelector("nav")!;
  const hard = vi.fn();
  const next = html("<h1>Next</h1>")
    .replace("<body>", "<body><nav><span data-cart-count>1</span></nav>")
    .replace("<title>Page</title>", "<title>Next title</title>");
  runtime = new PortalRuntime({
    window,
    hardNavigate: hard,
    fetch: async () => response(next),
  });
  runtime.start();
  nav.setAttribute("data-client-state", "open");
  nav.querySelector("[data-cart-count]")!.textContent = "Locally edited";
  await runtime.navigate("/next");
  expect(hard).not.toHaveBeenCalled();
  expect(document.querySelector("nav")).toBe(nav);
  expect(nav.getAttribute("data-client-state")).toBe("open");
  expect(nav.textContent).toBe("Locally edited");
  expect(document.title).toBe("Next title");
  expect(document.querySelector("h1")?.textContent).toBe("Next");
});
