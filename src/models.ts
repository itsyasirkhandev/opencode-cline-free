/**
 * Single source of truth for every Cline model id the plugin knows about.
 *
 * One entry per model holds its display name, status, cost, limits, input
 * modalities and accepted reasoning efforts. `status` drives everything else:
 * - "free":  part of the current free rotation; used as the offline fallback
 * - "paid":  always registered, but bills Cline credits (never auto-replayed
 *            on another account)
 * - "stale": rotated out; metadata kept so the model still renders correctly
 *            if Cline brings it back
 *
 * Reasoning efforts are live-probed against the Cline gateway (2026-09-24,
 * rechecked for the 2026-09-26 rotation). Each list is exactly the set the
 * endpoint accepts for that model:
 * - space-bunny-alpha / pixel-canary: minimal..max (`none` → 400 "Reasoning is
 *   mandatory for this endpoint and cannot be disabled")
 * - mimo-v2.6-flash: none..max (only `none` measurably changes output)
 * - deepseek-v4.1-flash (no longer free): none..max
 * - muse-spark-1.3: minimal..xhigh (`max` → HTTP 500, Meta rejects it)
 * - gemini-3.8-flash: low/medium/high (mandatory reasoning, default medium)
 * - glm: low/high/max; laguna: off/max only; union-alpha: low..xhigh
 *
 * Costs are reference vendor rates ($/1M tokens, nano-gpt canonical where
 * available) used for stats display only: Cline bills free ids at $0.
 * Limits are best-effort (OpenCode uses them for budgeting/truncation; the
 * server stays authoritative).
 */

export type FreeEntry = { id: string; name?: string; description?: string; paid?: boolean }
export type RecommendedPayload = {
  recommended?: FreeEntry[]
  free?: FreeEntry[]
  clinePass?: FreeEntry[]
}

export type ModelStatus = "free" | "paid" | "stale"
export type Cost = { input: number; output: number; cache_read: number }
export type Limit = { context: number; output: number }

export type ModelSpec = {
  name: string
  description?: string
  status: ModelStatus
  cost?: Cost
  limit?: Limit
  input?: string[]
  /** Accepted reasoning efforts. `[]` = no variants. Omitted = DEFAULT_VARIANTS. */
  variants?: string[]
  /** Sent as the base `options.reasoningEffort` when no variant is chosen. */
  defaultEffort?: string
}

export const DEFAULT_COST: Cost = { input: 0, output: 0, cache_read: 0 }
export const DEFAULT_LIMIT: Limit = { context: 200_000, output: 32_000 }
export const DEFAULT_INPUT = ["text"]
// Conservative efforts for models nobody has probed yet (`max` is rejected
// by some vendors). Probe and add explicit `variants` to override.
export const DEFAULT_VARIANTS = ["low", "medium", "high"]

/** Metadata discovered automatically from Cline's public model catalog. */
export type AutoMeta = { limit?: Limit; input?: string[]; cost?: Cost; reasoning?: boolean }

const FULL = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const NO_NONE = ["minimal", "low", "medium", "high", "xhigh", "max"]

