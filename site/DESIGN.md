# Landing-page direction

Reading this as a community-plugin landing page for terminal-based developers,
in the owner's approved light neutral and warm/cool gradient style.
ENERGY 2 / RHYTHM 2 / MOTION 2.

## Decisions

- Color: retain the approved warm neutral surfaces and dark primary action;
  the existing gradient distinguishes the introduction, not the text itself.
- Typography: retain Helvetica Neue/Arial for readable documentation-style
  copy; reserve monospace for real commands, not marketing headings.
- Layout: preserve the hero and setup flow; give discovery a wide lead card
  because exposing Cline's rotating model list is the plugin's primary job.
  Three smaller cards explain account behavior beneath it, not a bento mosaic.
- Spacing: use the existing 8/12/16/24/32/48/64 scale, with more space between
  sections than between a heading and its explanation.
- Depth: retain the two existing elevated surfaces, the hero and setup console.
  Capability cards remain on the page rather than floating on large shadows.
- Identity: the official product pair, literal OpenCode commands and generated
  catalog/account/route/pinning illustrations describe this plugin specifically.
- Imagery: use the generated matte paper set to explain the four mechanisms
  without an invented product screenshot. See `ASSETS.md` for provenance.
- Copy: use the README and `src/core/modelList.ts`, `router.ts`, `pool.ts`
  and `account.ts` for claims. No fixed model lineup, invented counts,
  unlimited-quota promise, testimonials or vendor endorsement.
- Support section: replace repeated feature copy with daily quota and paid-credit
  caveats, plus the real `cline_free_status` tool.

## Motion gates

- Rare first reading, explanation and spatial consistency: a 300ms hero
  entrance and product-pair sequence with 50ms stagger.
- Occasional section arrival, preventing a jarring change: 300ms opacity cues;
  capability art uses the animate skill's one-time 600ms clip reveal.
- Frequent pointer feedback: 160ms control press and CTA movement, 200ms
  illustration hover. No keyboard-driven animation or setup-panel transition.
- CSS handles pointer feedback; IntersectionObserver and WAAPI add one-time
  entrances to already visible content. No dependency or animation framework.
- Use the existing motion tokens, strong ease-out and ease-in-out from the
  animate skill. Only opacity, transform and sanctioned clip-path animate.
- Reduced motion keeps a 150ms opacity cue with no displacement or stagger.
  Preference changes and any keyboard input cancel active entrances.
- No automatic sequence exceeds 800ms. No loop, parallax, automatic marquee,
  flashing, smooth anchor scrolling or pause control is needed.

## Responsive strategy

- Surface: card grid and page shell; primary packet: page-layout.
  Pressure: viewport width and expanded text. Confidence: high after browser QA.
- Mobile-first: stacked hero rows and capability cards, wrapped navigation,
  full-width install action and command text that can break.
- Intrinsic layout owns card fitting below 768px. A single 768px viewport
  query establishes the discovery lead row and three account cards.
  Existing 640px and 1024px shell breakpoints remain.
- This is a single landing-page placement, not a reusable parent-size slot;
  container queries would add no useful behavior.
- Images reserve a 500:376 ratio, scale without cropping their subjects and
  load locally. No informative image content depends on the visual layout.
- Verification: 320/375/768/1024/1440px, 200% text sizing, 320px reflow equivalent
  to 400% zoom, WCAG text spacing, long labels, all setup states, reduced motion
  and disabled JavaScript. Human assistive-technology checks remain separate.

## Delivery gate for the changed marketing surface

This gate covers the implementation above, not a claim of full-site accessibility.
The existing tutorial's MEDIA-001 and human review remain open in `REPORT.md`.

