# A11y verification report: landing-page artwork, copy and motion

Adapted from upstream `docs/en/templates/REPORT.md`, A11Y.md version 2.4.0.
This versioned record is evidence of the checks below, not certification.

> Marking legend: `[x]` verified with evidence · `[!]` verified and failed ·
> `[~]` partially verified · `[ ]` not verified, with reason.

## 📌 Validation Context

- **Feature/Epic:** Official product marks, four generated capability illustrations, concrete plugin copy and coordinated marketing motion.
- **Test Date:** 10/17/2026
- **Covers interface as of:** This artwork/copy/motion revision, based on main `f1626817b677bdb0fe054cfda650d3462fee496f`; source and report committed together. Plugin version remains 0.9.0.
- **Standard version:** 2.4.0, <https://github.com/fecarrico/A11Y.md/blob/main/docs/en/A11Y.md>.
- **Compliance Status:** ⚠️ CONDITIONAL. Known MEDIA-001 and pending human/independent verification prevent an AA conformance claim.
- **Verification Independence:** self-reported. Notion AI, session `3fcfa123-3036-8108-8e47-00a9ad5c6736`, also implemented this revision. No further agent was used, as requested.
- **Static gate (`verify-a11y.py`):** PASS (0 errors, 68 warnings), run on 2026-10-17. Warnings are the open media checkpoint, self-reported verification and 66 expected HSL/composited-color versus hex-literal evidence notices. Static scope only, not conformance.

## 1. Technical Verification (Automated & Semantics)

- [x] **Axe-Core / Lighthouse:** axe-core 4.10.3 in sandbox-local Chromium, all three selected setup states, zero violations with `label-content-name-mismatch` enabled. Incomplete checks remain `color-contrast` on gradient surfaces and `frame-tested` for the external tutorial. The third-party player was excluded from local network tests, not passed by proxy. Lighthouse was not run.
- [x] **HTML Semantics:** Native links and setup/copy buttons; no clickable generic elements. Static React hero does not require client hydration. ARIA relationship targets and fragment destinations resolve in built HTML.
- [x] **Heading Hierarchy (H1-H6):** One H1; H2 section headings and H3 card/setup headings. No skipped levels.
- [x] **Clean install and build:** `npm ci`, `npm run check` and `npm run build` in `site` passed using the committed npm lockfile. Astro check returned zero errors, warnings or hints. `./node_modules/.bin/tsc --noEmit` passed.
- [x] **Plugin regression:** Clean root `npm ci`, `npm run typecheck` and `npm test` passed, all 133 tests. No plugin runtime, bundle or model registry was edited.
- [~] **Formatting:** Targeted Prettier and whitespace checks cover every changed source/document file. Full-site formatting has pre-existing findings in untouched `EXCEPTIONS.md` and `src/components/Terminal.astro`; they remain out of scope.
- [x] **Prior fixes retained:** Astro 7 uses `vite.resolve.noExternal` for `@aliimam/logos`; global link defaults remain in `@layer base`, so the install CTA's foreground utility wins.

## 2. Tab Order and Focus Management

- [x] **Focus Indicator:** Browser keyboard focus on the install CTA has `:focus-visible`, a 2px outline and 4px offset. Accent/surface ratios are recorded below. No fixed header obscures the ring.
- [x] **Logical Navigation:** Chromium keyboard automation verified first Tab reaches the visible skip link and Enter focuses the hero heading past the header. Native setup buttons accept Enter/Space, retain focus and update the selected panel. Keyboard changes start no animations.
- [x] **Captured Focus (Modals/Overlays):** N/A. No modal, drawer, popup or focus trap exists in this revision.
- [ ] **Human keyboard pass:** Yasir/reviewer must reproduce the complete flow in a desktop browser and within the real tutorial player. Automation is not an assistive-technology session.

## 3. Behavior and Task Return

