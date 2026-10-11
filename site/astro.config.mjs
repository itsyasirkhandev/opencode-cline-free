// @ts-check
import { defineConfig } from "astro/config"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"

// Project page on GitHub Pages: https://itsyasirkhandev.github.io/opencode-cline-free/
export default defineConfig({
  site: "https://itsyasirkhandev.github.io",
  base: "/opencode-cline-free",
  trailingSlash: "ignore",
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
})
