# A11y Verification Report — Launchpad Landing Page Integration

This report compiles the compliance evidence for a given *Feature*, ensuring its development reached the "Certification Ready" definition.

> This report is a **versioned project record** — never add it to `.gitignore`. Evidence hidden from version control is not evidence: QA and leadership verify it before release, and audits read it after.

> **Marking legend (mandatory):**
> `[x]` verified, with the evidence described beside it · `[!]` verified and **failed** (fix it, or open an entry in `EXCEPTIONS.md`) · `[~]` partially verified, with what is missing written down · `[ ]` **not verified** — the reason MUST be written beside it.
> Marking `[x]` without reproducible evidence invalidates the whole report.

> **Headless agents.** An AI without a browser MUST still produce this report, marking `[ ]` every checkpoint that requires a browser or assistive technology, with the reason and who must run it. A partial, honest report is evidence; a missing report is not. Overall status is CONDITIONAL — never PASS — while any `[ ]` or `[!]` remains.

---

## 📌 Validation Context
- **Feature/Epic:** Approved Launchpad landing page integrated into Astro with original logo, motion and embedded setup tutorial.
- **Test Date:** 10/17/2026
- **Covers interface as of:** site/src/pages/index.astro SHA256 64856b7456b9435c80c006efe2b96efbdd81ddd826c5b03330b04441a7a1f5f5
- **Standard version:** 2.4.0
- **Compliance Status:** ⚠️ CONDITIONAL — captions missing; human media and assistive-technology validation pending.
- **Verification Independence:** self-reported — generating assistant, current session. No independent verifier was requested.
- **Static gate (`verify-a11y.py`):** PASS (0 errors, 25 warnings: known failed media checkpoint, self-reported verification, and computed HSL palette literals) — run on 2026-10-17.

## 1. Technical Verification (Automated & Semantics)
Evidence obtained via static validators to ensure a structural technical baseline.
- [ ] **Axe-Core / Lighthouse:** Zero "Critical" or "Serious" violations? *(Attach print or score - e.g., Score 98)* — Not verified: requires human desktop/mobile testing or independent audit; Yasir to arrange before production.
- [x] **HTML Semantics:** Code-read: actions use native buttons, destinations use anchors; main/header/nav/footer present.  Appropriate replacement of generic `div`s with interactive endpoints (`button`, `a`, etc.)?
- [x] **Heading Hierarchy (H1-H6):** DOM checked: one rendered H1; support and setup sections use H2.  Respected with no level skips?

## 2. Tab Order and Focus Management
Validation purely by keyboard (without mouse usage).
- [ ] **Focus Indicator:** The Focus Ring was never suppressed and meets the visual contrast requirement (minimum 3:1)? — Not verified: requires human desktop/mobile testing or independent audit; Yasir to arrange before production.
- [ ] **Logical Navigation:** Does the `Tab` key follow the visually correct order of the interface? — Not verified: requires human desktop/mobile testing or independent audit; Yasir to arrange before production.
- [ ] **Captured Focus (Modals/Overlays):** When opening modals, is the focus trapped inside the component and can it be closed via the `Escape` key? — Not verified: requires human desktop/mobile testing or independent audit; Yasir to arrange before production.

