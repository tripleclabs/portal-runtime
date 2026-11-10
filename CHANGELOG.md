# Changelog

## 0.3.0 — 2026-11-10

- Handle component events. An event button (`name="_portal_export"`, associated with its instance's hidden `form[data-portal-instance]`) and an author's event form post through the ordinary form lifecycle, targeting the instance region (`_portal_region=c<n>`). A response carries fresh instance forms, which replace the live ones.
- Add live re-render for `data-portal-change`: input and change events inside the element debounce at 250 ms, a newer change aborts the request in flight, and only that instance's live parts (`c<n>-<part>`) are replaced, never one holding the focused control. When the instance root holds the focused control, an event response updates its live parts instead.
- Merge the host's per-response component CSS (`style[data-portal-components]`, one component per line) on page and region swaps, de-duplicated by rule (`adoptComponentStyles`); it no longer forces full navigation.
- A 409 from a component event reloads the page, as for actions.
- A component event answered with a whole document (its instance moved or was removed) swaps the page instead of failing the region swap.

## 0.2.0 — 2026-11-10

- Add the `copy` behaviour: copies a scoped source to the clipboard, marks the scope `data-portal-copied` for two seconds and announces a polite confirmation. The announcement reads a hidden `[data-portal-copied-text]` child first (localisable), re-announces on a repeat copy, and completes an author-supplied `[data-portal-copy-status]` with live-region semantics.
- Merge the host's per-response icon rules (`style[data-portal-icons]`) on page and region swaps; they no longer force full navigation.
- Dialogs defer to native invoker commands (`command`/`commandfor`) where the browser supports them, still restoring focus to the opener on close.
- Add typed mount-aware URL helpers, preview selection preservation and client routing-context fences.
- Keep navigation and region fetches inside the host mount; preserve native asset/endpoint handling.

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
