import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortalRuntime } from "../src/browser.js";
import { Morph } from "../src/morph.js";

const headers = {
  "content-type": "text/html",
  "X-Portal-Context": "guest-1",
  "X-Portal-Version": "v1",
};
const response = (html: string, init: ResponseInit = {}) =>
  new Response(html, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
/** A morph that knows the current page as server-rendered, as the runtime's does from start(). */
const adopted = () => {
  const morpher = new Morph(document);
  morpher.adopt(document.body);
  return morpher;
};
/** Morph `live` toward the root element of `html`. */
const morph = (live: Element, html: string, morpher = adopted()) => {
  morpher.morph(live, parse(html).body.firstElementChild!);
  return morpher;
};
const action = "/_portal/actions/_portal_event?returnTo=%2F";
const page = (main: string, title = "Basket") =>
  `<!doctype html><html data-portal-context="guest-1" data-portal-version="v1"><head><title>${title}</title></head>` +
  `<body><main data-portal-page>${main}</main></body></html>`;
const basket = (lines: string[], total: string) =>
  `<header><span id="basket-total">${total}</span></header><h1>Basket</h1>` +
  `<ul id="lines">${lines.map((line) => `<li id="line-${line}">${line}</li>`).join("")}</ul>` +
  `<div class="portal-line" data-portal-region="c1"><input form="c1" name="note" value="">` +
  `<button form="c1" name="_portal_export" type="submit" value="update">Update</button></div>` +
  `<form action="${action}" data-portal-instance="" hidden id="c1" method="post"><input name="_portal_instance" type="hidden" value="t"></form>`;

let runtime: PortalRuntime | undefined;
beforeEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.documentElement.dataset.portalContext = "guest-1";
  document.documentElement.dataset.portalVersion = "v1";
  document.head.innerHTML = "<title>Basket</title>";
  document.body.innerHTML = "<main data-portal-page></main>";
  history.replaceState({}, "", "/");
});
afterEach(() => {
  runtime?.dispose();
  runtime = undefined;
  vi.restoreAllMocks();
});

