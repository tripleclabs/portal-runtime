import { afterEach, expect, it, vi } from "vitest";
import { PortalBehaviors } from "../src/behaviors.js";

let behaviors: PortalBehaviors | undefined;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const copyScope = (sources = 1) =>
  `<div data-portal-behavior="copy">${'<code data-portal-copy-source>\n  sk_test_51Hb\n</code>'.repeat(sources)}<button type="button" data-portal-command="copy" data-portal-enhanced-only hidden data-portal-copied-message="Key copied">Copy</button></div>`;
const clipboard = (writeText: (text: string) => Promise<void>) =>
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
afterEach(() => {
  behaviors?.dispose(); behaviors = undefined;
  delete (navigator as { clipboard?: unknown }).clipboard;
  delete (HTMLButtonElement.prototype as { commandForElement?: unknown }).commandForElement;
  vi.restoreAllMocks(); vi.useRealTimers();
});

it("copy writes source text and marks the scope copied", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn(async (_: string) => {}); clipboard(writeText);
  document.body.innerHTML = copyScope();
  behaviors = new PortalBehaviors(document); behaviors.start();
  const scope = document.querySelector<HTMLElement>("[data-portal-behavior]")!, button = scope.querySelector("button")!;
  expect(button.hidden).toBe(false);
  const status = scope.querySelector('[aria-live="polite"]')!;
  expect(status.textContent).toBe("");
  button.click(); await flush();
  expect(writeText).toHaveBeenCalledWith("sk_test_51Hb");
  expect(scope.hasAttribute("data-portal-copied")).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(status.textContent).toBe("Key copied");
  await vi.advanceTimersByTimeAsync(2000);
  expect(scope.hasAttribute("data-portal-copied")).toBe(false);
  expect(status.textContent).toBe("");
});

it("copy reads an input's value and announces the default message", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn(async (_: string) => {}); clipboard(writeText);
  document.body.innerHTML = '<div data-portal-behavior="copy"><input readonly value="https://example.test/hook" data-portal-copy-source><button type="button" data-portal-command="copy" data-portal-enhanced-only hidden>Copy</button></div>';
  behaviors = new PortalBehaviors(document); behaviors.start();
  document.querySelector("button")!.click(); await flush();
  expect(writeText).toHaveBeenCalledWith("https://example.test/hook");
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe("Copied");
});

it("copy announces the scoped localised text, before the attribute and the default", async () => {
  vi.useFakeTimers();
  clipboard(vi.fn(async (_: string) => {}));
  document.body.innerHTML =
    copyScope().replace("</div>", '<span data-portal-copied-text hidden>\n  Schlüssel kopiert\n</span></div>') +
    // A nested scope's text belongs to that scope only.
    '<div data-portal-behavior="copy"><code data-portal-copy-source>b</code><button type="button" data-portal-command="copy" data-portal-enhanced-only hidden>Copy</button>' +
    '<div data-portal-behavior="other"><span data-portal-copied-text>Not mine</span></div></div>';
  behaviors = new PortalBehaviors(document); behaviors.start();
  const [localised, plain] = document.querySelectorAll<HTMLElement>('[data-portal-behavior="copy"]');
  localised.querySelector("button")!.click(); await flush(); await vi.advanceTimersByTimeAsync(0);
  expect(localised.querySelector("[data-portal-copy-status]")!.textContent).toBe("Schlüssel kopiert");
  plain.querySelector("button")!.click(); await flush(); await vi.advanceTimersByTimeAsync(0);
  expect(plain.querySelector("[data-portal-copy-status]")!.textContent).toBe("Copied");
});

it("a repeat copy within the copied window clears and re-announces", async () => {
  vi.useFakeTimers();
  clipboard(vi.fn(async (_: string) => {}));
  document.body.innerHTML = copyScope();
  behaviors = new PortalBehaviors(document); behaviors.start();
  const scope = document.querySelector<HTMLElement>("[data-portal-behavior]")!, button = scope.querySelector("button")!;
  const status = scope.querySelector("[data-portal-copy-status]")!;
  const texts: string[] = [];
  new MutationObserver(() => texts.push(status.textContent ?? "")).observe(status, { childList: true, characterData: true, subtree: true });
  button.click(); await flush(); await vi.advanceTimersByTimeAsync(0);
  expect(status.textContent).toBe("Key copied");
  await vi.advanceTimersByTimeAsync(1000);
  button.click(); await flush();
  expect(status.textContent).toBe("");
  await vi.advanceTimersByTimeAsync(0);
  expect(status.textContent).toBe("Key copied");
  await flush();
  expect(texts.filter(text => text === "Key copied").length).toBe(2);
  // The copied window restarts from the second copy.
  await vi.advanceTimersByTimeAsync(1500);
  expect(scope.hasAttribute("data-portal-copied")).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(scope.hasAttribute("data-portal-copied")).toBe(false);
  expect(status.textContent).toBe("");
});

