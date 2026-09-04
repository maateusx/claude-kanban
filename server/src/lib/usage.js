import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Usage/limites do plano Claude via o mesmo endpoint OAuth que o `/usage` do CLI usa.
// Endpoint interno não documentado — em qualquer falha retornamos { available: false }
// e a UI simplesmente esconde o widget.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CACHE_MS = 60_000

let cache = null // { at, data }

// exportado: o catálogo de modelos usa o mesmo token para falar com a Models API
export function readToken() {
  // macOS: token fica no Keychain; Linux/fallback: ~/.claude/.credentials.json
  let raw = null
  if (process.platform === 'darwin') {
    try {
      raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {}
  }
  if (!raw) {
    try { raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8') } catch {}
  }
  if (!raw) return null
  try { return JSON.parse(raw)?.claudeAiOauth?.accessToken || null } catch { return null }
}

export async function getUsage() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data

  let data = { available: false }
  const token = readToken()
  if (token) {
    try {
      const res = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const body = await res.json()
        data = {
          available: true,
          limits: (body.limits || []).map(l => ({
            kind: l.kind,               // session | weekly_all | weekly_scoped
            percent: l.percent,
            severity: l.severity,       // normal | warning | ...
            resetsAt: l.resets_at,
            isActive: l.is_active,
            model: l.scope?.model?.display_name || null,
          })),
        }
      }
    } catch {}
  }
  cache = { at: Date.now(), data }
  return data
}
