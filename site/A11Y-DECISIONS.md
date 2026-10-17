# A11Y Decisions Log (Pattern Memory)

> **Purpose:** cross-turn memory of choices between **equally conformant alternatives**. Two implementations can both pass `A11Y.md` and axe and still diverge (different `role`, focus pattern, announcement wording) — twenty compliant modals, zero coherence. This file prevents that.

## Rules for the AI

1. **Record only what is not derivable** from `A11Y.md` rules or from the code itself. Landmarks, headings, and alt presence are machine-verifiable — they do **NOT** belong here.
2. **Index by pattern, never by screen.** ✅ *"Destructive confirmation modal → `alertdialog`"* · ❌ *"The dispute modal does X"*.
3. **One line per decision:** pattern → choice → short why.
4. **Read before building:** before generating any interactive component, check this log and reuse the recorded pattern (see *Component Reuse* in the AI Behavior Contract).
5. **Never fork silently:** if a new requirement contradicts a recorded decision, ask the user — do not create a parallel variant.
6. **Stay lean:** tens of lines, not hundreds. This file shares the context budget with Lazy Loading; if it grows past ~40 entries, consolidate.
7. **Versioned, never gitignored:** this is *shared* memory — across turns, agents and developers. A local-only copy per developer forks the patterns and defeats the file's entire purpose.

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
