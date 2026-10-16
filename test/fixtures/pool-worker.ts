// Offline subprocess used to exercise genuine cross-process pool snapshots.
import {
  loadPoolFile,
  savePoolFile,
  refreshAccount,
  rememberRemoval,
  forgetRemoval,
  upsertApiAccount,
  type PoolFile,
} from "../../src/core/pool.ts"
let pool: PoolFile
process.on("message", async (message: { action: string; value?: string }) => {
  try {
    let refreshCalls = 0
    switch (message.action) {
      case "load":
        pool = await loadPoolFile()
        break
      case "rotate":
        pool.accounts[0].access = "rotated-access"
        pool.accounts[0].refresh = "rotated-refresh"
        pool.accounts[0].expires = 4_000_000_000_000
        await savePoolFile(pool)
        break
      case "metadata":
        pool.accounts[0].lastUsed = 123456
        pool.accounts[0].modelLimits = { subprocess: 4_000_000_000_000 }
        await savePoolFile(pool)
        break
      case "add":
        upsertApiAccount(pool, message.value!, message.value)
        await savePoolFile(pool)
        break
      case "remove": {
        const [account] = pool.accounts.splice(0, 1)
        rememberRemoval(pool, account.access ?? account.apiKey!)
        await savePoolFile(pool)
        break
      }
      case "revive":
        forgetRemoval(pool, "old-access")
        upsertApiAccount(pool, "old-access")
        await savePoolFile(pool)
        break
      case "refresh":
        globalThis.fetch = async () => {
          refreshCalls++
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                accessToken: "worker-access",
                refreshToken: "worker-refresh",
                expiresAt: "2090-01-01T00:00:00Z",
              },
            }),
          )
        }
        await refreshAccount(pool, pool.accounts[0], () => {})
        break
      default:
        throw new Error("unknown action")
    }
    process.send!({ ok: true, refreshCalls })
  } catch (error) {
    process.send!({ error: error instanceof Error ? error.stack : String(error) })
  }
})
process.send!({ ready: true })