## 3. Behavior and Task Return
Critical functional paths and Screen Reader validation.
- [ ] **Screen Reader Test:** Was the main task performed with **at least one screen reader + browser pair**, named here? *(Record the pair, not just the reader: NVDA + Firefox, JAWS + Chrome and VoiceOver + Safari diverge in ARIA behavior, and "I used NVDA" is not reproducible evidence. If the product has a corporate Windows audience, JAWS + Chrome is the pair missing from most reports.)* — Not verified: requires human desktop/mobile testing or independent audit; Yasir to arrange before production.
  - Pair(s) used: None. Yasir or a human tester must run desktop and mobile screen-reader/browser pairs.
  - Who ran it and when: Not run; no human screen reader available.
  - Scenarios run: guide-buttons.md — keyboard Copy and setup activation passed; desktop/mobile SR not verified. guide-navigation.md — skip first, Enter focuses main, setup selection passed; SR landmarks not verified. guide-toasts-notifications.md — standing status region and retained focus code-read; spoken announcement not verified. guide-responsive-mobile.md — 1440/390/320 px and text-spacing reflow navigated; real-device and browser text zoom pending. guide-cognitive.md — no input/auth/time limit, persistent instructions code-read. guide-framework-mapping.md — native HTML and ID relationships code-read. guide-images.md — existing logo and adjacent text semantics preserved from production; human alt review remains pending. guide-loading-skeleton.md — initial content exists in static HTML and survives disabled JavaScript. guide-media.md — informative setup tutorial with normal audio, confirmed by user; no captions yet. Embedded player loads over HTTP; playback, fullscreen, captions and screen-reader operation require human checks. Reduced motion uses opacity only, confirmed in Chromium. guide-visual-perception.md — ratio matrix calculated; human color-vision simulator check pending.
- [ ] **Voice Control:** Can every visible control be activated by **speaking its visible label**? *(SC 2.5.3 — an `aria-label` that replaces the visible text makes the control unreachable by voice. Name the tool used, or state that the names were checked against the labels by reading.)* — Not verified: requires human desktop/mobile testing or independent audit; Yasir to arrange before production.
  - Tool or method: Read accessible names against visible labels. Voice Control and Voice Access not run.
- [x] **Interactive states inventoried:** Navigated Install/Connect/Choose at 1440, 390 and 320px; clipboard success and denial; pointer press; reduced motion; static no-JavaScript content.
- [ ] **Status Change (`aria-live`):** Are form errors, loading states, or non-visual updates correctly announced? — Not verified: requires human desktop/mobile testing or independent audit; Yasir to arrange before production.
- [ ] **Form Filling:** Correctly related labels (`for` and `id`) in all inputs? — Not verified: requires human desktop/mobile testing or independent audit; Yasir to arrange before production.

## 4. Visual Perception and Comprehension
Tests validating contrast and visual structure (color-independent).
- [~] **Text & UI Contrast:** Calculated matrix below; decorative divider lines excluded. Palette retained; logo SVG colors intentionally unchanged. Full human contrast and color-vision review remain pending.  Do all texts have a 4.5:1 ratio and essential components 3:1?
  Measured pairs — computed with `tools/contrast-check.py` or the WCAG formula, never estimated. The static gate recomputes every row; a ratio that does not match the arithmetic fails the build. One row per pair that carries meaning: body text, secondary text, links, focus ring, UI borders, each state.
  | Pair | Foreground | Background | Ratio | Floor | Result |
  | :--- | :--- | :--- | ---: | ---: | :--- |
  | ink on bg | #fbfaf9 | #110f0e | 18.34:1 | 4.5:1 | ✅ |
| ink on panel | #fbfaf9 | #1e1c1a | 16.29:1 | 4.5:1 | ✅ |
| ink on raised | #fbfaf9 | #2b2926 | 13.91:1 | 4.5:1 | ✅ |
| muted on bg | #c5c2be | #110f0e | 10.77:1 | 4.5:1 | ✅ |
| muted on panel | #c5c2be | #1e1c1a | 9.57:1 | 4.5:1 | ✅ |
| soft on bg | #aaa6a1 | #110f0e | 7.90:1 | 4.5:1 | ✅ |
| soft on panel | #aaa6a1 | #1e1c1a | 7.02:1 | 4.5:1 | ✅ |
| accent on bg | #fca355 | #110f0e | 9.57:1 | 4.5:1 | ✅ |
| accent on panel | #fca355 | #1e1c1a | 8.50:1 | 4.5:1 | ✅ |
| bg on accent | #110f0e | #fca355 | 9.57:1 | 4.5:1 | ✅ |
| bg on hover | #110f0e | #ffbe85 | 11.79:1 | 4.5:1 | ✅ |
| control on bg | #918c88 | #110f0e | 5.74:1 | 3:1 | ✅ |
| control on panel | #918c88 | #1e1c1a | 5.10:1 | 3:1 | ✅ |
| control on raised | #918c88 | #2b2926 | 4.36:1 | 3:1 | ✅ |
| accent on raised | #fca355 | #2b2926 | 7.26:1 | 3:1 | ✅ |
- [x] **Redundancy:** Selected setup controls expose aria-pressed; copy success has text; no color-only error state.  Errors and alerts do not convey information exclusively through color *(e.g., they always use Color + Icon + Text)*.
- [ ] **Scale / Zoom:** Text resized to 200% without loss (SC 1.4.4) and content reflowed at 320 CSS px — ≈400% zoom on a 1280px viewport (SC 1.4.10) — with everything operable and no two-dimensional scrolling? — Not verified: requires human desktop/mobile testing or independent audit; Yasir to arrange before production.