- [ ] **Screen Reader Test:** No screen-reader/browser pair was available or run. Human reviewer must test desktop NVDA + Firefox or VoiceOver + Safari and mobile VoiceOver + Safari or TalkBack + Chrome.
  - Pair(s) used: None.
  - Who ran it and when: Pending Yasir or an assigned human reviewer.
  - Interface inventory and expected-behavior scenarios:
    - `guide-buttons`: native names, Enter/Space, target size and visible focus; browser keyboard actions verified, announcements and mobile double-tap pending.
    - `guide-navigation`: first skip link, heading destination, distinct primary/resource navigation and valid link destinations; keyboard/DOM verified, landmark reading and swipe order pending.
    - `guide-toasts-notifications`: persistent `#status` for step changes and clipboard success/denial, no focus transfer; DOM outcomes verified, spoken timing and repeated announcements pending.
    - `guide-images`: official marks beside visible names and four generated illustrations beside equivalent copy use the already approved decorative pattern. Every new image loads locally at the GitHub Pages base path. All four crops, the SVG delivery render, and desktop/mobile compositions were visually inspected. Human screen-reader silence remains to be confirmed.
    - `guide-loading-skeleton`: entrances only enhance already readable content; all sections and all three instructions remain visible with JavaScript disabled. Inert setup/copy controls stay hidden until their handlers attach. Browser fallback verified.
    - `guide-media`: informative audio-bearing tutorial retains its approved classification, title, click-to-play URL, external fallback and caption warning. Actual player operation, caption/transcript/audio-description assessment remain pending under MEDIA-001.
    - `guide-responsive-mobile`: browser-tested 320/375/768/1024/1440px, expanded text and WCAG text spacing; no document horizontal overflow or missing artwork. Human device/zoom ergonomics pending.
    - `guide-cognitive`: instructions stay available; no data entry, authentication or time limit occurs on this site. Actual OpenCode/Cline sign-in is outside this landing-page verification.
    - `guide-framework-mapping`: Astro owns setup state and the persistent status ID; static React owns hero markup. Cross-component ID references resolve.
    - `guide-visual-perception`: contrast formula and rendered CTA pixels verified; gradient uncertainty in axe handled separately below. Human color-vision perception pass pending.
    - `guide-carousels-sliders`: N/A. The component named Marquee remains a static collection, without duplicate cards, off-screen slides or automatic scrolling.
- [~] **Voice Control:** Read visible labels against accessible names; axe's experimental mismatch rule enabled with zero violations. Copy, Copied and Select & copy labels are preserved in their names. No platform voice-control session was run.
- [x] **Interactive states inventoried and navigated:**

| Element/state              | Observed local browser outcome                                                                                   |
| :------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| Skip to content            | First Tab reveals it; Enter focuses the H1 past navigation                                                       |
| Brand link                 | Fragment targets the existing H1                                                                                 |
| Install plugin             | Click navigates and scrolls to `#setup`                                                                          |
| Install / Connect / Choose | Each button reveals only the correct panel and updates `aria-pressed`                                            |
| Setup keyboard             | Space and Enter change panel/status without moving focus or animating                                            |
| Copy, all three commands   | Click writes the exact command to the real Chromium clipboard; visible label and persistent status become Copied |
| Clipboard denial           | Injected permission rejection produces Select & copy plus manual-copy instructions; no disappearing feedback     |
| GitHub / Docs              | Retained repository and README destinations; external repository responds HTTP 200                               |
| Watch on YouTube           | Retained exact tutorial URL; destination responds HTTP 200; playback not tested                                  |
| Tutorial embed             | Retained titled privacy-enhanced iframe with no autoplay parameter; remote internals excluded from local tests   |
| JavaScript disabled        | All commands, sections and images readable; JS-only selector/copy controls hidden                                |

- [~] **Status Change (`aria-live`):** Browser verified message text in a pre-existing `role="status"` region and retained setup focus. No claim that a screen reader spoke it.
- [x] **Form Filling:** N/A. No input fields or site authentication.

## 4. Visual Perception and Comprehension

- [~] **Text & UI Contrast:** Existing HSL palette retained. WCAG relative-luminance computations below use the rounded 8-bit values. CTA foreground comes from computed DOM style; background comes from actual screenshot pixels in normal/hover/focus states. Normal and keyboard focus remain 15.58:1; hover remains 11.56:1. Text-bearing entrances start at 0.9 opacity, keeping the weakest animated soft text at 4.82:1 over the page background. Decorative artwork carries no information beyond its copy. Human color-perception review is still pending.

| Pair                      | Foreground | Background |   Ratio | Floor | Result |
| :------------------------ | :--------- | :--------- | ------: | ----: | :----- |
| ink / bg                  | #1c2126    | #fcfaf8    | 15.58:1 | 4.5:1 | ✅     |
| ink / panel               | #1c2126    | #ffffff    | 16.22:1 | 4.5:1 | ✅     |
| ink / raised              | #1c2126    | #f3f1ed    | 14.38:1 | 4.5:1 | ✅     |
| muted / bg                | #49525a    | #fcfaf8    |  7.65:1 | 4.5:1 | ✅     |
| muted / panel             | #49525a    | #ffffff    |  7.96:1 | 4.5:1 | ✅     |
| muted / raised            | #49525a    | #f3f1ed    |  7.06:1 | 4.5:1 | ✅     |
| soft / bg                 | #596169    | #fcfaf8    |  6.04:1 | 4.5:1 | ✅     |
| CTA normal and focus      | #fcfaf8    | #1c2126    | 15.58:1 | 4.5:1 | ✅     |
| CTA hover, screenshot     | #fcfaf8    | #32373b    | 11.56:1 | 4.5:1 | ✅     |
| copy hover                | #ffffff    | #49525a    |  7.96:1 | 4.5:1 | ✅     |
| accent text / panel       | #174c82    | #ffffff    |  8.78:1 | 4.5:1 | ✅     |
| focus / bg                | #174c82    | #fcfaf8    |  8.43:1 |   3:1 | ✅     |
| focus / raised            | #174c82    | #f3f1ed    |  7.78:1 |   3:1 | ✅     |
| control / bg              | #717a84    | #fcfaf8    |  4.19:1 |   3:1 | ✅     |
| control / panel           | #717a84    | #ffffff    |  4.36:1 |   3:1 | ✅     |
| control / raised          | #717a84    | #f3f1ed    |  3.86:1 |   3:1 | ✅     |
| soft at 0.9 opacity / bg  | #697077    | #fcfaf8    |  4.82:1 | 4.5:1 | ✅     |
| muted at 0.9 opacity / bg | #5b636a    | #fcfaf8    |  5.87:1 | 4.5:1 | ✅     |