export const MODELS: Record<string, ModelSpec> = {
  // --- Current free rotation (checked 2026-10-05) ---
  "stealth/space-bunny-alpha": {
    name: "Space Bunny Alpha",
    description:
      "Anonymous large model with blazing-fast inference, strong coding, native multimodal input, and 1M context.",
    status: "free",
    cost: { input: 0, output: 0, cache_read: 0 },
    limit: { context: 1_000_000, output: 524_288 },
    input: ["text", "image", "video"],
    variants: NO_NONE,
  },
  "cline-free/mimo-v2.6-flash": {
    name: "MiMo V2.6 Flash",
    description: "Xiaomi MiMo 2.6 Flash — 309B MoE (15B active), hybrid attention, multimodal.",
    status: "free",
    cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
    limit: { context: 1_048_576, output: 131_072 },
    input: ["text", "image", "video", "audio"],
    variants: FULL,
  },
  "cline-free/muse-spark-1.3-contributor": {
    name: "Muse Spark 1.3 Contributor",
    description: "Meta's multimodal reasoning model for experimentation and agentic coding workflows.",
    status: "free",
    cost: { input: 0.1, output: 0.2, cache_read: 0.002 },
    limit: { context: 1_048_576, output: 131_072 },
    input: ["text", "image", "video", "audio", "pdf"],
    variants: ["minimal", "low", "medium", "high", "xhigh"],
  },

  // --- Paid (always registered, bills Cline credits — verified 2026-09-24:
  // the account balance drops by `creditsUsed`, the free rotation records 0) ---
  "z-ai/glm-5.3-flash": {
    name: "GLM 5.3 Flash",
    description: "Z-AI GLM-5.3 Flash — bills Cline credits (not free).",
    status: "paid",
    cost: { input: 0.075, output: 0.25, cache_read: 0.015 },
    limit: { context: 1_048_576, output: 131_072 },
    input: ["text", "image", "video"],
    variants: ["low", "high", "max"],
  },

  // --- Rotated out (kept so metadata is right if they return) ---
  // Left the free list on 2026-10-05; Cline now lists it at paid rates.
  "cline-free/deepseek-v4.1-flash": {
    name: "DeepSeek V4.1 Flash",
    description: "Sparse MoE (CED architecture) with native image understanding and 1M context window.",
    status: "stale",
    cost: { input: 0.3, output: 1.2, cache_read: 0.006 },
    limit: { context: 1_000_000, output: 384_000 },
    input: ["text", "image"],
    variants: FULL,
  },
  "stealth/pixel-canary": {
    name: "Pixel Canary",
    description: "Anonymous large model with strong coding capabilities.",
    status: "stale",
    variants: NO_NONE,
  },
  "cline-free/gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    description: "Google's most intelligent Flash model.",
    status: "stale",
    cost: { input: 0.75, output: 3.75, cache_read: 0.075 },
    limit: { context: 1_048_576, output: 65_536 },
    input: ["text", "image", "video", "audio", "pdf"],
    variants: ["low", "medium", "high"],
  },
  "stealth/union-alpha": {
    name: "Union Alpha",
    status: "stale",
    cost: { input: 0, output: 0, cache_read: 0 },
    limit: { context: 262_144, output: 131_072 },
    input: ["text", "image"],
    variants: ["low", "medium", "high", "xhigh"],
    // Server default is medium; set explicitly so no-variant runs stay there.
    defaultEffort: "medium",
  },
  "deepseek/deepseek-v4.1-flash": {
    name: "DeepSeek V4.1 Flash",
    status: "stale",
    cost: { input: 0.3, output: 1.2, cache_read: 0.006 },
    limit: { context: 1_000_000, output: 384_000 },
    input: ["text", "image"],
    variants: FULL,
  },
  "deepseek/deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    status: "stale",
    cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
    limit: { context: 1_048_576, output: 384_000 },
    input: ["text"],
    variants: ["low", "medium", "high", "max"],
  },
  "cline-free/solar-pro4": {
    name: "Solar Pro 4",
    status: "stale",
    cost: { input: 0.03, output: 0.12, cache_read: 0.006 },
    limit: { context: 524_288, output: 131_072 },
    input: ["text"],
    variants: ["low", "medium", "high", "max"],
  },
  "poolside/laguna-s-2.1:free": {
    name: "Laguna S 2.1",
    status: "stale",
    cost: { input: 0.1, output: 0.2, cache_read: 0.01 },
    limit: { context: 256_000, output: 32_000 },
    input: ["text"],
    variants: [],
  },
}

function toEntry(id: string, spec: ModelSpec): FreeEntry {
  return { id, name: spec.name, description: spec.description, ...(spec.status === "paid" ? { paid: true } : {}) }
}

/** Offline fallback: the bundled free rotation. */
export const FALLBACK_FREE: FreeEntry[] = Object.entries(MODELS)
  .filter(([, s]) => s.status === "free")
  .map(([id, s]) => toEntry(id, s))

/** Registered alongside the rotating free list even though they are not free. */
export const EXTRA_MODELS: FreeEntry[] = Object.entries(MODELS)
  .filter(([, s]) => s.status === "paid")
  .map(([id, s]) => toEntry(id, s))

export function isPaidModel(id: string | undefined): boolean {
  return !!id && MODELS[id]?.status === "paid"
}

export function withExtraModels(entries: FreeEntry[]): FreeEntry[] {
  const ids = new Set(entries.map((e) => e.id))
  return [...entries, ...EXTRA_MODELS.filter((e) => !ids.has(e.id))]
}

export function displayName(entry: FreeEntry): string {
  const base = (entry.name?.trim() || entry.id).trim()
  if (entry.paid || isPaidModel(entry.id)) return base.toLowerCase().includes("paid") ? base : `${base} (paid)`
  return base.toLowerCase().includes("free") ? base : `${base} (free)`
}

/**
 * Model config for OpenCode. Precedence per field: hand-verified registry
 * entry > automatically discovered catalog metadata > safe defaults. A brand
 * new free model therefore works with correct limits/inputs/cost without any
 * code change; add a registry entry only to pin probe-verified efforts.
 */
export function modelConfig(entry: FreeEntry, auto?: AutoMeta) {
  const spec = MODELS[entry.id]
  const limit = spec?.limit ?? auto?.limit ?? DEFAULT_LIMIT
  const levels = spec?.variants ?? (auto?.reasoning === false ? [] : DEFAULT_VARIANTS)
  const cost = spec?.cost ?? auto?.cost ?? DEFAULT_COST
  const variants: Record<string, { reasoningEffort: string }> = {}
  for (const level of levels) variants[level] = { reasoningEffort: level }
  return {
    name: displayName(entry),
    limit: { context: limit.context, output: limit.output },
    modalities: { input: spec?.input ?? auto?.input ?? DEFAULT_INPUT, output: ["text"] },
    tool_call: true,
    reasoning: true,
    cost: { input: cost.input, output: cost.output, cache_read: cost.cache_read, cache_write: 0 },
    ...(spec?.defaultEffort ? { options: { reasoningEffort: spec.defaultEffort } } : {}),
    ...(levels.length > 0 ? { variants } : {}),
  }
}