## 5. Time-Based Media and Motion
*If this interface carries no video, audio or scroll-driven motion, write "N/A — no time-based media" here and skip the block.*
- [x] **Classification:** Informative full-setup tutorial; user confirms normal audio, no captions yet (2026-10-17).
- [!] **Alternatives:** Synchronized captions are missing (SC 1.2.2). HIGH production blocker, tracked in EXCEPTIONS.md as an unapproved open issue. Setup text is useful but not claimed to be a complete video equivalent. Human transcript/audio-description assessment remains pending.
- [~] **Autoplay and Moving Content:** Embed has no autoplay parameter; player waits for user activation. Full playback and flashing-content review not performed.
- [~] **Reduced Motion:** Prior Chromium motion checks passed; no new animation or video autoplay added. Real-device review pending.
- [~] **Text over Media:** No custom overlay added. YouTube's cross-origin controls and thumbnail are not independently contrast-audited.

## 6. Cognitive Load and Flow
*Applies to any flow with more than one step, an authentication, or a time limit.*
- [x] **Nothing to remember:** All setup commands/instructions stay visible in their selected step; this is not a real login.  No step requires the user to hold information from another screen. Password fields accept paste and declare `autocomplete`; no transcription CAPTCHA without an alternative (SC 3.3.8).
- [x] **Nothing to retype:** No inputs or personal data collected.  Information already provided in the same process is auto-populated or offered for selection; state survives the Back button (SC 3.3.7).
- [x] **Help in the same place:** Docs/GitHub navigation remains consistent across setup steps.  Where a help mechanism exists, it appears in the same relative order on every screen of the flow (SC 3.2.6).
- [x] **Text spacing:** 320px page width tested with 1.5 line height, 2x paragraph spacing, .12em letter and .16em word spacing; no horizontal page overflow.  Nothing is clipped or overlapped at line height 1.5×, paragraph 2×, letters 0.12× and words 0.16× (SC 1.4.12).
- [x] **Timing:** No time limits or expiring messages.  Every limit can be turned off, adjusted or extended, with a warning (SC 2.2.1).
- [x] **Conflicting needs:** No conflicts identified; fixed dark exploration preserves existing project identity.  If any decision served one accessibility need at the cost of another, both populations are named and the choice is recorded in `A11Y-DECISIONS.md`.

---
## 📝 Assessment Notes or Known Blockers
*Describe whether any exception behavior was detected or what measures were opened in `EXCEPTIONS.md`*

- **Note 1:** Repository landing-page integration; only site files changed. This report is not a conformance declaration.
- **Note 2:** Original SVG logo embedded without source changes. Informative YouTube tutorial added; no autoplay, parallax or live API integrations. Reduced motion uses a 150ms opacity-only fade with no transform (tested).

