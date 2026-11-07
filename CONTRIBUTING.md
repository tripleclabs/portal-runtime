# Contributing

Use Node.js 22.18 or newer and the pnpm version declared in `package.json`. Install with `pnpm install --frozen-lockfile`; do not introduce another package-manager lockfile.

Changes should include focused regression tests for observable behavior. Run the development checks in the README. Browser changes should include the Chromium smoke test, which covers real HTTP navigation, regions, forms, history, and JavaScript-disabled rendering using checked-in SSR fixtures.

The public package must remain independent of private repositories and platform build tools. Keep credentials, customer data, and private integration artifacts out of examples, tests, and commits. The library has no production dependencies.

## Releases

1. Update `package.json` and `CHANGELOG.md`. Until 1.0, incompatible API or server-contract changes require a minor version bump.
2. Run type checks, unit tests, the package smoke test, and browser tests from a clean checkout.
3. Run `pnpm build` and commit `dist/` with the corresponding source. GitHub installs use these files directly; do not add an install-time build hook.
4. Review the complete staged tree, including package contents. Push the reviewed commit and wait for CI to pass.
5. Tag that commit `v<version>`. Consumers should pin its full SHA in addition to committing their lockfile.

There is no npm release step. Pull requests should explain the behavior changed and how it was tested.
