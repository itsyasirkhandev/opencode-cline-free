# Landing-page development

This directory is an Astro site with TypeScript, Tailwind CSS v4 and React support. The root package is the OpenCode plugin; do not install UI dependencies at the repository root.

## Paths and shadcn setup

- Landing route: `src/pages/index.astro`.
- Components: `src/components/` (existing Astro components).
- Shared React/shadcn UI: `src/components/ui/`.
- Global styles and Tailwind theme: `src/styles/global.css`.
- `@/*` resolves to `src/*` in `tsconfig.json`.
- shadcn aliases and Tailwind v4 configuration: `components.json`.

The requested `/components/ui` convention is `site/src/components/ui` here, not a new repository-root folder. Keeping primitives here makes `@/components/ui/...` imports and future shadcn additions consistent with Astro’s source layout. React, Tailwind and TypeScript are configured; no framework migration or separate initialization is needed.

```bash
cd site
pnpm install --frozen-lockfile
pnpm run check
pnpm run format:check
# Add another shadcn component only when needed:
pnpm dlx shadcn@latest add separator
```

Dependencies were added using `pnpm add`, including `@aliimam/logos`, `@astrojs/react`, React, Radix Slot, class-variance-authority, clsx and tailwind-merge. The npm lockfile is also synchronized because the existing GitHub Pages workflow runs `npm ci`; pnpm remains the local development package manager.

## Hero integration

`src/components/ui/hero-02.tsx` exports both `HeroSection02` and its default export. The landing route imports it directly; a separate demo route is unnecessary. Astro server-renders it without a `client:*` hydration directive because the hero needs only native anchor navigation. `"use client"` is retained for reuse in React client-boundary environments.

The previously missing utilities are local implementations:

- `GradientWave`: static decorative CSS gradient, no WebGL/canvas or animation dependency.
- `Marquee`: static wrapping tool collection, not an automatically scrolling carousel.
- `Button`: shadcn-style CVA/Radix Slot primitive; CTAs render as real links via `asChild`.

The supplied design-tool copy and image URLs are retained (angle-bracket URL wrappers removed). Both Explore Designs links lead to `#design-tools`. The remote images are decorative beside the text labels, as confirmed by the owner; the header link is named Design Code. External asset availability, content and usage rights should be checked before release. Existing plugin setup, tutorial and capability content remain below the hero.

## Responsive strategy and verification

Primary packet: **page-layout**, medium confidence until browser review. Mobile defaults stack hero rows and controls; intrinsic auto-fit grids wrap cards; viewport rules at 640px and 1024px relax spacing and arrange the desktop hero. No container queries are needed for this page-owned layout. Images reserve a 3:2 crop and the existing video retains 16:9 sizing.

Before merging, check 320px, 375px, 768px, 1024px and 1440px, 200% text resize, 400% equivalent reflow, long-copy wrapping, keyboard focus, clipboard success/failure, the tutorial player and remote images. Check the headline underline, logo overlap and gradient panel contrast visually. Accessibility owns screen-reader/voice-control and media checks; see `REPORT.md` and the existing MEDIA-001 blocker in `EXCEPTIONS.md`.

Build and browser preview were explicitly declined for this change. Only static verification was performed. The full format check also includes pre-existing files; do not reformat unrelated components just to silence baseline findings.