it("morphPreservesFocusDraftAndCaret", () => {
  document.body.innerHTML = `<main data-portal-page><form><input id="q" name="q" value="a"><p>Old</p></form></main>`;
  const input = document.querySelector<HTMLInputElement>("#q")!;
  input.focus();
  input.value = "abcdef";
  input.setSelectionRange(2, 4);
  morph(document.querySelector("form")!, `<form><input id="q" name="q" value="a"><p>New</p></form>`);
  expect(document.querySelector("#q")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("abcdef");
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
  expect(document.querySelector("p")?.textContent).toBe("New");
});

it("focusedControlKeepsItsValueEvenWhenTheServerChangedIt", () => {
  document.body.innerHTML = `<main data-portal-page><form><input name="q" value="a"></form></main>`;
  const input = document.querySelector<HTMLInputElement>("input")!;
  input.focus();
  input.value = "typed";
  morph(document.querySelector("form")!, `<form><input name="q" value="server"></form>`);
  expect(input.value).toBe("typed");
  expect(input.defaultValue).toBe("server");
});

it("serverChangedValuesWin", () => {
  document.body.innerHTML = `<main data-portal-page><form><input name="a" value="1"><input name="b" value="1">` +
    `<textarea name="c">x</textarea><input name="d" type="checkbox"><select name="e"><option>one</option><option>two</option></select></form></main>`;
  const [a, b] = Array.from(document.querySelectorAll<HTMLInputElement>("input[type=text], input:not([type])"));
  const c = document.querySelector("textarea")!, d = document.querySelector<HTMLInputElement>('[name="d"]')!;
  const e = document.querySelector("select")!;
  a.value = "typed a";
  b.value = "typed b";
  c.value = "typed c";
  d.checked = true;
  e.value = "two";
  // The server changed a, c and e; it rendered b and d as it did before.
  morph(document.querySelector("form")!, `<form><input name="a" value="2"><input name="b" value="1">` +
    `<textarea name="c">y</textarea><input name="d" type="checkbox"><select name="e"><option>one</option><option selected>two</option></select></form>`);
  expect(a.value).toBe("2");
  expect(b.value).toBe("typed b");
  expect(c.value).toBe("y");
  expect(d.checked).toBe(true);
  expect(e.value).toBe("two");
  // A later morph that leaves e as rendered keeps the visitor's choice.
  e.value = "one";
  morph(document.querySelector("form")!, `<form><input name="a" value="2"><input name="b" value="1">` +
    `<textarea name="c">y</textarea><input name="d" type="checkbox"><select name="e"><option>one</option><option selected>two</option></select></form>`);
  expect(e.value).toBe("one");
});

it("keyedListRemovesExactlyTheMiddleLine", () => {
  document.body.innerHTML = `<main data-portal-page><ul><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul></main>`;
  const [a, b, c] = Array.from(document.querySelectorAll("li"));
  const removed: Node[] = [];
  const observer = new MutationObserver((records) => records.forEach((record) => removed.push(...record.removedNodes)));
  observer.observe(document.querySelector("ul")!, { childList: true, subtree: true, characterData: true, attributes: true });
  const morpher = adopted();
  observer.takeRecords();
  morpher.morph(document.querySelector("ul")!, parse(`<ul><li id="a">A</li><li id="c">C</li></ul>`).body.firstElementChild!, {});
  const records = observer.takeRecords();
  observer.disconnect();
  expect(Array.from(document.querySelectorAll("li"))).toEqual([a, c]);
  expect(b.isConnected).toBe(false);
  // One mutation: b's removal. Nothing else is repainted or moved.
  expect(records.length).toBe(1);
  expect(Array.from(records[0].removedNodes)).toEqual([b]);
});

it("keyedNodesMoveRatherThanRepaint", () => {
  document.body.innerHTML = `<main data-portal-page><ul><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul></main>`;
  const [a, b, c] = Array.from(document.querySelectorAll("li"));
  morph(document.querySelector("ul")!, `<ul><li id="c">C</li><li id="new">N</li><li id="a">A</li><li id="b">B!</li></ul>`);
  const now = Array.from(document.querySelectorAll("li"));
  expect(now[0]).toBe(c);
  expect(now[2]).toBe(a);
  expect(now[3]).toBe(b);
  expect(now.map((li) => li.textContent)).toEqual(["C", "N", "A", "B!"]);
});

it("regionsKeyNodesToo", () => {
  document.body.innerHTML = `<main data-portal-page><div><section data-portal-region="x">X</section><section data-portal-region="y">Y</section></div></main>`;
  const y = document.querySelector('[data-portal-region="y"]');
  morph(document.querySelector("main > div")!, `<div><section data-portal-region="y">Y2</section></div>`);
  expect(document.querySelector('[data-portal-region="y"]')).toBe(y);
  expect(y?.textContent).toBe("Y2");
  expect(document.querySelector('[data-portal-region="x"]')).toBeNull();
});

it("openDisclosureStaysOpenUnlessTheServerChangedIt", () => {
  document.body.innerHTML = `<main data-portal-page><div><details><summary>More</summary><p>1</p></details><p>Old</p></div></main>`;
  const morpher = adopted();
  const details = document.querySelector("details")!;
  details.open = true; // the visitor opened it
  morph(document.querySelector("main > div")!, `<div><details><summary>More</summary><p>2</p></details><p>New</p></div>`, morpher);
  expect(details.open).toBe(true);
  expect(details.querySelector("p")?.textContent).toBe("2");
  // The server now renders it open, then closed: the server's change wins.
  morph(document.querySelector("main > div")!, `<div><details open><summary>More</summary><p>2</p></details><p>New</p></div>`, morpher);
  details.open = true;
  morph(document.querySelector("main > div")!, `<div><details><summary>More</summary><p>2</p></details><p>New</p></div>`, morpher);
  expect(details.open).toBe(false);
});

it("behaviourInsertedInitialisesUntouchedIsNotReinitialised", async () => {
  const tabs = (prefix: string) =>
    `<div data-portal-behavior="tabs" id="${prefix}-tabs"><div data-portal-tablist><button type="button" id="${prefix}-one" data-portal-tab="${prefix}-p1" hidden data-portal-enhanced-only>One</button>` +
    `<button type="button" id="${prefix}-two" data-portal-tab="${prefix}-p2" hidden data-portal-enhanced-only>Two</button></div>` +
    `<section id="${prefix}-p1" data-portal-panel>1</section><section id="${prefix}-p2" data-portal-panel>2</section></div>`;
  document.body.innerHTML = `<main data-portal-page><p data-portal-region="note">Old</p>${tabs("a")}</main>`;
  runtime = new PortalRuntime({ window, fetch: async () => response(page(`<p data-portal-region="note">New</p>${tabs("a")}${tabs("b")}`)) });
  runtime.start();
  // The visitor picks the second tab of the existing scope.
  document.querySelector<HTMLButtonElement>("#a-two")!.click();
  expect(document.querySelector("#a-two")?.getAttribute("aria-selected")).toBe("true");
  const scope = document.querySelector("#a-tabs");
  const form = document.createElement("form");
  form.method = "post";
  form.action = "/basket";
  document.querySelector("main")!.prepend(form);
  form.requestSubmit();
  await vi.waitFor(() => expect(document.querySelector('[data-portal-region="note"]')?.textContent).toBe("New"));
  // Untouched: the same scope, still on the visitor's tab.
  expect(document.querySelector("#a-tabs")).toBe(scope);
  expect(document.querySelector("#a-two")?.getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector<HTMLElement>("#a-p1")?.hidden).toBe(true);
  // Inserted: initialised.
  expect(document.querySelector("#b-one")?.getAttribute("role")).toBe("tab");
  expect(document.querySelector<HTMLElement>("#b-one")?.hidden).toBe(false);
  expect(document.querySelector("#b-one")?.getAttribute("aria-selected")).toBe("true");
});

it("changedBehaviourIsReinitialisedAndRemovedOneTornDown", async () => {
  const copy = (text: string) =>
    `<div data-portal-behavior="copy" id="copy"><code data-portal-copy-source>${text}</code>` +
    `<button type="button" data-portal-command="copy" hidden data-portal-enhanced-only>Copy</button></div>`;
  document.body.innerHTML = `<main data-portal-page>${copy("A")}<p>x</p></main>`;
  let next = page(`${copy("B")}<p>x</p>`);
  runtime = new PortalRuntime({ window, fetch: async () => response(next) });
  runtime.start();
  const scope = document.querySelector("#copy")!;
  expect(scope.querySelectorAll("[data-portal-copy-status]").length).toBe(1);
  const submit = async () => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/x";
    document.querySelector("main")!.append(form);
    form.requestSubmit();
  };
  await submit();
  await vi.waitFor(() => expect(document.querySelector("code")?.textContent).toBe("B"));
  // Changed: patched in place, then initialised again (one status, button shown).
  expect(document.querySelector("#copy")).toBe(scope);
  expect(scope.querySelectorAll("[data-portal-copy-status]").length).toBe(1);
  expect(scope.querySelector<HTMLElement>("button")?.hidden).toBe(false);
  next = page(`<p>x</p>`);
  await submit();
  await vi.waitFor(() => expect(document.querySelector("#copy")).toBeNull());
});

