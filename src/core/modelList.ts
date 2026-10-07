import { API_BASE, RECOMMENDED_URL } from "./constants.ts"
import { FALLBACK_FREE, withExtraModels, type AutoMeta, type FreeEntry, type RecommendedPayload } from "./models.ts"
import { poolFilePath, type Logger } from "./pool.ts"

/** Public Cline model catalog (OpenRouter-style: limits, modalities, pricing). */
export const CATALOG_URL = `${API_BASE}/api/v1/ai/cline/models`

const MODELS_CACHE_FILE_NAME = "cline-free-models.json"

type ModelsCache = { version: 1 | 2; fetchedAt: number; free: FreeEntry[]; meta?: Record<string, AutoMeta> }
export type ModelSnapshot = { entries: FreeEntry[]; meta: Record<string, AutoMeta> }

export function modelsCachePath(): string {
  const override = process.env.CLINE_FREE_MODELS_FILE?.trim()
  if (override) return override
  const file = poolFilePath()
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
  return `${slash >= 0 ? file.slice(0, slash + 1) : ""}${MODELS_CACHE_FILE_NAME}`
}

function validEntries(list: unknown): FreeEntry[] {
  if (!Array.isArray(list)) return []
  return list.filter((m): m is FreeEntry => typeof m?.id === "string" && m.id.length > 0)
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "opencode-cline-free" },
    })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Live `free` array, or undefined when Cline is unreachable / returns nothing. */
export async function fetchLiveFreeModels(timeoutMs = 12_000): Promise<FreeEntry[] | undefined> {
  const payload = (await getJson(RECOMMENDED_URL, timeoutMs)) as RecommendedPayload | undefined
  const free = validEntries(payload?.free)
  return free.length > 0 ? free : undefined
}

type CatalogModel = {
  id?: string
  context_length?: number
  architecture?: { input_modalities?: string[] }
  top_provider?: { context_length?: number; max_completion_tokens?: number }
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string }
  supported_parameters?: string[]
}

const perMillion = (v: string | undefined): number | undefined => {
  const n = v === undefined ? NaN : Number(v)
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined
}

/** Catalog row → plugin metadata. Cline's catalog says `file` for PDFs. */
export function toAutoMeta(m: CatalogModel): AutoMeta {
  const context = m.top_provider?.context_length ?? m.context_length
  const output = m.top_provider?.max_completion_tokens
  const input = m.architecture?.input_modalities?.map((x) => (x === "file" ? "pdf" : x))
  const pIn = perMillion(m.pricing?.prompt)
  const pOut = perMillion(m.pricing?.completion)
  const params = m.supported_parameters
  return {
    ...(context && context > 0 ? { limit: { context, output: output && output > 0 ? Math.min(output, context) : 32_000 } } : {}),
    ...(input && input.length > 0 ? { input } : {}),
    ...(pIn !== undefined && pOut !== undefined
      ? { cost: { input: pIn, output: pOut, cache_read: perMillion(m.pricing?.input_cache_read) ?? 0 } }
      : {}),
    ...(Array.isArray(params) ? { reasoning: params.includes("reasoning") || params.includes("reasoning_effort") } : {}),
  }
}

/**
 * Match free ids to catalog rows: exact id first, else the same model name
 * under its vendor (`cline-free/mimo-v2.6-flash` → `xiaomi/mimo-v2.6-flash`).
 */
export function matchMetadata(ids: string[], catalog: CatalogModel[]): Record<string, AutoMeta> {
  const byId = new Map<string, CatalogModel>()
  const byName = new Map<string, CatalogModel>()
  for (const m of catalog) {
    if (typeof m?.id !== "string") continue
    byId.set(m.id, m)
    const name = m.id.split("/").pop()!
    if (!name.includes(":") && !byName.has(name)) byName.set(name, m)
  }
  const out: Record<string, AutoMeta> = {}
  for (const id of ids) {
    const name = id.split("/").pop()!.replace(/:free$/, "")
    const row = byId.get(id) ?? byName.get(name)
    if (row) out[id] = toAutoMeta(row)
  }
  return out
}

export async function fetchCatalogMetadata(ids: string[], timeoutMs = 12_000): Promise<Record<string, AutoMeta>> {
  const payload = (await getJson(CATALOG_URL, timeoutMs)) as { data?: CatalogModel[] } | CatalogModel[] | undefined
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []
  return matchMetadata(ids, rows)
}

export async function readModelsCache(): Promise<ModelSnapshot | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    const data = JSON.parse(await readFile(modelsCachePath(), "utf8")) as Partial<ModelsCache>
    const free = validEntries(data.free)
    return free.length > 0 ? { entries: free, meta: data.meta ?? {} } : undefined
  } catch {
    return undefined
  }
}

export async function writeModelsCache(free: FreeEntry[], meta: Record<string, AutoMeta> = {}): Promise<void> {
  const { mkdir, writeFile, rename, unlink } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  const file = modelsCachePath()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  const body: ModelsCache = { version: 2, fetchedAt: Date.now(), free, meta }
  try {
    await writeFile(tmp, JSON.stringify(body, null, 2))
    await rename(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

async function refreshAndCache(timeoutMs: number, log?: Logger): Promise<ModelSnapshot | undefined> {
  const live = await fetchLiveFreeModels(timeoutMs)
  if (!live) return undefined
  const entries = withExtraModels(live)
  const meta = await fetchCatalogMetadata(
    entries.map((e) => e.id),
    timeoutMs,
  ).catch(() => ({}))
  await writeModelsCache(live, meta).catch((e) =>
    log?.("warn", `cline-free: could not save model cache: ${e instanceof Error ? e.message : String(e)}`),
  )
  return { entries, meta }
}

/**
 * Startup model list, fastest source first:
 * 1. Last good live list (+ catalog metadata) saved on disk → returned
 *    immediately; a live refresh runs in the background (`refreshed`).
 * 2. No cache → wait for the live list (bounded timeout), then cache it.
 * 3. Offline with no cache → bundled FALLBACK_FREE.
 * Extra (paid) models are always appended.
 */
export async function loadFreeModels(
  log?: Logger,
  timeoutMs = 12_000,
): Promise<ModelSnapshot & { source: "cache" | "live" | "fallback"; refreshed: Promise<ModelSnapshot | undefined> }> {
  const cached = await readModelsCache()
  if (cached) {
    const refreshed = refreshAndCache(timeoutMs, log).catch(() => undefined)
    return { entries: withExtraModels(cached.entries), meta: cached.meta, source: "cache", refreshed }
  }
  const live = await refreshAndCache(timeoutMs, log).catch(() => undefined)
  if (live) return { ...live, source: "live", refreshed: Promise.resolve(undefined) }
  return { entries: withExtraModels(FALLBACK_FREE), meta: {}, source: "fallback", refreshed: Promise.resolve(undefined) }
}