- [x] **Redundancy:** Setup selection has a pressed state plus border/background; clipboard outcomes use explicit words, not color alone. No feature requires decoding the illustration.
- [~] **Scale / Zoom:** Chromium verified no document horizontal overflow or off-viewport text containers at 320/375/768/1024/1440px, with every computed text size doubled at 1440px, and with WCAG text-spacing overrides at both 1440px and 320px. Expanded-text and spacing screenshots were visually inspected. Actual browser zoom/device magnifier verification remains a human follow-up.

## 5. Time-Based Media and Motion

- [x] **Classification:** Existing owner-confirmed informative tutorial with audio retained. New still artwork follows the owner-approved decorative-beside-equivalent-text pattern. No new audio/video was added.
- [!] **Alternatives:** MEDIA-001 stays open. No human-reviewed synchronized captions, transcript or completed audio-description assessment exists. Written setup instructions are not a caption substitute. `EXCEPTIONS.md` is unchanged; no production risk acceptance is implied.
- [x] **Autoplay and Moving Content:** No autoplaying sound, looping background, parallax, automatic marquee, flashing or auto-advancing instructions. All local automatic motion is finite, at most 800ms including stagger, so no sequence needs a >5-second pause control. External player internals are not verified.
- [x] **Reduced Motion:** Browser interception verified 150ms opacity-only entrances, without transforms, clip reveals or stagger. Active entrances cancel when the media-query change event arrives. Normal entrances fire once, at most 800ms including delay; keyboard scrolling adds no new animation. A touch-capable 375px context reports no fine hover and no illustration transform after a tap; reduced-motion CTA hover also has no transform. Human device feel-check remains pending.
- [x] **Text over Media:** N/A. Text is never placed over moving imagery.

## 6. Cognitive Load and Flow

- [x] **Nothing to remember:** This page gives instructions, not a sign-in form. JavaScript-disabled readers receive the complete command sequence. No token, password, code or other private value is requested here.
- [x] **Nothing to retype:** N/A. No data-entry process.
- [x] **Help in the same place:** Tutorial, written instructions and repository links retain their order.
- [x] **Text spacing:** Chromium verified 1.5 line height, 2× paragraph spacing, 0.12× letter spacing and 0.16× word spacing at 1440px and 320px without horizontal overflow. The narrow hero was visually inspected. Human device and assistive-technology checks remain pending.
- [x] **Timing:** No time limits or disappearing feedback. User controls when setup panels change.
- [x] **Conflicting needs:** Motion can aid continuity but displace readers with vestibular conditions. The system preference selects a no-displacement path; keyboard input cancels active entrances. Choice recorded by pattern in `A11Y-DECISIONS.md`.

## 7. Functional Performance

N/A. No formal EN 301 549, VPAT, ADA or EAA conformance declaration. Hearing access remains blocked by MEDIA-001.

## 📝 Assessment Notes or Known Blockers

- MEDIA-001 remains an unresolved HIGH issue, not an approved exception. Yasir must assign a risk owner and publish human-reviewed synchronized captions, then assess transcript/audio-description needs and test the real player.
- No additional verifier was spawned because the owner explicitly required one implementing subagent. A human or fresh-context independent review is still needed. Self-reported evidence cannot be promoted to PASS.
- Local browser tests use the production build, Playwright and `/usr/local/bin/chromium` at the actual `/opencode-cline-free/` path. Third-party network content is excluded. There are zero local page exceptions in the completed interaction tests.
- A supplemental desktop/reduced-motion/touch/static-fallback run recorded zero browser console errors and zero page exceptions. Touch setup selection worked. JavaScript-disabled instructions use the full console width, with all three panels visible and no inactive controls; this was visually checked after correcting the original narrow grid-column fallback.
- Official logo sources, retrieved commit IDs, hashes, complete upstream licenses, brand-use limitations and generated-art provenance are in `ASSETS.md`. No generic official AI logo or changing model-vendor availability is implied.
- Design/copy gates, motion frequency/purpose decisions and the responsive packet are recorded in `DESIGN.md`. The new-work gates do not certify the existing tutorial.
- Checks to reproduce: clean npm install; site Astro check, TypeScript and build; root typecheck and tests; targeted Prettier; `git diff --check`; `python /data/a11y/verify-a11y.py site --src src` from repository root with the upstream gate available.
