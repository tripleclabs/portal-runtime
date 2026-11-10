import fixtureJSON from "./fixtures/url-resolution.json?raw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortalURLs } from "../src/urls.js";
import { PortalRuntime } from "../src/browser.js";
interface Case { name: string; kind: "page" | "asset" | "api" | "action"; value: string; expected?: string; error?: boolean; currentPath?: string; basePath?: string; selection?: Record<string, string> }
const fixtures: Case[] = JSON.parse(fixtureJSON);
for (const item of fixtures) it(`shared URL contract: ${item.name}`, () => {
  const urls = new PortalURLs({ basePath: item.basePath ?? "/preview", currentPath: item.currentPath ?? "/orders/123", selection: item.selection ?? {site: "shop", version: "draft"} });
  const resolve = () => urls[item.kind](item.value);
  if (item.error) expect(resolve).toThrow(); else expect(resolve()).toBe(item.expected);
});
it("rejects invalid mounts, API escapes, and unmatched request mounts", () => {
  for (const basePath of ["//other", "/preview/", "/pre%2fview", "/preview/../other", "/a?b"]) expect(() => new PortalURLs({basePath})).toThrow();
  const urls = new PortalURLs({basePath: "/preview"});
  expect(() => urls.api("../staff")).toThrow();
  expect(() => urls.unmount("/preview-other/orders")).toThrow();
  expect(urls.unmount("/preview/orders?x=1")).toBe("/orders?x=1");
});
let runtime: PortalRuntime | undefined;
const html = (text: string, base = "/preview", selection = '{"site":"shop","version":"draft"}') => `<html data-portal-context="guest" data-portal-version="v1" data-portal-base="${base}" data-portal-selection='${selection}'><head><title>Portal</title></head><body><main data-portal-page><h1>${text}</h1><section data-portal-region="quote">Old</section><form action="/preview/search" method="get"><input name="q" value="book"><input name="version" value="author-override"></form></main></body></html>`;
const response = (body: string) => new Response(body, {headers: {"content-type":"text/html", "x-portal-context":"guest", "x-portal-version":"v1"}});
beforeEach(() => {
  document.open(); document.write(html("Start")); document.close();
  history.replaceState({}, "", "/preview/orders/123?site=shop&version=draft");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  runtime?.dispose(); runtime = undefined;
  document.documentElement.removeAttribute("data-portal-base");
  document.documentElement.removeAttribute("data-portal-selection");
  history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});
it("mounts custom navigation and helpers follow current logical page", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(html("Next")));
  runtime = new PortalRuntime({window, fetch: fetcher}); runtime.start();
  await runtime.navigate("/catalog");
  expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe("/preview/catalog");
  expect(location.search).toBe("?site=shop&version=draft");
  expect(runtime.urls.page("next")).toBe("/preview/next?site=shop&version=draft");
  expect(runtime.urls.api("orders")).toBe("/preview/api/orders");
});
it("does not fetch same-origin staff paths or inject different mount metadata", async () => {
  const hard = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => response(html("Unsafe", "/staff")));
  runtime = new PortalRuntime({window, fetch: fetcher, hardNavigate: hard}); runtime.start();
  await runtime.navigate(location.origin + "/staff");
  expect(fetcher).not.toHaveBeenCalled();
  await runtime.navigate("/catalog");
  expect(document.querySelector("h1")!.textContent).toBe("Start");
  expect(hard).toHaveBeenCalledTimes(2);
  await expect(runtime.refreshRegion("quote", location.origin + "/staff")).rejects.toThrow();
});
it("restores host selection after GET form data replaces action query", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(html("Search")));
  runtime = new PortalRuntime({window, fetch: fetcher}); runtime.start();
  document.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", {bubbles:true, cancelable:true}));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.pathname).toBe("/preview/search");
  expect(url.searchParams.get("q")).toBe("book");
  expect(url.searchParams.get("version")).toBe("draft");
  expect(url.searchParams.get("site")).toBe("shop");
});
it("API GET forms and fragments cannot inherit page-only selection or staff content", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response('<div data-portal-fragment data-portal-base="/staff"><section data-portal-region="quote">Unsafe</section></div>'));
  runtime = new PortalRuntime({window, fetch: fetcher}); runtime.start();
  await runtime.refreshRegion("quote", "/orders/123");
  expect(document.querySelector("section")!.textContent).toBe("Old");
  const form = document.querySelector("form")!;
  form.action = "/preview/api";
  form.querySelector('[name="version"]')!.remove();
  form.dispatchEvent(new SubmitEvent("submit", {bubbles:true, cancelable:true}));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const url = new URL(String(fetcher.mock.calls[1]![0]));
  expect(url.pathname).toBe("/preview/api");
  expect(url.searchParams.has("site")).toBe(false);
});

it("keeps explicit asset and endpoint links native", () => {
  const fetcher = vi.fn<typeof fetch>(), hard = vi.fn();
  runtime = new PortalRuntime({window, fetch: fetcher, hardNavigate: hard}); runtime.start();
  for (const kind of ["asset", "endpoint"]) {
    const link = document.createElement("a"); link.href = "/preview/manual.svg"; link.dataset.portalUrlKind = kind; document.body.append(link);
    const click = new MouseEvent("click", {bubbles:true, cancelable:true});
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    link.remove();
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects malformed incoming routing metadata", async () => {
  const hard = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => response(html("Unsafe", "/preview", "null")));
  runtime = new PortalRuntime({window, fetch: fetcher, hardNavigate: hard}); runtime.start();
  await runtime.navigate("/catalog");
  expect(document.querySelector("h1")!.textContent).toBe("Start");
  expect(hard).toHaveBeenCalledTimes(1);
});

it("treats undefined optional selection values as absent", () => {
  expect(new PortalURLs({selection:{site:undefined, version:"draft"}}).page("/")).toBe("/?version=draft");
});