it("privilegedEventResponseMorphsThePage", async () => {
  document.body.innerHTML = `<main data-portal-page>${basket(["a", "b", "c"], "£30")}</main>`;
  const [lineA, , lineC] = Array.from(document.querySelectorAll("#lines li"));
  const note = document.querySelector<HTMLInputElement>('input[name="note"]')!;
  const fetcher = vi.fn<typeof fetch>(async () => response(page(basket(["a", "c"], "£20"))));
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  note.focus();
  note.value = "draft";
  document.querySelector<HTMLFormElement>("#c1")!.requestSubmit(document.querySelector<HTMLButtonElement>('button[value="update"]')!);
  await vi.waitFor(() => expect(document.querySelector("#basket-total")?.textContent).toBe("£20"));
  expect(fetcher.mock.calls[0][1]?.body instanceof URLSearchParams && (fetcher.mock.calls[0][1]!.body as URLSearchParams).get("_portal_region")).toBe("c1");
  // Data shown elsewhere updated; the line is gone; the rest kept their nodes.
  expect(Array.from(document.querySelectorAll("#lines li"))).toEqual([lineA, lineC]);
  expect(document.querySelector('input[name="note"]')).toBe(note);
  expect(note.value).toBe("draft");
  expect(document.activeElement).toBe(note);
  expect(scrollTo).not.toHaveBeenCalled();
  expect(location.pathname).toBe("/");
});

