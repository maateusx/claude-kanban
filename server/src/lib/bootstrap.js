import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION, STATUSES, kanbanDir, tasksDir, pendingFile, templatesDir } from './paths.js'
import { reconcileProject } from './tasks.js'

const TPL = fileURLToPath(new URL('../../templates/', import.meta.url))

const GUARD_CMD_MARKER = '.claude/claude-kanban/hooks/'

const HOOK_BLOCKS = [
  {
    matcher: 'Read|Edit|Write|Grep|Glob',
    hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/claude-kanban/hooks/guard.mjs" file' }],
  },
  {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/claude-kanban/hooks/guard.mjs" bash' }],
  },
]

const isOurs = h => typeof h?.command === 'string' && h.command.includes(GUARD_CMD_MARKER)

// Deep-merge dos hooks: remove entradas nossas antigas, preserva as do usuário, adiciona as atuais
export function mergeSettings(settings) {
  const out = settings ? structuredClone(settings) : {}
  out.hooks = out.hooks || {}
  let pre = Array.isArray(out.hooks.PreToolUse) ? out.hooks.PreToolUse : []
  pre = pre
    .map(entry => ({ ...entry, hooks: (entry.hooks || []).filter(h => !isOurs(h)) }))
    .filter(entry => entry.hooks.length > 0)
  out.hooks.PreToolUse = [...pre, ...structuredClone(HOOK_BLOCKS)]
  return out
}

export function uninstallFromSettings(settings) {
  if (!settings?.hooks?.PreToolUse) return settings
  const out = structuredClone(settings)
  out.hooks.PreToolUse = out.hooks.PreToolUse
    .map(entry => ({ ...entry, hooks: (entry.hooks || []).filter(h => !isOurs(h)) }))
    .filter(entry => entry.hooks.length > 0)
  if (out.hooks.PreToolUse.length === 0) delete out.hooks.PreToolUse
  if (Object.keys(out.hooks).length === 0) delete out.hooks
  return out
}

export function bootstrapProject(projectPath) {
  const claudeDir = path.join(projectPath, '.claude')
  const kd = kanbanDir(projectPath)

  // 1. estrutura de pastas
  for (const s of STATUSES) fs.mkdirSync(tasksDir(projectPath, s), { recursive: true })
  fs.mkdirSync(path.join(kd, 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(claudeDir, 'skills', 'claude-kanban'), { recursive: true })

  // 2. guard.mjs (sobrescreve se versão do app for mais nova)
  const metaFile = path.join(kd, 'meta.json')
  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch {}
  const guardPath = path.join(kd, 'hooks', 'guard.mjs')
  if (!fs.existsSync(guardPath) || cmpVersion(APP_VERSION, meta.kanbanVersion || '0.0.0') > 0) {
    fs.copyFileSync(path.join(TPL, 'guard.mjs'), guardPath)
  }

  // 3. merge de settings.json (aborta se JSON inválido)
  const settingsFile = path.join(claudeDir, 'settings.json')
  let settings = {}
  if (fs.existsSync(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, 'utf8')
    try { settings = JSON.parse(raw) } catch (e) {
      const err = new Error(`settings.json inválido: ${e.message}`)
      err.code = 'BOOTSTRAP_FAILED'
      throw err
    }
  }
  fs.writeFileSync(settingsFile, JSON.stringify(mergeSettings(settings), null, 2) + '\n')

  // 4. skill
  fs.copyFileSync(path.join(TPL, 'SKILL.md'), path.join(claudeDir, 'skills', 'claude-kanban', 'SKILL.md'))

  // 5. templates de task (exemplos): nunca sobrescreve — são do usuário depois
  // de criados, inclusive se ele apagar um deles não recriamos... exceto se a
  // pasta inteira não existir (projeto novo / templates ainda não instalados).
  const td = templatesDir(projectPath)
  if (!fs.existsSync(td)) {
    fs.mkdirSync(td, { recursive: true })
    for (const f of fs.readdirSync(path.join(TPL, 'task-templates'))) {
      fs.copyFileSync(path.join(TPL, 'task-templates', f), path.join(td, f))
    }
  }

  // 6. pending-actions.md (nunca sobrescreve)
  if (!fs.existsSync(pendingFile(projectPath))) fs.writeFileSync(pendingFile(projectPath), '')

  // 7. gitignore
  if (fs.existsSync(path.join(projectPath, '.git'))) {
    const gi = path.join(projectPath, '.gitignore')
    const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : ''
    // tasks/ e diffs/ são metadados gerenciados pelo orquestrador — se forem
    // commitados pela sessão, o status (que vive na pasta) viaja no git e volta
    // desatualizado num futuro checkout/merge, causando re-execução em loop.
    const lines = [
      '.claude/claude-kanban/pending-actions.md',
      '.claude/claude-kanban/meta.json',
      '.claude/claude-kanban/tasks/',
      '.claude/claude-kanban/diffs/',
      '.claude/claude-kanban/logs/',
    ]
      .filter(l => !existing.split('\n').includes(l))
    if (lines.length) fs.writeFileSync(gi, existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + lines.join('\n') + '\n')
  }

  // meta
  fs.writeFileSync(metaFile, JSON.stringify({ kanbanVersion: APP_VERSION, bootstrappedAt: new Date().toISOString() }, null, 2) + '\n')

  // 8. reconciliação
  reconcileProject(projectPath)
}

export function uninstallGuardrails(projectPath) {
  const settingsFile = path.join(projectPath, '.claude', 'settings.json')
  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      fs.writeFileSync(settingsFile, JSON.stringify(uninstallFromSettings(settings), null, 2) + '\n')
    } catch { /* settings inválido: não toca */ }
  }
  fs.rmSync(kanbanDir(projectPath), { recursive: true, force: true })
  fs.rmSync(path.join(projectPath, '.claude', 'skills', 'claude-kanban'), { recursive: true, force: true })
}

export function bootstrapStatus(projectPath) {
  const metaFile = path.join(kanbanDir(projectPath), 'meta.json')
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    return cmpVersion(APP_VERSION, meta.kanbanVersion) > 0 ? 'outdated' : 'ok'
  } catch { return 'missing' }
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0) }
  return 0
}
