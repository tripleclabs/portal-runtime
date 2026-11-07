import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { StateStore, RequestScope, SubmissionClock } from "../dist/index.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.name, "@wearecococo/portal-runtime");
assert.equal(manifest.license, "MIT");
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
for (const entry of Object.values(manifest.exports)) {
  const paths = typeof entry === "string" ? [entry] : Object.values(entry as Record<string, string>);
  for (const path of paths) await access(new URL(`../${path}`, import.meta.url));
}
const state = new StateStore(0);
let changes = 0;
const unsubscribe = state.subscribe(() => changes++);
state.set(1);
unsubscribe();
state.set(2);
assert.equal(changes, 1);
assert.equal(state.getSnapshot(), 2);
const scope = new RequestScope();
const old = scope.begin("quote");
const current = scope.begin("quote");
assert.equal(old.signal.aborted, true);
assert.equal(current.isCurrent(), true);
scope.reset();
assert.equal(current.isCurrent(), false);
const clock = new SubmissionClock();
const token = clock.next();
assert.equal(clock.isCurrent(token), true);
console.log("Built package exports and state primitives passed");