it("pureEventFragmentMorphsItsInstance", async () => {
  document.body.innerHTML = `<main data-portal-page>${basket(["a"], "£10")}</main>`;
  const root = document.querySelector('[data-portal-region="c1"]');
  const note = document.querySelector<HTMLInputElement>('input[name="note"]')!;
  const fragment = `<div data-portal-fragment="" data-portal-context="guest-1" data-portal-version="v1">` +
    `<div class="portal-line" data-portal-region="c1"><input form="c1" name="note" value=""><p>Saved</p>` +
    `<button form="c1" name="_portal_export" type="submit" value="update">Update</button></div>` +
    `<form action="${action}" data-portal-instance="" hidden id="c1" method="post"><input name="_portal_instance" type="hidden" value="t2"></form></div>`;
  runtime = new PortalRuntime({ window, fetch: async () => response(fragment) });
  runtime.start();
  note.focus();
  note.value = "draft";
  document.querySelector<HTMLFormElement>("#c1")!.requestSubmit(document.querySelector<HTMLButtonElement>('button[value="update"]')!);
  await vi.waitFor(() => expect(document.querySelector('[data-portal-region="c1"] p')?.textContent).toBe("Saved"));
  expect(document.querySelector('[data-portal-region="c1"]')).toBe(root);
  expect(note.value).toBe("draft");
  expect(document.activeElement).toBe(note);
  expect(document.querySelector<HTMLInputElement>('#c1 [name="_portal_instance"]')?.value).toBe("t2");
  expect(document.querySelectorAll("form[data-portal-instance]").length).toBe(1);
});

it("regionResponseMorphsAroundTheFocusedControl", async () => {
  document.body.innerHTML = `<main data-portal-page><section data-portal-region="quote"><input name="q" value="1"><p>€10</p></section></main>`;
  const input = document.querySelector("input")!;
  runtime = new PortalRuntime({ window, fetch: async () => response(`<section data-portal-region="quote"><input name="q" value="1"><p>€70</p></section>`) });
  runtime.start();
  input.focus();
  input.value = "7";
  await runtime.refreshRegion("quote", "/quote?q=7");
  expect(document.querySelector("p")?.textContent).toBe("€70");
  expect(document.querySelector("input")).toBe(input);
  expect(input.value).toBe("7");
  expect(document.activeElement).toBe(input);
});

it("redirectBackToTheCurrentURLMorphs", async () => {
  document.body.innerHTML = `<main data-portal-page><h1>Basket</h1><form method="post" action="/basket/add"><input name="sku" value="x"></form><p id="count">0</p></main>`;
  const fetcher = vi.fn<typeof fetch>(async () => {
    const result = response(page(`<h1>Basket</h1><form method="post" action="/basket/add"><input name="sku" value="x"></form><p id="count">1</p>`));
    Object.defineProperty(result, "redirected", { value: true });
    Object.defineProperty(result, "url", { value: "http://localhost:3000/" });
    return result;
  });
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  const length = history.length;
  const heading = document.querySelector("h1");
  document.querySelector("form")!.requestSubmit();
  await vi.waitFor(() => expect(document.querySelector("#count")?.textContent).toBe("1"));
  expect(history.length).toBe(length);
  expect(document.querySelector("h1")).toBe(heading);
  expect(document.activeElement).not.toBe(heading);
  expect(scrollTo).not.toHaveBeenCalled();
});

