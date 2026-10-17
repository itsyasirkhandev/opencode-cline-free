# Landing-page artwork

Retrieved or generated on 2026-10-17. Brand marks identify the products this
community plugin connects. They are not a customer list or an endorsement.
The footer retains the independent-community-plugin notice.

## Official marks

### OpenCode

- Official brand page: <https://opencode.ai/brand>
- Upstream repository: <https://github.com/anomalyco/opencode>
- Original file: <https://raw.githubusercontent.com/anomalyco/opencode/8c173a8f3805d8e749d44311054b07e37a1b2ce1/packages/console/app/src/asset/brand/opencode-logo-light.svg>
- Local file: `public/brands/opencode.svg`, unchanged SVG, proportions retained.
- SHA-256: `b47a4fecc77599382e238868e74064bbe92307b0e253a32f0b1a026517a2d2a6`
- Repository license: MIT, Copyright (c) 2025 opencode.
  The complete notice is retained in `public/brands/LICENSE-opencode.txt`.

### Cline

- Official brand page: <https://cline.bot/brand>
- Upstream repository: <https://github.com/cline/cline>
- Original file: <https://raw.githubusercontent.com/cline/cline/a42df8c8d5fd9d9f9a9073589baffe32ea9bb2f0/assets/branding/logos/cline-icon-dark.svg>
- Local file: `public/brands/cline.svg`, unchanged SVG, proportions retained.
- SHA-256: `6aab009bf089a8dc1b5452c05c471244a08595b78fd639835eacc0821b887c06`
- The brand page permits the bot icon or wordmark to appear separately.
- Repository license: Apache-2.0, Copyright 2026 Cline Bot Inc.
  The complete upstream license is retained in `public/brands/LICENSE-cline.txt`.
  No upstream NOTICE file was present in the retrieved repository tree.

Both official pages offer downloadable brand resources. This record does not
interpret their software licenses as a broader trademark license. In particular,
Apache-2.0 section 6 does not grant general trademark rights. Marks appear
unmodified, beside their product names, solely to identify the integration.
No affiliation, sponsorship or vendor approval is claimed.

## Generated capability illustrations

The four images were actually generated with Notion's `images_generate` tool,
not drawn as SVG substitutes or downloaded stock art.

| Local file                           | Subject                                   | Adjacent equivalent text                                 |
| :----------------------------------- | :---------------------------------------- | :------------------------------------------------------- |
| `public/illustrations/discovery.svg` | Magnifier, catalog cards and model nodes  | Startup discovery, rotations and offline saved list      |
| `public/illustrations/connect.svg`   | Key, doorway and linked shapes            | Browser sign-in, local Cline CLI import and manual token |
| `public/illustrations/failover.svg`  | A blocked route and an alternate route    | Same-request retry on a healthy connected account        |
| `public/illustrations/session.svg`   | A pin securing linked conversation shapes | Per-session, per-model account pinning                   |

Art direction: matte cut-paper technical illustrations on warm off-white,
charcoal outlines, pale blue and sand accents, with no text, vendor marks,
people, fake interface or generic sparkle/robot imagery. One generated contact
sheet supplies four consistent crops. Crops remove the outer sheet margin
and dividers; each was visually inspected. The local SVG files are containers
for optimized, embedded 500×376 WebP rasters, not vector redraws. This keeps
the generated artwork self-contained and text-safe for the GitHub MCP upload.

All illustrations are decorative under the owner's already approved pattern:
equivalent visible text carries every instruction and feature claim.
Removing any illustration or brand mark loses no information or function.
The marks also have adjacent visible product names. These images use `alt=""`.

There is no official generic "AI" vendor mark. No model-provider logos were
added because the free rotation changes, and a logo row could imply current
availability or endorsement. The feature illustrations provide neutral
AI-workflow imagery without making those claims.

## Existing assets

The plugin's existing `public/logo.svg`, favicons and social preview remain
unchanged. GitHub's existing icon remains supplied by `@aliimam/logos`.
All new assets use local URLs prefixed with Astro's `BASE_URL`.
