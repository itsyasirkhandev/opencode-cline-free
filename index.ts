// Entry point for loading the plugin straight from a clone
// (`"plugin": ["./index.ts"]`). Source lives in ./src; the single-file
// bundle for copy-installs is dist/cline-free.js (`npm run build`).
export { default, __clineFreeTest } from "./src/index.ts"