it("navigationStillSwapsMovingFocusAndResettingScroll", async () => {
  document.body.innerHTML = `<main data-portal-page><h1>Basket</h1><input id="q"></main>`;
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  runtime = new PortalRuntime({ window, fetch: async () => response(page(`<h1>Products</h1><input id="q">`, "Products")) });
  runtime.start();
  const input = document.querySelector<HTMLInputElement>("#q")!;
  input.focus();
  await runtime.navigate("/products");
  expect(location.pathname).toBe("/products");
  expect(document.querySelector("#q")).not.toBe(input);
  expect(document.activeElement?.textContent).toBe("Products");
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
  // A redirect to another URL swaps too.
  history.replaceState({}, "", "/basket");
});

it("redirectToAnotherURLSwaps", async () => {
  document.body.innerHTML = `<main data-portal-page><h1>Basket</h1><form method="post" action="/checkout"><input name="sku" value="x"></form></main>`;
  const fetcher = vi.fn<typeof fetch>(async () => {
    const result = response(page(`<h1>Orders</h1>`, "Orders"));
    Object.defineProperty(result, "redirected", { value: true });
    Object.defineProperty(result, "url", { value: "http://localhost:3000/orders" });
    return result;
  });
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  document.querySelector("form")!.requestSubmit();
  await vi.waitFor(() => expect(location.pathname).toBe("/orders"));
  expect(document.activeElement?.textContent).toBe("Orders");
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
});

/** An evented row as the host renders it: a positional `c<n>` and a stable key. */
const row = (n: number, line: string) =>
  `<li class="portal-line" data-portal-key="pk-${line}" data-portal-region="c${n}"><span>${line}</span>` +
  `<input form="c${n}" name="quantity" value="1"><button form="c${n}" name="_portal_export" type="submit" value="remove">Remove ${line}</button></li>`;
const rowForm = (n: number, line: string) =>
  `<form action="${action}" data-portal-instance="" hidden id="c${n}" method="post"><input name="_portal_instance" type="hidden" value="token-${line}"></form>`;
const rows = (lines: string[]) =>
  `<h1>Basket</h1><ul data-portal-region="basket">${lines.map((line, index) => row(index + 1, line)).join("")}</ul>` +
  lines.map((line, index) => rowForm(index + 1, line)).join("");

it("eventedRowsKeepIdentityDraftsAndFocusWhenAMiddleOneIsRemoved", async () => {
  document.body.innerHTML = `<main data-portal-page>${rows(["a", "b", "c"])}</main>`;
  const [a, b, c] = Array.from(document.querySelectorAll("li"));
  runtime = new PortalRuntime({ window, fetch: async () => response(page(rows(["a", "c"]))) });
  runtime.start();
  c.querySelector("input")!.value = "5";
  b.querySelector("input")!.value = "7";
  const remove = b.querySelector("button")!;
  remove.focus();
  document.querySelector<HTMLFormElement>("#c2")!.requestSubmit(remove);
  await vi.waitFor(() => expect(document.querySelectorAll("li").length).toBe(2));
  expect(Array.from(document.querySelectorAll("li"))).toEqual([a, c]);
  expect(b.isConnected).toBe(false);
  // c keeps its own draft and is renumbered; nothing of b's moved into it.
  expect(c.getAttribute("data-portal-region")).toBe("c2");
  expect(c.querySelector("input")!.value).toBe("5");
  expect(c.querySelector("span")!.textContent).toBe("c");
  expect(document.querySelector<HTMLInputElement>('#c2 [name="_portal_instance"]')!.value).toBe("token-c");
  // The focused button went with its row: focus is on the list, not on another row.
  const list = document.querySelector('[data-portal-region="basket"]');
  expect(document.activeElement).toBe(list);
  expect(list?.getAttribute("tabindex")).toBe("-1");
});