it("an author-supplied copy status gets live-region semantics", async () => {
  document.body.innerHTML = copyScope().replace("</div>", '<span data-portal-copy-status class="sr"></span></div>') +
    copyScope().replace("</div>", '<p data-portal-copy-status role="alert" aria-live="assertive"></p></div>');
  behaviors = new PortalBehaviors(document); behaviors.start();
  const [plain, explicit] = document.querySelectorAll("[data-portal-copy-status]");
  expect(document.querySelectorAll("[data-portal-copy-status]").length).toBe(2);
  expect(plain.getAttribute("role")).toBe("status");
  expect(plain.getAttribute("aria-live")).toBe("polite");
  expect(explicit.getAttribute("role")).toBe("alert");
  expect(explicit.getAttribute("aria-live")).toBe("assertive");
});

it("copy button stays hidden for an invalid scope (two sources)", async () => {
  const writeText = vi.fn(async (_: string) => {}); clipboard(writeText);
  document.body.innerHTML = copyScope(2);
  behaviors = new PortalBehaviors(document); behaviors.start();
  const button = document.querySelector("button")!;
  expect(button.hidden).toBe(true);
  button.hidden = false; button.click(); await flush();
  expect(writeText).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-live="polite"]')).toBeNull();
});

it("copy failure leaves no copied state", async () => {
  clipboard(async () => { throw new DOMException("Denied", "NotAllowedError"); });
  document.body.innerHTML = copyScope();
  behaviors = new PortalBehaviors(document); behaviors.start();
  const scope = document.querySelector<HTMLElement>("[data-portal-behavior]")!;
  scope.querySelector("button")!.click(); await flush();
  expect(scope.hasAttribute("data-portal-copied")).toBe(false);
  expect(scope.querySelector('[aria-live="polite"]')!.textContent).toBe("");
});

it("copy without a clipboard API leaves no copied state", async () => {
  document.body.innerHTML = copyScope();
  behaviors = new PortalBehaviors(document); behaviors.start();
  const scope = document.querySelector<HTMLElement>("[data-portal-behavior]")!;
  expect(() => scope.querySelector("button")!.click()).not.toThrow(); await flush();
  expect(scope.hasAttribute("data-portal-copied")).toBe(false);
});

const dialogScope = '<div data-portal-behavior="dialog"><button type="button" data-portal-command="open" command="show-modal" commandfor="details" data-portal-enhanced-only hidden>Open</button><dialog id="details" aria-label="Details"><button type="button" data-portal-command="close" command="close" commandfor="details">Close</button></dialog></div>';
function stubDialog() {
  const dialog = document.querySelector("dialog")!;
  const showModal = vi.fn(() => { dialog.open = true; });
  dialog.showModal = showModal;
  const close = vi.fn(() => { dialog.open = false; dialog.dispatchEvent(new Event("close")); });
  dialog.close = close;
  return { dialog, showModal, close };
}

// Mirrors the platform: the element named by commandfor, or null.
const supportInvokers = () => Object.defineProperty(HTMLButtonElement.prototype, "commandForElement", {
  configurable: true, get(this: HTMLButtonElement) { return this.ownerDocument.getElementById(this.getAttribute("commandfor") ?? "") ?? null; },
});

it("dialog defers to native invoker commands when supported", () => {
  supportInvokers();
  document.body.innerHTML = dialogScope;
  const { dialog, showModal, close } = stubDialog();
  behaviors = new PortalBehaviors(document); behaviors.start();
  const [open, dismiss] = document.querySelectorAll("button");
  expect(open.hidden).toBe(false);
  const opened = new MouseEvent("click", { bubbles: true, cancelable: true });
  open.dispatchEvent(opened);
  expect(showModal).not.toHaveBeenCalled();
  expect(opened.defaultPrevented).toBe(false);
  dismiss.click();
  expect(close).not.toHaveBeenCalled();
  // The browser opened and closed it natively; the runtime still returns focus.
  dialog.open = true; dialog.dispatchEvent(new Event("close"));
  expect(document.activeElement).toBe(open);
});

it("dialog falls back to showModal without invoker support", () => {
  document.body.innerHTML = dialogScope;
  const { dialog, showModal, close } = stubDialog();
  behaviors = new PortalBehaviors(document); behaviors.start();
  const [open, dismiss] = document.querySelectorAll("button");
  open.click();
  expect(showModal).toHaveBeenCalledTimes(1); expect(dialog.open).toBe(true);
  dismiss.click();
  expect(close).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(open);
});

it("dialog falls back to showModal when commandfor names another element", () => {
  supportInvokers();
  document.body.innerHTML = dialogScope.replaceAll('commandfor="details"', 'commandfor="elsewhere"');
  const { dialog, showModal, close } = stubDialog();
  behaviors = new PortalBehaviors(document); behaviors.start();
  const [open, dismiss] = document.querySelectorAll("button");
  open.click();
  expect(showModal).toHaveBeenCalledTimes(1); expect(dialog.open).toBe(true);
  dismiss.click();
  expect(close).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(open);
});
