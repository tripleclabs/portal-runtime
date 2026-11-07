import { describe, expect, it, vi } from "vitest";
import {
  FormActivity,
  RequestScope,
  RuntimeLeases,
  StateStore,
} from "../src/state.js";

it("publishes stable state snapshots and detaches observers", () => {
  const state = new StateStore({ count: 0 });
  const listener = vi.fn(),
    stop = state.subscribe(listener);
  state.set(state.getSnapshot());
  expect(listener).not.toHaveBeenCalled();
  state.set({ count: 1 });
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  state.set({ count: 2 });
  expect(listener).toHaveBeenCalledTimes(1);
});
it("rejects superseded responses even when transport ignores cancellation", () => {
  const scope = new RequestScope();
  const first = scope.begin("quote"),
    second = scope.begin("quote"),
    other = scope.begin("orders");
  expect(first.signal.aborted).toBe(true);
  first.finish();
  expect(second.isCurrent()).toBe(true);
  scope.reset();
  expect(second.isCurrent()).toBe(false);
  expect(other.signal.aborted).toBe(true);
});
it("leases retain Workspace engine across StrictMode reconnect, disposing once", async () => {
  const leases = new RuntimeLeases(),
    runtime = { start: vi.fn(), dispose: vi.fn() };
  const release = leases.acquire(runtime);
  release();
  release();
  const releaseAgain = leases.acquire(runtime);
  await Promise.resolve();
  expect(runtime.dispose).not.toHaveBeenCalled();
  releaseAgain();
  await Promise.resolve();
  expect(runtime.dispose).toHaveBeenCalledTimes(1);
});
describe("form lifecycle", () => {
  it("prevents duplicate writes and discards response after identity invalidation", async () => {
    const form = new FormActivity(),
      apply = vi.fn();
    let resolve!: (value: string) => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const pending = form.submit(operation, apply);
    expect(await form.submit(operation, apply)).toBe(false);
    expect(operation).toHaveBeenCalledTimes(1);
    form.invalidate();
    resolve("old customer order");
    expect(await pending).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
  it("reports errors without retrying a possibly completed write", async () => {
    const form = new FormActivity(),
      error = new Error("connection lost");
    const operation = vi.fn(async () => {
      throw error;
    });
    expect(await form.submit(operation, vi.fn())).toBe(false);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(form.state.getSnapshot()).toEqual({ pending: false, error });
  });
});
it("form apply callbacks cannot clear the pending state of a newer submission", async () => {
  const form = new FormActivity();
  let resolve!: (value: string) => void;
  let followup!: Promise<boolean>;
  const first = await form.submit(
    async () => "first",
    () => {
      form.invalidate();
      followup = form.submit(
        () =>
          new Promise<string>((r) => {
            resolve = r;
          }),
        () => {},
      );
    },
  );
  expect(first).toBe(false);
  expect(form.state.getSnapshot().pending).toBe(true);
  resolve("second");
  expect(await followup).toBe(true);
  expect(form.state.getSnapshot().pending).toBe(false);
});