it("aConditionalFieldNeverTakesAnotherFieldsDraft", () => {
  document.body.innerHTML = `<main data-portal-page><form><div class="f"><input name="company" value=""></div><div class="f"><input name="email" value=""></div></form></main>`;
  const [company, email] = Array.from(document.querySelectorAll("input"));
  company.value = "Acme";
  email.value = "ann@example.com";
  morph(document.querySelector("form")!, `<form><div class="f"><input name="email" value=""></div></form>`);
  expect(document.querySelectorAll("input").length).toBe(1);
  expect(document.querySelector("input")).toBe(email);
  expect(email.value).toBe("ann@example.com");
  expect(company.isConnected).toBe(false);
});

it("aRenamedOrRetypedControlIsANewControl", () => {
  document.body.innerHTML = `<main data-portal-page><form><input name="code" value="a"><input name="note" value=""></form></main>`;
  const [code, note] = Array.from(document.querySelectorAll("input"));
  code.value = "typed";
  note.value = "draft";
  morph(document.querySelector("form")!, `<form><input name="code" type="hidden" value="server"><input name="memo" value=""></form>`);
  const [hidden, memo] = Array.from(document.querySelectorAll("input"));
  expect(hidden).not.toBe(code);
  expect(hidden.value).toBe("server");
  expect(memo).not.toBe(note);
  expect(memo.value).toBe("");
});

it("clientOwnedNodesAndAttributesSurviveALayoutMorph", async () => {
  const layout = (total: string, main: string) =>
    `<!doctype html><html data-portal-context="guest-1" data-portal-version="v1"><head><title>Basket</title></head>` +
    `<body><header><span id="total">${total}</span></header><main data-portal-page>${main}</main></body></html>`;
  document.body.innerHTML = `<header><span id="total">£30</span></header><main data-portal-page><h1>Basket</h1><p id="note">x</p></main>`;
  runtime = new PortalRuntime({ window, fetch: async () => response(layout("£20", `<h1>Basket</h1><p id="note">y</p><form method="post" action="/x"></form>`)) });
  runtime.start();
  // An extension's node before the layout, and a class it put on body.
  const injected = document.createElement("div");
  injected.id = "extension";
  document.body.prepend(injected);
  document.body.classList.add("ext-dark");
  const main = document.querySelector("main"), heading = document.querySelector("h1");
  const form = document.createElement("form");
  form.method = "post";
  form.action = "/x";
  main!.append(form);
  form.requestSubmit();
  await vi.waitFor(() => expect(document.querySelector("#total")?.textContent).toBe("£20"));
  expect(document.body.firstElementChild).toBe(injected);
  expect(document.body.classList.contains("ext-dark")).toBe(true);
  // The page was patched, not rebuilt.
  expect(document.querySelector("main")).toBe(main);
  expect(document.querySelector("h1")).toBe(heading);
  expect(document.querySelector("#note")?.textContent).toBe("y");
});

it("aRegionResponseRequestedBeforeAPageMorphDoesNotLandAfterIt", async () => {
  document.body.innerHTML = `<main data-portal-page><section data-portal-region="quote">Old</section><form method="post" action="/basket"></form></main>`;
  let resolveRegion!: (r: Response) => void;
  const fetcher = vi.fn<typeof fetch>((input) =>
    String(input).includes("/quote")
      ? new Promise<Response>((resolve) => (resolveRegion = resolve))
      : Promise.resolve(response(page(`<section data-portal-region="quote">From page</section><form method="post" action="/basket"></form>`))));
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  const region = runtime.refreshRegion("quote", "/quote");
  document.querySelector("form")!.requestSubmit();
  await vi.waitFor(() => expect(document.querySelector("[data-portal-region]")?.textContent).toBe("From page"));
  resolveRegion(response(`<section data-portal-region="quote">Stale</section>`));
  await region;
  expect(document.querySelector("[data-portal-region]")?.textContent).toBe("From page");
  expect(document.querySelector("[data-portal-region]")?.hasAttribute("aria-busy")).toBe(false);
});

