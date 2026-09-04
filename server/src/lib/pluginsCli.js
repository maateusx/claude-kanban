import { execFile } from 'node:child_process'

// Plugins do Claude Code são gerenciados pelo próprio CLI (`claude plugin`), que
// já sabe resolver marketplaces, cache e escopo. Em vez de reescrever isso
// mexendo em installed_plugins.json/settings.json na mão, só encapsulamos o CLI.
//
// Escopo: sem projeto → `--scope user` (global); com projeto → `--scope project`
// rodando com cwd no projeto, que é como o CLI grava em <projeto>/.claude/settings.json.

const TIMEOUT_MS = 120_000
const CACHE_MS = 60_000
let cache = null // { at, data } — a listagem com --available baixa marketplace e demora

const ACTIONS = { install: 'install', uninstall: 'uninstall', enable: 'enable', disable: 'disable' }
const PLUGIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(@[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('claude', args, { cwd: cwd || process.cwd(), timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || stdout || err.message).trim().slice(0, 800)))
        resolve(stdout)
      })
  })
}

export async function listPlugins({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data
  const out = await run(['plugin', 'list', '--json', '--available'])
  let parsed
  try { parsed = JSON.parse(out) } catch { throw new Error('resposta inesperada do `claude plugin list`') }
  const data = {
    installed: parsed.installed || [],
    available: (parsed.available || []).map(p => ({
      id: p.pluginId, name: p.name, description: p.description,
      marketplace: p.marketplaceName, installCount: p.installCount || 0,
    })),
  }
  cache = { at: Date.now(), data }
  return data
}

export async function pluginAction(action, id, projectPath) {
  if (!ACTIONS[action]) throw new Error('ação inválida')
  if (!PLUGIN_RE.test(String(id || ''))) throw new Error('plugin inválido')
  const scope = projectPath ? 'project' : 'user'
  const args = ['plugin', ACTIONS[action], id, '--scope', scope]
  if (action === 'install') args.push('--yes')
  const out = await run(args, projectPath)
  cache = null
  return { ok: true, output: out.trim().slice(0, 2000) }
}
