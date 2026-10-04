import { RECOMMENDED_URL } from "./constants.ts"
import { FALLBACK_FREE, withExtraModels, type FreeEntry, type RecommendedPayload } from "./models.ts"
import { poolFilePath, type Logger } from "./pool.ts"

const MODELS_CACHE_FILE_NAME = "cline-free-models.json"

type ModelsCache = { version: 1; fetchedAt: number; free: FreeEntry[] }

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

/** Live `free` array, or undefined when Cline is unreachable / returns nothing. */
export async function fetchLiveFreeModels(timeoutMs = 12_000): Promise<FreeEntry[] | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(RECOMMENDED_URL, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "opencode-cline-free" },
    })
    if (!res.ok) return undefined
    const free = validEntries(((await res.json()) as RecommendedPayload).free)
    return free.length > 0 ? free : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export async function readModelsCache(): Promise<FreeEntry[] | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    const data = JSON.parse(await readFile(modelsCachePath(), "utf8")) as Partial<ModelsCache>
    const free = validEntries(data.free)
    return free.length > 0 ? free : undefined
  } catch {
    return undefined
  }
}

export async function writeModelsCache(free: FreeEntry[]): Promise<void> {
  const { mkdir, writeFile, rename, unlink } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  const file = modelsCachePath()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  const body: ModelsCache = { version: 1, fetchedAt: Date.now(), free }
  try {
    await writeFile(tmp, JSON.stringify(body, null, 2))
    await rename(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

async function refreshAndCache(timeoutMs: number, log?: Logger): Promise<FreeEntry[] | undefined> {
  const live = await fetchLiveFreeModels(timeoutMs)
  if (live) {
    await writeModelsCache(live).catch((e) =>
      log?.("warn", `cline-free: could not save model cache: ${e instanceof Error ? e.message : String(e)}`),
    )
  }
  return live ? withExtraModels(live) : undefined
}

/**
 * Startup model list, fastest source first:
 * 1. Last good live list saved on disk → returned immediately; a live refresh
 *    runs in the background (`refreshed`) and rewrites the cache.
 * 2. No cache → wait for the live list (bounded timeout), then cache it.
 * 3. Offline with no cache → bundled FALLBACK_FREE.
 * Extra (paid) models are always appended.
 */
export async function loadFreeModels(
  log?: Logger,
  timeoutMs = 12_000,
): Promise<{ entries: FreeEntry[]; source: "cache" | "live" | "fallback"; refreshed: Promise<FreeEntry[] | undefined> }> {
  const cached = await readModelsCache()
  if (cached) {
    const refreshed = refreshAndCache(timeoutMs, log).catch(() => undefined)
    return { entries: withExtraModels(cached), source: "cache", refreshed }
  }
  const live = await refreshAndCache(timeoutMs, log).catch(() => undefined)
  if (live) return { entries: live, source: "live", refreshed: Promise.resolve(undefined) }
  return { entries: withExtraModels(FALLBACK_FREE), source: "fallback", refreshed: Promise.resolve(undefined) }
}