it("aFormInFlightInsideAMorphedRegionIsInvalidatedAndUnlocked", async () => {
  document.body.innerHTML = `<main data-portal-page><section data-portal-region="cart"><form method="post" action="/save"><input name="q" value="1"><button>Save</button></form></section></main>`;
  let resolveSave!: (r: Response) => void;
  const fetcher = vi.fn<typeof fetch>((input) =>
    String(input).includes("/save")
      ? new Promise<Response>((resolve) => (resolveSave = resolve))
      : Promise.resolve(response(`<section data-portal-region="cart"><form method="post" action="/save"><input name="q" value="1"><button>Save</button></form><p>Fresh</p></section>`)));
  runtime = new PortalRuntime({ window, fetch: fetcher });
  runtime.start();
  const form = document.querySelector("form")!;
  form.requestSubmit();
  await vi.waitFor(() => expect(form.querySelector("input")!.disabled).toBe(true));
  await runtime.refreshRegion("cart", "/cart");
  expect(document.querySelector("form")).toBe(form);
  expect(form.querySelector("input")!.disabled).toBe(false);
  expect(form.hasAttribute("aria-busy")).toBe(false);
  // Its late response is discarded.
  resolveSave(response(page(`<p>Saved page</p>`)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(document.querySelector("[data-portal-region] p")?.textContent).toBe("Fresh");
});

it("focusInALaterSameNamedRowDoesNotReorderRows", () => {
  const rows = `<div class="rows"><p><input name="qty" value="1"></p><p><input name="qty" value="1"></p><p><input name="qty" value="1"></p></div>`;
  document.body.innerHTML = `<main data-portal-page>${rows}</main>`;
  const before = Array.from(document.querySelectorAll("p"));
  const inputs = before.map((p) => p.querySelector("input")!);
  inputs[0].value = "a";
  inputs[1].value = "b";
  inputs[2].value = "c";
  inputs[2].focus();
  inputs[2].setSelectionRange(1, 1);
  morph(document.querySelector(".rows")!, rows);
  expect(Array.from(document.querySelectorAll("p"))).toEqual(before);
  expect(Array.from(document.querySelectorAll("input"), (input) => input.value)).toEqual(["a", "b", "c"]);
  expect(document.activeElement).toBe(inputs[2]);
  expect(inputs[2].selectionStart).toBe(1);
});

it("aFocusedOrderRowKeepsItsOwnProduct", () => {
  const forms = ["p1", "p2", "p3"].map((product) =>
    `<form method="post" action="/basket"><input name="product" type="hidden" value="${product}"><input name="qty" value="1"><button>Add</button></form>`).join("");
  document.body.innerHTML = `<main data-portal-page><section>${forms}</section></main>`;
  const live = Array.from(document.querySelectorAll("form"));
  const qty = live[2].querySelector<HTMLInputElement>('[name="qty"]')!;
  qty.focus();
  qty.value = "4";
  morph(document.querySelector("section")!, `<section>${forms}</section>`);
  expect(Array.from(document.querySelectorAll("form"))).toEqual(live);
  const third = document.querySelectorAll("form")[2];
  expect(third.querySelector<HTMLInputElement>('[name="product"]')!.value).toBe("p3");
  expect(third.querySelector<HTMLInputElement>('[name="qty"]')!.value).toBe("4");
  expect(document.activeElement).toBe(qty);
  expect(new FormData(third).get("product")).toBe("p3");
});
