# Changelog

## 0.1.1 — 2026-11-07

- Preserve cross-page anchors when Fetch omits the fragment from response URLs.
- Delegate redirected GET navigation to the browser to resolve redirect fragments correctly.
- Fall back to full navigation when server HTML-root attributes or structural head content change, while preserving local root mutations for compatible responses.

## 0.1.0 — 2026-11-07

Initial MIT release, distributed through GitHub.

- Observable state, cancellable request scopes, submission generations, and runtime lifetime leases.
- Progressive page navigation and named-region updates for server-rendered HTML.
- Native fallback for incompatible context, version, assets, or page shells.
- Form duplicate-submission prevention, stale-response protection, and POST/303 handling.
- Metadata, focus, scroll, history, and back/forward-cache lifecycle handling.
- Typed ESM exports and a standalone browser module, with unit and Chromium integration tests.