- R-02 PASS: rewritten page text has no em dash; plain, source-specific sentences.
- R-03 PASS: 320/375/768/1024/1440px browser checks found no horizontal overflow.
- R-17 PASS: no marketing counts or statistics added; OpenCode 2.x is the real requirement.
- R-18 PASS: no testimonials, invented people or customer claims.
- R-23 PASS: logo downloads and generated capability art were explicitly requested.
- R-24 PASS: brand, skip and install fragments resolve; repository/tutorial destinations remain real.
- R-25 PASS: retained palette pairs and rendered CTA states exceed their contrast floors.
- R-26 PASS: local setup, copy success/denial and anchors were exercised; no new dead controls.
- R-27 PASS: static content needs no loading/empty state; clipboard denial has persistent recovery text.
- R-28 PASS: no fabricated FAQ.
- R-32 PASS: native links/buttons, keyboard setup actions and visible focus verified locally.
- R-33 PASS: features implemented directly in source, not by a retained source-patching script.
- R-34 PASS: only the owner-approved fixed light theme ships; no broken theme toggle.
- R-35 PASS: production build and local click-through recorded in REPORT.md; external player remains a separate open check.
- R-36 PASS: claims come from the README and plugin code, with no invented performance/security claims.
- R-37 PASS: approved light/gradient direction and explicit dials recorded before implementation.
- R-38 PASS: no fictional model lineup, stock product UI or unlabelled placeholder.
- R-01 PASS: gradient retains the approved introduction hierarchy; text stays on stable surfaces.
- R-04 PASS: product marks identify the integration; no generic AI sparkle or vendor-availability logo row.
- R-06 PASS: readable sans-serif copy, monospace only for commands; type rationale recorded above.
- R-07 PASS: no decorative grid or blueprint.
- R-08 PASS: arrows are restricted to installation direction and external resource destinations.
- R-09 PASS: no promotional AI/status badge.
- R-10 PASS: backdrop blur stays on the existing hero surface only.
- R-12 PASS: shadows mark the hero and setup console; capability cards do not float.
- R-13 PASS: no decorative glow.
- R-14 PASS: discovery receives the wide lead treatment; account mechanisms receive smaller follow-up cards.
- R-19 PASS: motion gates and purposes are explicit; no loops or functional data movement.
- R-22 PASS: each generated illustration maps to a named plugin mechanism.
- Liveliness PASS: ENERGY 2 / RHYTHM 2 / MOTION 2 matches the approved direction.
- Focal point PASS: hero title/action, discovery lead card and setup instructions have distinct priority.
- Whitespace PASS: section gaps exceed within-group gaps; desktop/mobile and expanded-text views inspected.
- Accent PASS: retained blue marks relationships, focus and capability labels rather than every surface.
- Identity PASS: the product pair and literal OpenCode commands recur without a generic trust strip.
- Design read PASS: audience, visual language and dials declared above.
- C-1 PASS: major visual decisions have a written reason.
- C-2 PASS: no new non-functional interactive element.
- C-3 PASS: repeated support copy replaced by real quota/account caveats.
- C-4 PASS: local normal, reduced-motion, touch and JavaScript-disabled states checked.
- C-5 PASS: source-grounded feature claims; no customer or performance fabrication.
- R-05 PASS: content-led lead feature, account cards, written setup and quota notes, not a template testimonial/pricing sequence.
- R-11 PASS: existing surface radii retained; command labels use smaller 8px corners.
- R-15 PASS: Install plugin and Watch on YouTube describe actual actions.
- R-16 PASS: no AI marketing buzzwords.
- R-20 PASS: plugin mechanisms, official product pair and command vocabulary provide identity.
- R-21 PASS: fixed light treatment follows the owner's explicit approved direction.
- R-29 PASS: existing neutral palette, blue accent and localized warm/cool introduction retained.
- R-30 PASS: no new visual clone of another product.
- R-31 PASS: color, layout, typography, spacing, card hierarchy, artwork and motion rationales are recorded.

Copy audit: the first draft repeated features in the support section and used
generic benefit lines. The shipped copy replaces those with quota behavior
and the actual status tool. No new fact, vendor availability, number or promise
was added beyond the README and source mechanisms.

Feel-check follow-up: review the 50ms stagger and 600ms image reveal on a real
device, optionally slowed to 2× duration in DevTools. Keyboard setup actions
must remain instant, not become a choreographed demo.
