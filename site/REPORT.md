# A11y Verification Report — opencode-cline-free landing page

Adapted from the upstream `docs/en/templates/REPORT.md`, A11Y.md version 2.4.0. This is a versioned project record, not a certification or release approval.

> Marking legend: `[x]` verified with evidence · `[!]` verified and failed · `[~]` partially verified · `[ ]` not verified with reason. Self-reported static evidence cannot establish conformance.

## 📌 Validation Context

- **Feature/Epic:** Adapt the hero to opencode-cline-free messaging and feature icons.
- **Test Date:** 10/17/2026
- **Covers interface as of:** Install-button contrast correction based on main `47253830ec75085f1fe216b6a8add1fc89cc17af`; source and report are updated together.
- **Standard version:** 2.4.0 — https://github.com/fecarrico/A11Y.md/blob/main/docs/en/A11Y.md
- **Compliance Status:** ⚠️ CONDITIONAL — production build and static checks passed; known MEDIA-001 prevents an AA conformance claim.
- **Verification Independence:** self-reported — Notion AI, session 3fcfa123-3036-8078-a1a7-00a9021947cb, also generated the code.
- **Static gate (`verify-a11y.py`):** PASS (0 errors, 66 warnings) — run on: 2026-10-17; static-only scope, not conformance.

## 1. Technical Verification (Automated & Semantics)

- [ ] **Axe-Core / Lighthouse:** Not run; owner explicitly declined build and browser preview. Yasir or reviewer to run against a build before merge.
- [x] **HTML Semantics:** Source review: CTAs use Button asChild anchors, setup/copy actions use native buttons. Hero has no client hydration requirement.
- [x] **Heading Hierarchy (H1-H6):** Source review: one H1 in HeroSection02, H2 collection/setup/tutorial/capabilities, H3 tool names and setup-panel titles.
- [x] **Type checks:** `pnpm run check` (Astro): zero errors/warnings/hints. `pnpm exec tsc --noEmit`: passed after removing deprecated baseUrl.
- [~] **Formatting:** Changed code/configuration files pass targeted Prettier check. Full format command has baseline findings in unchanged Terminal.astro and EXCEPTIONS.md; not reformatted out of scope.

## 2. Tab Order and Focus Management

- [~] **Focus Indicator:** Source retains 2px outline with 4px offset; token ratios below. Visual ring placement and obstruction not browser-tested.
- [ ] **Logical Navigation:** No keyboard navigation performed per static-only instruction. Reviewer: first Tab reaches skip link; Enter targets hero heading past header; continue through GitHub and Install plugin, setup buttons, copy action and tutorial player.
- [x] **Captured Focus (Modals/Overlays):** N/A — no modals, drawers or overlays added.

## 3. Behavior and Task Return

- [ ] **Screen Reader Test:** No desktop/mobile screen-reader pair available or run. Yasir/reviewer must verify named controls, landmarks, heading order, setup announcements, copy feedback and player operation.
  - Pair(s) used: None; suggested NVDA + Firefox and VoiceOver + Safari.
  - Who ran it and when: Not run; assigned to human reviewer before release.
  - Scenarios run: Source review only; none navigated. Inventory and pending expected-behavior checks:
    - `guide-buttons`: keyboard Enter/Space, Tab order and visible focus; names announced as buttons; mobile double-tap. Pending human validation.
    - `guide-navigation`: skip link first, bypasses header; landmark and link names; mobile swipe order. Pending human validation.
    - `guide-toasts-notifications`: copy success/failure and step updates use persistent role=status without moving focus. Announcement timing and repeated updates pending.
    - `guide-images`: generic tool thumbnails and unrelated brand logos removed. Existing local plugin logo accompanies the cline-free wordmark; local decorative feature icons accompany equivalent visible or screen-reader text. Empty logo alternative and icon hiding are source-checked; visual rendering pending.
    - `guide-media`: existing informative audio-bearing tutorial classification retained from approved decision log. Frame title, no autoplay and external link source-checked; caption toggle, keyboard controls and audio-description assessment pending.
    - `guide-responsive-mobile`: 320px reflow, 200% text sizing, text spacing and touch target checks pending browser review.
    - `guide-cognitive`: no site authentication or form; setup instruction contents stay available without JavaScript; long-copy/text-spacing stress pending.
    - `guide-carousels-sliders`: N/A automatic carousel scenarios — Marquee is a static grid with no duplicate/off-screen slides, no navigation or motion controls.
    - `guide-framework-mapping`: Astro owns setup state and status IDs; React renders static hero; ARIA target IDs source-checked.