## Reproducible local checks
- Browser: bundled Chromium driven by Playwright. Three widths (1440, 390, 320px); setup activation works by keyboard and copy success/denial works in Chromium. No JavaScript errors or horizontal page overflow.
- Original logo verified byte-for-byte by Git blob SHA1 c96a412d0ae13c531258afa90aa0890827af0a36; production logo.svg is referenced via the existing BASE_URL convention and the asset itself is unchanged. SVG paths, viewBox, colors and title unchanged. Production image alt/aria-hidden pattern retained beside the visible brand name, not newly classified as decorative.
- Hero animation: 250ms strong ease-out, 50ms stagger, transform + opacity only. No looping effects. Pointer-only press: 160ms, scale(.97). Keyboard activations do not trigger press motion or animate setup-panel changes.
- Reduced motion: 150ms opacity-only entry, no translation or scale. Default static HTML remains readable with JavaScript disabled; no script-dependent visibility gate.
- Clipboard: success message and copy data verified; denied clipboard access provides manual-copy recovery text and persistent status region. Spoken announcements await human screen-reader testing.
- Reflow: 320px plus user text spacing (line height 1.5, paragraph 2x, letters .12x, words .16x) produced no horizontal overflow. Real-device and 200% browser text zoom remain unverified.
- Visual QA: desktop and mobile initial states inspected individually after full-page capture, with original logo visible and no overlay intersections. No prototype picker remains.
- Astro check: 0 errors, 0 warnings, 0 hints. Prettier Astro/CSS formatting and git diff whitespace checks passed.
- Primary responsive packet: page-layout. Intrinsic wrapping and mobile stacking; viewport changes at 640/900px. No container-query or data-table surface.
- Independent verification, desktop/mobile screen-reader pairs and human visual-motion feel check remain pending. Status stays self-reported CONDITIONAL, not certified accessible.

## Tutorial addition — 2026-10-17
- Responsive privacy-enhanced YouTube iframe below setup instructions, before capabilities; descriptive title, lazy loading, fullscreen permission and ordinary external fallback link.
- Chromium HTTP checks at viewport widths 1440/390/320px: iframe sizes 958×538, 340×190 and 270×151px; no horizontal page overflow or page JavaScript errors. Keyboard Connect activation still works.
- YouTube player title/thumbnail loaded over localhost HTTP. Hosted mobile full-page and desktop focused-player captures visually inspected; no custom layout overlap. Offscreen lazy iframe can appear blank in full-page capture.
- Direct file:// capture showed YouTube error 153; use HTTP/HTTPS with referrer information or the Watch on YouTube fallback. This is not claimed to work as an embedded player from a local file.
- Actual playback/audio, fullscreen controls, cross-origin keyboard navigation, caption quality and screen-reader use remain unverified. No production accessibility approval granted.

## Astro integration evidence — 2026-10-17
- Replaced the old landing-page surface with the selected Launchpad design. Original logo, canonical/social/JSON-LD metadata, GitHub Pages base path and existing deployment workflow retained. Plugin runtime and dependency manifests/locks untouched.
- Reused CopyCommand.astro for each pre-rendered instruction panel. Native buttons switch `hidden` panels instantly and expose `aria-pressed`; live status retains focus. All three commands exist in server-rendered HTML; first panel is visible without JavaScript.
- Verification environment: Node 24, pnpm 10.34.5, installed Astro 7.4.0 from the existing allowed dependency range. Repository npm lock remains at Astro 7.3.8; CI must confirm the locked production pipeline. No new project dependency added.
- Actual Astro components rendered with Astro compiler and Container API in an isolated harness, using production base URL and TypeScript-transpiled client scripts. This is not a complete Vite/Pages build. Full local build/dev commands deliberately not run; existing Deploy site workflow runs check/build/deploy after push to main.
- Browser tests: 1440/390/320px, all three panels, exact clipboard content, denied-clipboard manual fallback, no JavaScript page errors, no horizontal overflow, reduced-motion opacity-only entry and 320px text-spacing stress. Initial instructions visible with JavaScript disabled.
- Desktop/mobile rendered layouts inspected individually. HTTP tutorial thumbnail/player loads; local file captures can leave offscreen lazy iframe blank and lack hosted favicon paths. Actual playback and external-player keyboard/fullscreen controls still need human verification.
- No screen-reader, independent audit or conformance claim. Missing captions remain a known HIGH issue (EXCEPTIONS.md).
