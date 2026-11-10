import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortalRuntime } from "../src/browser.js";

const headers = {
  "content-type": "text/html",
  "X-Portal-Context": "guest-1",
  "X-Portal-Version": "v1",
};
const response = (html: string, init: ResponseInit = {}) =>
  new Response(html, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
const action = "/_portal/actions/_portal_event?returnTo=%2F";
/** Server markup for one component instance with events (see the host contract). */
const instance = (note: string, token = "token-1") =>
  `<div class="portal-buy-now" data-portal-change="preview" data-portal-region="c1">` +
  `<input form="c1" name="quantity" type="number" value="1">` +
  `<p data-portal-region="c1-total">${note}</p>` +
  `<button form="c1" name="_portal_export" type="submit" value="submit">Buy</button></div>`;
const form = (token = "token-1") =>
  `<form action="${action}" data-portal-instance="" hidden id="c1" method="post">` +
  `<input name="_portal_instance" type="hidden" value="${token}"><input name="returnTo" type="hidden" value="/">` +
  `<input name="_portal_csrf" type="hidden" value="csrf"></form>`;
const fragment = (body: string, styles = "") =>
  `<div data-portal-fragment="" data-portal-context="guest-1" data-portal-version="v1">${styles}${body}</div>`;
let runtime: PortalRuntime | undefined;
beforeEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.documentElement.dataset.portalContext = "guest-1";
  document.documentElement.dataset.portalVersion = "v1";
  document.head.innerHTML = "<title>Shop</title>";
  document.body.innerHTML = `<main data-portal-page><h1>Shop</h1>${instance("Total")}${form()}</main>`;
  history.replaceState({}, "", "/");
});
afterEach(() => {
  runtime?.dispose();
  runtime = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const body = (call: unknown[]) => (call[1] as RequestInit).body as URLSearchParams;

it("clickPostsInstanceFormWithExport", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(fragment(instance("Bought", "token-2") + form("token-2"))));
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  document.querySelector<HTMLButtonElement>('button[value="submit"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-portal-region="c1-total"]')?.textContent).toBe("Bought"));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(`http://localhost:3000${action}`);
  expect(init?.method).toBe("POST");
  const posted = body(fetcher.mock.calls[0]);
  expect(posted.get("_portal_export")).toBe("submit");
  expect(posted.get("_portal_instance")).toBe("token-1");
  expect(posted.get("quantity")).toBe("1");
  expect(posted.get("_portal_region")).toBe("c1");
  expect(new Headers(init?.headers).get("X-Portal-Request")).toBe("region");
  // The instance's form came back with a fresh token and replaced the old one.
  expect(document.querySelectorAll("form[data-portal-instance]").length).toBe(1);
  expect(document.querySelector<HTMLInputElement>('#c1 [name="_portal_instance"]')?.value).toBe("token-2");
});

it("changeDebouncesAndSupersedes", async () => {
  vi.useFakeTimers();
  const pending: { resolve: (r: Response) => void; signal: AbortSignal }[] = [];
  const fetcher = vi.fn<typeof fetch>((_, init) => new Promise<Response>((resolve) => pending.push({ resolve, signal: init!.signal! })));
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  const input = document.querySelector<HTMLInputElement>('input[name="quantity"]')!;
  const change = (value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
  // Two changes 50 ms apart are one request.
  change("2");
  await vi.advanceTimersByTimeAsync(50);
  change("3");
  await vi.advanceTimersByTimeAsync(249);
  expect(fetcher).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const first = body(fetcher.mock.calls[0]);
  expect(first.get("quantity")).toBe("3");
  expect(first.get("_portal_export")).toBe("preview");
  expect(first.get("_portal_region")).toBe("c1");
  // A newer change supersedes the request in flight.
  change("4");
  await vi.advanceTimersByTimeAsync(250);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(pending[0].signal.aborted).toBe(true);
  expect(pending[1].signal.aborted).toBe(false);
  pending[1].resolve(response(fragment(instance("40") + form())));
  await vi.waitFor(() => expect(document.querySelector('[data-portal-region="c1-total"]')?.textContent).toBe("40"));
  pending[0].resolve(response(fragment(instance("30") + form())));
  await vi.advanceTimersByTimeAsync(10);
  expect(document.querySelector('[data-portal-region="c1-total"]')?.textContent).toBe("40");
});

it("focusedControlIsNotReplaced", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(fragment(instance("Updated") + form())));
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  const input = document.querySelector<HTMLInputElement>('input[name="quantity"]')!;
  input.focus();
  input.value = "7";
  document.querySelector<HTMLFormElement>("#c1")!.requestSubmit(document.querySelector<HTMLButtonElement>('button[value="submit"]')!);
  await vi.waitFor(() => expect(document.querySelector('[data-portal-region="c1-total"]')?.textContent).toBe("Updated"));
  // The instance root holds the control being edited: only its live parts swap.
  expect(document.querySelector('input[name="quantity"]')).toBe(input);
  expect(input.value).toBe("7");
  expect(document.activeElement).toBe(input);
});

it("componentStylesAdoptedOnSwap", async () => {
  document.head.insertAdjacentHTML("beforeend", "<style data-portal-components>.portal-buy-now{display:flex}</style>");
  const styles = "<style data-portal-components>.portal-buy-now{display:flex}\n.portal-badge{color:red}</style>";
  const fetcher = vi.fn<typeof fetch>(async () => response(fragment(instance("Bought") + form(), styles)));
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  document.querySelector<HTMLButtonElement>('button[value="submit"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-portal-region="c1-total"]')?.textContent).toBe("Bought"));
  const live = document.head.querySelectorAll("style[data-portal-components]");
  expect(live.length).toBe(1);
  expect(live[0].textContent).toBe(".portal-buy-now{display:flex}\n.portal-badge{color:red}");
});

it("conflictReloads", async () => {
  const hard = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => response("stale", { status: 409 }));
  runtime = new PortalRuntime({ window, fetch: fetcher, hardNavigate: hard });
  runtime.start();
  document.querySelector<HTMLButtonElement>('button[value="submit"]')!.click();
  await vi.waitFor(() => expect(hard).toHaveBeenCalledWith("http://localhost:3000/"));
  // A live change refused as stale reloads too.
  hard.mockClear();
  vi.useFakeTimers();
  const input = document.querySelector<HTMLInputElement>('input[name="quantity"]')!;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(250);
  await vi.waitFor(() => expect(hard).toHaveBeenCalledWith("http://localhost:3000/"));
});

it("wholePageResponseToAnEventSwapsThePage", async () => {
  // The export removed its own instance: the host answers with the whole page.
  const page = `<!doctype html><html data-portal-context="guest-1" data-portal-version="v1"><head><title>Shop</title></head>` +
    `<body><main data-portal-page><h1>Shop</h1><p>Your basket is empty</p></main></body></html>`;
  const hard = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => response(page));
  runtime = new PortalRuntime({ window, fetch: fetcher, hardNavigate: hard });
  runtime.start();
  document.querySelector<HTMLButtonElement>('button[value="submit"]')!.click();
  await vi.waitFor(() => expect(document.querySelector("[data-portal-page] p")?.textContent).toBe("Your basket is empty"));
  expect(body(fetcher.mock.calls[0]).get("_portal_region")).toBe("c1");
  expect(document.querySelector('[data-portal-region="c1"]')).toBeNull();
  expect(hard).not.toHaveBeenCalled();
});