- [~] **Voice Control:** Source names match visible GitHub/Install plugin/Install/Connect/Choose and Copy labels; Copied and Select & copy names update on those states. No platform voice-control test run.
- [~] **Interactive states inventoried:** code-read only: default/hover/focus CTA; selected/unselected setup controls; initial/copy-success/copy-failure; tutorial stopped/playing delegated to YouTube. No state navigated in browser.
- [~] **Status Change (`aria-live`):** Persistent `#status` role=status retained; setup and clipboard handlers set its text. Announcements not heard.
- [x] **Form Filling:** N/A — no input fields.

## 4. Visual Perception and Comprehension

- [~] **Text & UI Contrast:** Computed from CSS HSL tokens using WCAG relative luminance; rounded 8-bit equivalents below. All listed pairs meet AA floors. Text-panel gradient compositing, antialiasing, primary 90% opacity hover, icon artwork and actual rendered surfaces remain unverified. No mix-blend-overlay text remains.

| Pair             | Foreground | Background |   Ratio | Floor | Result |
| :--------------- | :--------- | :--------- | ------: | ----: | :----- |
| ink / bg         | #1c2126    | #fcfaf8    | 15.58:1 | 4.5:1 | ✅     |
| ink / panel      | #1c2126    | #ffffff    | 16.22:1 | 4.5:1 | ✅     |
| ink / raised     | #1c2126    | #f3f1ed    | 14.38:1 | 4.5:1 | ✅     |
| muted / bg       | #49525a    | #fcfaf8    |  7.65:1 | 4.5:1 | ✅     |
| muted / panel    | #49525a    | #ffffff    |  7.96:1 | 4.5:1 | ✅     |
| muted / raised   | #49525a    | #f3f1ed    |  7.06:1 | 4.5:1 | ✅     |
| soft / bg        | #596169    | #fcfaf8    |  6.04:1 | 4.5:1 | ✅     |
| bg / ink         | #fcfaf8    | #1c2126    | 15.58:1 | 4.5:1 | ✅     |
| panel / muted    | #ffffff    | #49525a    |  7.96:1 | 4.5:1 | ✅     |
| accent / bg      | #174c82    | #fcfaf8    |  8.43:1 |   3:1 | ✅     |
| accent / panel   | #174c82    | #ffffff    |  8.78:1 |   3:1 | ✅     |
| accent / raised  | #174c82    | #f3f1ed    |  7.78:1 |   3:1 | ✅     |
| control / bg     | #717a84    | #fcfaf8    |  4.19:1 |   3:1 | ✅     |
| control / panel  | #717a84    | #ffffff    |  4.36:1 |   3:1 | ✅     |
| control / raised | #717a84    | #f3f1ed    |  3.86:1 |   3:1 | ✅     |

- [x] **Redundancy:** Source review: setup selection has aria-pressed plus border/background; copy success/failure uses explicit words, not color alone.
- [ ] **Scale / Zoom:** Not run under static-only instruction. Reviewer must check 320/375/768/1024/1440px, 200% text sizing, 400% equivalent reflow, long headings, logo wraps and expanded paragraph/letter/word spacing. No visual QA claimed.

## 5. Time-Based Media and Motion

- [x] **Classification:** Existing decision log confirms tutorial informative with audio; retained unchanged. Supplied still images/badges confirmed decorative by Yasir in this session.
- [!] **Alternatives:** Existing MEDIA-001: tutorial has no human-reviewed synchronized captions. Transcript and audio-description requirements remain unresolved. See EXCEPTIONS.md; no production exception approved.
- [~] **Autoplay and Moving Content:** Source: no autoplay; gradient and Marquee static; no flashing/looping CSS animation. Third-party player behavior not tested.
- [~] **Reduced Motion:** New hero has no automatic motion at any preference, and prior entrance/press animation removed. No browser preference test run.
- [x] **Text over Media:** N/A — no text over moving media.

## 6. Cognitive Load and Flow

- [~] **Nothing to remember:** Instructional selector only, no site authentication. All setup panels render visibly when JavaScript is unavailable; script progressively hides inactive ones. Actual OpenCode workflow is outside this site’s verification scope.
- [x] **Nothing to retype:** N/A — no site forms or redundant data-entry flow.
- [x] **Help in the same place:** Single route; tutorial and external fallback stay in the same reading order.
- [ ] **Text spacing:** Not tested; browser needed. Containers use content-driven heights and wrapping; reviewer to apply WCAG text-spacing overrides.
- [x] **Timing:** N/A — no time limits, disappearing feedback or automatic rotation added.
- [x] **Conflicting needs:** No motion chosen; tool content remains stationary. No animation-dependent information or competing input modes introduced.

## 7. Functional Performance

N/A — no formal EN 301 549 / VPAT declaration. Hearing access is blocked by MEDIA-001; other functional performance claims require human validation.

