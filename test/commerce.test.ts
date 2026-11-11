import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortalRuntime } from "../src/browser.js";
import { PortalBehaviors } from "../src/behaviors.js";
let runtime: PortalRuntime | undefined;
let behaviors: PortalBehaviors | undefined;
const headers = { "X-Portal-Context": "guest", "X-Portal-Version": "v1", "Content-Type": "text/html" };
const response = (text = "New") => new Response(`<section data-portal-region="catalog">${text}</section>`, { headers });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body><main data-portal-page><a href="/?q=new" data-portal-target="catalog" data-portal-history="advance">Next</a><form method="get" data-portal-live data-portal-target="catalog" data-portal-history="replace"><input name="q" value="old"></form><p data-portal-status="catalog" data-portal-error-message="Please retry"></p><section data-portal-region="catalog">Old</section></main></body>';
  document.documentElement.dataset.portalContext = "guest";
  document.documentElement.dataset.portalVersion = "v1";
  delete document.documentElement.dataset.portalBase; delete document.documentElement.dataset.portalSelection;
  history.replaceState({}, "", "/");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => { runtime?.dispose(); behaviors?.dispose(); runtime = undefined; behaviors = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });
it("targets links, commits history only after successful matching replacement", async () => {
  let resolve!: (r: Response) => void;
  runtime = new PortalRuntime({ window, fetch: () => new Promise(r => resolve = r) }); runtime.start();
  document.querySelector<HTMLAnchorElement>("a")!.click();
  expect(location.search).toBe(""); expect(document.querySelector("[data-portal-status]")!.textContent).toBe("Loading…");
  resolve(response()); await flush();
  expect(location.search).toBe("?q=new"); expect(document.querySelector("[data-portal-region]")!.textContent).toBe("New");
  expect(document.querySelector("[data-portal-status]")!.textContent).toBe("Updated.");
});
it("keeps failed replacement URL and draft, displays authored error safely", async () => {
  runtime = new PortalRuntime({ window, fetch: async () => new Response("bad", { status: 500, headers }) }); runtime.start();
  await runtime.refreshRegion("catalog", "/?q=failed", "replace");
  expect(location.search).toBe(""); expect(document.querySelector("input")!.value).toBe("old");
  expect(document.querySelector("[data-portal-status]")!.textContent).toBe("Please retry");
});
it("does not submit unfinished IME composition and debounces its final value", async () => {
  vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>(async () => response());
  runtime = new PortalRuntime({ window, fetch: fetcher }); runtime.start();
  const input = document.querySelector("input")!;
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
  await vi.advanceTimersByTimeAsync(500); expect(fetcher).not.toHaveBeenCalled();
  input.value = "完成"; input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(151); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("q")).toBe("完成");
});
it("morphs a region around a focused draft", async () => {
  document.querySelector("[data-portal-region]")!.innerHTML = '<input name="quantity" value="3"><p>Old</p>';
  const input = document.querySelector<HTMLInputElement>('[name="quantity"]')!; input.focus(); input.value = "7";
  runtime = new PortalRuntime({ window, fetch: async () => response('<input name="quantity" value="3"><p>New</p>') }); runtime.start();
  await runtime.refreshRegion("catalog", "/?q=x", "advance");
  expect(input.isConnected).toBe(true); expect(input.value).toBe("7"); expect(document.activeElement).toBe(input); expect(location.search).toBe("?q=x");
  expect(document.querySelector("[data-portal-region] p")!.textContent).toBe("New");
  expect(document.querySelector("[data-portal-status]")!.textContent).toBe("Updated.");
});
it("quantity honours min/max/step and dispatches native events once across refreshes", () => {
  document.body.innerHTML = '<div data-portal-behavior="quantity"><button type="button" hidden data-portal-enhanced-only data-portal-command="increment">+</button><input type="number" data-portal-control="value" min="2" max="6" step="2" value="2"></div>';
  behaviors = new PortalBehaviors(document); behaviors.start(); behaviors.refresh();
  const input = document.querySelector("input")!; const changed = vi.fn(); input.addEventListener("input", changed);
  const button = document.querySelector("button")!; expect(button.hidden).toBe(false);
  button.click(); expect(input.value).toBe("4"); button.click(); button.click(); expect(input.value).toBe("6"); expect(changed).toHaveBeenCalledTimes(2);
  behaviors.dispose(); button.click(); expect(changed).toHaveBeenCalledTimes(2);
});
it("tabs expose accessible relationships and keyboard focus while panels work before enhancement", () => {
  document.body.innerHTML = '<div data-portal-behavior="tabs"><div data-portal-tablist><button type="button" id="one-tab" data-portal-tab="one">One</button><button type="button" id="two-tab" data-portal-tab="two">Two</button></div><section id="one" data-portal-panel>First</section><section id="two" data-portal-panel>Second</section></div>';
  expect(document.getElementById("two")!.hidden).toBe(false);
  behaviors = new PortalBehaviors(document); behaviors.start();
  const first = document.querySelector("button")!; first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(document.activeElement?.id).toBe("two-tab"); expect(first.getAttribute("aria-selected")).toBe("false");
  expect(document.getElementById("one")!.hidden).toBe(true); expect(document.getElementById("two")!.hidden).toBe(false);
  expect(document.getElementById("two")!.getAttribute("aria-labelledby")).toBe("two-tab");
});
it("dialog uses native modal lifecycle and restores opener focus", () => {
  document.body.innerHTML = '<div data-portal-behavior="dialog"><button type="button" data-portal-command="open">Open</button><dialog aria-label="Details"><button type="button" data-portal-command="close">Close</button></dialog></div>';
  const dialog = document.querySelector("dialog")!;
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event("close")); };
  behaviors = new PortalBehaviors(document); behaviors.start();
  const [open, close] = document.querySelectorAll("button"); open.click(); expect(dialog.open).toBe(true); close.click(); expect(dialog.open).toBe(false); expect(document.activeElement).toBe(open);
});
it("older history-bearing responses cannot overwrite a newer navigation intent", async () => {
  const resolvers: ((r: Response) => void)[] = [];
  document.querySelector("main")!.insertAdjacentHTML("beforeend", '<section data-portal-region="other">Other</section>');
  runtime = new PortalRuntime({ window, fetch: () => new Promise(resolve => resolvers.push(resolve)) }); runtime.start();
  const old = runtime.refreshRegion("catalog", "/?q=old", "advance");
  const latest = runtime.refreshRegion("other", "/?q=new", "replace");
  resolvers[1](new Response('<section data-portal-region="other">Latest</section>', { headers })); await latest;
  resolvers[0](response("Stale")); await old;
  expect(location.search).toBe("?q=new"); expect(document.querySelector('[data-portal-region="catalog"]')!.textContent).toBe("Old");
});
it("a malformed matching response never commits URL history", async () => {
  runtime = new PortalRuntime({ window, fetch: async () => new Response('<section data-portal-region="wrong">Wrong</section>', { headers }) }); runtime.start();
  await runtime.refreshRegion("catalog", "/?q=bad", "advance");
  expect(location.search).toBe(""); expect(document.querySelector('[data-portal-region="catalog"]')!.textContent).toBe("Old");
});
it("nested behavior scopes do not operate each other's controls", () => {
  document.body.innerHTML = '<div data-portal-behavior="quantity"><input type="number" data-portal-control="value" value="1"><div data-portal-behavior="quantity"><button type="button" data-portal-command="increment">More</button><input type="number" data-portal-control="value" value="5"></div></div>';
  behaviors = new PortalBehaviors(document); behaviors.start(); document.querySelector("button")!.click();
  expect(Array.from(document.querySelectorAll("input")).map(input => input.value)).toEqual(["1", "6"]);
});
it("ambiguous tab mapping remains unenhanced", () => {
  document.body.innerHTML = '<div data-portal-behavior="tabs"><div data-portal-tablist><button type="button" id="a" data-portal-tab="same">A</button><button type="button" id="b" data-portal-tab="same">B</button></div><section id="same" data-portal-panel>A</section><section id="other" data-portal-panel>B</section></div>';
  behaviors = new PortalBehaviors(document); behaviors.start(); expect(document.querySelector('[data-portal-tablist]')!.hasAttribute("role")).toBe(false);
  expect(document.getElementById("other")!.hidden).toBe(false);
});
it("new frame navigation supersedes a pending whole-page response", async () => {
  const resolvers: ((r: Response) => void)[] = [];
  const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => resolvers.push(resolve)));
  runtime = new PortalRuntime({ window, fetch: fetcher }); runtime.start();
  const old = runtime.navigate("/?q=old");
  const latest = runtime.refreshRegion("catalog", "/?q=latest", "replace");
  expect((fetcher.mock.calls[1][1]?.headers as Record<string, string>)["X-Portal-Request"]).toBe("navigation");
  const page = (text: string) => new Response(`<html data-portal-context="guest" data-portal-version="v1"><head></head><body><main data-portal-page><section data-portal-region="catalog">${text}</section></main></body></html>`, { headers });
  resolvers[1](page("Latest")); await latest;
  resolvers[0](page("Stale")); await old;
  expect(location.search).toBe("?q=latest");
  expect(document.querySelector('[data-portal-region="catalog"]')!.textContent).toBe("Latest");
});
it("new frame navigation supersedes an outstanding host navigation decision", async () => {
  const decisions: ((allowed: boolean) => void)[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => new Response('<html data-portal-context="guest" data-portal-version="v1"><head></head><body><main data-portal-page><section data-portal-region="catalog">Latest</section></main></body></html>', { headers }));
  runtime = new PortalRuntime({ window, fetch: fetcher, beforeNavigate: () => new Promise(resolve => decisions.push(resolve)) }); runtime.start();
  const old = runtime.navigate("/?q=old");
  const latest = runtime.refreshRegion("catalog", "/?q=latest", "advance");
  decisions[1](true); await latest;
  decisions[0](true); await old;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(location.search).toBe("?q=latest");
});
it("frame history retains request anchors omitted by fetch response URLs", async () => {
  const result = response(); Object.defineProperty(result, "url", { value: location.origin + "/?q=new" });
  runtime = new PortalRuntime({ window, fetch: async () => result }); runtime.start();
  await runtime.refreshRegion("catalog", "/?q=new#results", "advance");
  expect(location.hash).toBe("#results");
});
