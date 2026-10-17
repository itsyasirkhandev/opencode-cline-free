# A11Y Decisions Log (Pattern Memory)

> **Purpose:** cross-turn memory of choices between **equally conformant alternatives**. Two implementations can both pass `A11Y.md` and axe and still diverge (different `role`, focus pattern, announcement wording) — twenty compliant modals, zero coherence. This file prevents that.

## Rules for the AI

1. **Record only what is not derivable** from `A11Y.md` rules or from the code itself. Landmarks, headings, and alt presence are machine-verifiable — they do **NOT** belong here.
2. **Index by pattern, never by screen.** ✅ _"Destructive confirmation modal → `alertdialog`"_ · ❌ _"The dispute modal does X"_.
3. **One line per decision:** pattern → choice → short why.
4. **Read before building:** before generating any interactive component, check this log and reuse the recorded pattern (see _Component Reuse_ in the AI Behavior Contract).
5. **Never fork silently:** if a new requirement contradicts a recorded decision, ask the user — do not create a parallel variant.
6. **Stay lean:** tens of lines, not hundreds. This file shares the context budget with Lazy Loading; if it grows past ~40 entries, consolidate.
7. **Versioned, never gitignored:** this is _shared_ memory — across turns, agents and developers. A local-only copy per developer forks the patterns and defeats the file's entire purpose.

## Decisions

<!-- Append entries below. Format: - **Pattern** → choice — why. (date) -->

- **Palette / action hierarchy** → retain dark warm-neutral surfaces and orange, reserve solid orange for the primary CTA — polish the existing identity without changing layout or copy. (2026-10-17)
- **Panel depth** → fixed surface lightness plus one 12px panel radius and one shadow role — reduce competing outlines without removing control affordances. (2026-10-17)
- **Body paragraph rhythm** → preserve surrounding utility-based paragraph spacing while setting line height to 1.75 — product-specific house-rule choice to retain the requested layout, not a WCAG exception. (2026-10-17)
- **Contrast evidence** → sampled DOM text pairs and measured ratios are in REPORT.md section 4 — recompute whenever these palette roles change. (2026-10-17)

## Approved Launchpad direction (2026-10-17)

These supersede the earlier polish-only layout choices: owner selected Launchpad and explicitly requested direct-main integration.

- **Visual hierarchy** → selected warm-charcoal/orange Launchpad composition, replacing the previous landing surface; original logo asset and metadata retained.
- **Setup instructions** → independent native pressed buttons reveal pre-rendered panels; not composite ARIA tabs. Keyboard changes stay instant and focus stays on the selected button.
- **Copy feedback** → reuse existing CopyCommand component, restyled with visible Copy/Copied/failure text and persistent status region; no focus-stealing toast.
- **Motion** → one-time 250ms entrance with 50ms stagger; pointer-only 160ms press scale; reduced motion uses 150ms opacity only. No logo animation or looping effects.
- **Tutorial** → informative audio-bearing setup video confirmed by owner; click-to-play, privacy-enhanced iframe, 16:9 reserved size and external fallback. Captions unavailable; tracked as unresolved HIGH issue, not represented as conformant.

## Approved Design Code direction (2026-10-17)

These supersede the Launchpad palette and motion choices above; setup interaction and tutorial decisions remain.

- **Profile** → Standard (WCAG 2.2 AA), selected by Yasir; no AA conformance claim while MEDIA-001 remains unresolved.
- **Palette / hierarchy** → owner selected the supplied Design Code content and full-page restyle; light neutral surfaces, dark primary actions, static warm/cool gradient outside a near-opaque text panel.
- **Supplied images** → Yasir confirmed tool thumbnails and brand badges decorative beside labels, with header link named “Design Code”; empty image alternatives do not carry missing instructions.
- **Tool collection** → static intrinsic wrapping grid rather than automatic marquee, keeping all cards visible without movement, duplicated content, or a pause requirement.
- **Body rhythm** → retain compact 12–24px spacing in short tool-card metadata and grouped footer copy; longer instructional paragraphs retain 32px spacing. Product-specific house-rule choice, not an SC exception.
- **Verification** → owner declined build/dev/preview; static checks only, self-reported evidence, no visual or assistive-technology pass claimed.
- **Contrast evidence** → token-pair matrix in REPORT.md §4; no mix-blend text over the gradient. Browser compositing and hover/focus rendering remain unverified.

### Design Code token-pair evidence (2026-10-17)

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

## Plugin-specific content follow-up (2026-10-17)

- **Brand and content** → owner requested plugin-relevant copy and icons, superseding the supplied Design Code/tool-brand content while retaining the approved layout.
- **Capability illustrations** → local line icons accompany equivalent headings/command text; existing local plugin logo accompanies the cline-free wordmark. No remote thumbnails or unrelated vendor endorsements.
- **Calls to action** → Install plugin navigates to the written setup instructions; GitHub links to the source repository. Quota and paid-credit caveats remain visible.