## 📝 Assessment Notes or Known Blockers

- MEDIA-001 remains an open HIGH issue, not an accepted exception. No risk owner/approver or external issue is assigned. Retaining written setup is not a caption substitute.
- Production build subsequently authorized and passed. No browser preview/render, screenshots, axe scan, clipboard execution, navigation, player test or assistive-technology test performed.
- Static check commands: `pnpm run check`; `pnpm exec tsc --noEmit`; targeted Prettier; `python /data/a11y/verify-a11y.py site --src src` from repository root. Gate is fetched from the standard’s upstream `tools/verify-a11y.py`, not installed into this project.
- Static gate does not establish conformance. Its 62 warnings comprise the known failed media checkpoint, self-reported verification and 60 expected hex-literal warnings: source tokens use HSL while both evidence tables record their computed hex equivalents. The baseline Terminal.astro is not part of this redesign and is not reformatted.
- Before merge: independent fresh-context review, browser layout/state checks, local logo and illustration review and all pending human scenarios. Before production AA claim: resolve MEDIA-001.

## Build-failure follow-up (2026-10-17)

This follow-up supersedes the earlier no-build limitation for build verification only. Browser, assistive-technology and MEDIA-001 findings above are unchanged; conformance remains conditional.

- Reproduced the missing `@aliimam/logos/dist/index.cjs` failure using the previous main-branch configuration.
- Root cause: the package declares a missing CJS entry. Astro 7 uses `vite.resolve.noExternal`; the earlier `vite.ssr.noExternal` setting did not bundle the dependency during prerendering.
- Corrected only that configuration key; retained the package's valid ESM entry and existing dependencies.
- Clean worktree at `4a22278`, patched configuration: `npm ci`, `npm run check` (zero errors, warnings or hints), and `npm run build` all passed using the committed npm lockfile (Astro 7.3.8).
- Existing pnpm installation (Astro 7.4.0): build, Astro check, TypeScript and configuration formatting also passed.
- Verification remains self-reported. No browser preview, keyboard interaction or screen-reader test was run. CI/deployment result must be checked after push.

## Plugin-specific content follow-up (2026-10-17)

- Replaced all design-tool copy, unrelated vendor badges and third-party thumbnails with README-grounded plugin messaging, local capability illustrations and the existing plugin logo.
- Hero CTA now targets the written setup section. Feature cards cover discovery, sign-in options, failover and session pinning. Daily quota, OpenCode 2.x and paid-credit caveats remain explicit; no fixed/current model list is promised.
- Clean `npm ci`, `npm run check` (zero diagnostics), `tsc --noEmit` and `npm run build` passed. Targeted formatting and `git diff --check` passed.
- Parsed built HTML to verify one H1, four feature cards, resolved internal anchors, local base-prefixed logo path, paid-credit caveat and absence of template brand names/CDN thumbnails. This is not a visual/browser test.
- No browser or assistive-technology validation was performed. MEDIA-001 and existing human-review requirements remain open.

## Install-button contrast correction (2026-10-17)

This targeted browser check supersedes earlier no-browser statements for the install CTA only. Full-page visual, keyboard, screen-reader and independent checks remain outstanding; conformance is still conditional.

- Reproduced in the built page: the unlayered global anchor rule overrode Tailwind’s layered foreground utility, producing `rgb(28, 33, 38)` text on the same background (1.00:1).
- Moved the default anchor styling into `@layer base`, allowing button foreground utilities to win without changing the palette or component API.
- Verified the production build in sandbox-local headless Chromium using Playwright, with external network resources blocked. Computed text colors were compared with actual screenshot background pixels using WCAG relative luminance.

| Pair                                          | Foreground | Background |   Ratio | Floor | Result |
| :-------------------------------------------- | :--------- | :--------- | ------: | ----: | :----- |
| Install CTA default / keyboard focus / mobile | #fcfaf8    | #1c2126    | 15.58:1 | 4.5:1 | ✅     |
| Install CTA hover, composited background      | #fcfaf8    | #32373b    | 11.56:1 | 4.5:1 | ✅     |

- Verified default, hover and keyboard-focus states at 1440px, plus default at 375px and 320px. Browser confirmed `:focus-visible` on keyboard focus and no document horizontal overflow at the tested widths. This is not full keyboard-flow validation.
- Clean npm installation, production build, Astro check (zero diagnostics), TypeScript, CSS formatting and diff whitespace checks passed.
- Evidence is self-reported; no screen-reader, voice-control or full accessibility pass is claimed. MEDIA-001 is unchanged.

Static-gate follow-up: PASS, 0 errors and 66 warnings; known media/self-reported warnings plus HSL-to-hex evidence notices, including the screenshot-measured hover pair.
