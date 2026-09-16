import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { pendingFile } from './paths.js'
import { bashTouchesEnv, checkGitRules } from '../../templates/guard.mjs'
import { gitSettings, projectBranch } from './git.js'

// Parseia blocos "## [pa-xxxxxx] <ts> — <label>" de pending-actions.md
export function listPendingActions(projectPath) {
  let raw = ''
  try { raw = fs.readFileSync(pendingFile(projectPath), 'utf8') } catch { return [] }
  const actions = []
  const re = /^## \[(pa-\w+)\] (\S+) — (.+)$/gm
  let m
  while ((m = re.exec(raw))) {
    const start = m.index
    const end = raw.indexOf('\n## ', start + 1)
    const block = raw.slice(start, end === -1 ? undefined : end)
    const cmd = block.match(/- comando bloqueado: `([^`]*)`/)?.[1] || null
    const taskId = block.match(/- task: (\S+)/)?.[1] || null
    const status = block.match(/- status: (\w+)/)?.[1] || 'pending'
    const auto = block.match(/^- resolvido pela política: `([^`]*)` \((.*)\)$/m)
    const policy = auto ? {
      pattern: auto[1], result: auto[2],
      output: (block.split('\n- saída:\n')[1] || '').split('\n').filter(l => l.startsWith('    ')).map(l => l.slice(4)).join('\n'),
    } : null
    actions.push({ id: m[1], timestamp: m[2], label: m[3].trim(), command: cmd, taskId, status, policy })
  }
  return actions
}

export function resolvePendingAction(projectPath, actionId) {
  const file = pendingFile(projectPath)
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return false }
  const re = new RegExp(`(## \\[${actionId}\\][\\s\\S]*?- status: )pending`)
  if (!re.test(raw)) return false
  fs.writeFileSync(file, raw.replace(re, '$1done'))
  return true
}

// Executa o comando bloqueado de uma ação pendente no diretório do projeto.
// É um escape-hatch acionado explicitamente pelo humano na UI: os guardrails
// barram o Claude, não o operador. Não marca a ação como resolvida — quem
// decide isso é quem olhou a saída.
export function runPendingAction(projectPath, actionId, timeout = 120_000) {
  const action = listPendingActions(projectPath).find(a => a.id === actionId)
  if (!action) return null
  if (!action.command) return { ...action, output: '', exitCode: null, error: 'ação sem comando registrado' }
  return new Promise(resolve => {
    execFile(action.command, {
      cwd: projectPath, shell: true, timeout, maxBuffer: 1024 * 1024,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`
      resolve({
        ...action,
        output: output.slice(-20_000),
        exitCode: err ? (err.code ?? null) : 0,
        error: err && typeof err.code !== 'number' ? err.message : null,
      })
    })
  })
}

// ---- política de guardrail do projeto ----
// `project.guardrailPolicy`: padrões de comando (`*` = qualquer trecho) que o
// servidor executa sozinho quando caem em pending-actions. O agente continua
// bloqueado pelo guard.mjs; quem roda é o orquestrador. `git branch -d` só apaga
// branch já mergeada (o git recusa as outras), daí ser a regra padrão.
export const DEFAULT_GUARDRAIL_POLICY = ['git branch -d kanban/*']

export const guardrailPolicy = p => (Array.isArray(p?.guardrailPolicy) ? p.guardrailPolicy : DEFAULT_GUARDRAIL_POLICY)

// Metacaracteres de shell (encadear, redirecionar, substituir, quotar, glob):
// comando com qualquer um deles nunca casa, mesmo que o padrão "cubra" o texto.
const SHELL_META = /[;&|<>$`\\'"*?()\n\r]/

// Motivo pelo qual a política nunca pode executar o comando, ou null.
export function policyForbidden(cmd, { branch = null, baseBranch = 'main' } = {}) {
  if (bashTouchesEnv(cmd)) return 'toca .env'
  const git = checkGitRules(cmd, branch)
  if (git) return git
  if (/\bpush\b/.test(cmd) && cmd.split(/\s+/).some(t => t.replace(/^\+?(HEAD:|refs\/heads\/)?/, '') === baseBranch)) {
    return `push em ${baseBranch}`
  }
  return null
}

// Primeiro padrão da política que casa o comando inteiro, ou null.
export function matchPolicy(cmd, patterns) {
  const c = String(cmd || '').trim()
  if (!c || SHELL_META.test(c)) return null
  return patterns.find(pat => {
    const src = String(pat).trim().split('*').map(x => x.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('.*')
    return src && new RegExp(`^${src}$`).test(c)
  }) || null
}

// A política cobre o comando neste projeto? (casa um padrão e não é proibido)
export function policyCovers(project, cmd) {
  if (!cmd || !matchPolicy(cmd, guardrailPolicy(project))) return false
  return !policyForbidden(cmd, { branch: projectBranch(project.path), baseBranch: gitSettings(project).baseBranch })
}

const autoRunning = new Set()

// Roda as ações pendentes que a política cobre e as marca como resolvidas, com a
// saída gravada no item. Fora da política (ou proibidas), seguem para o humano.
export async function autoResolvePending(project) {
  const patterns = guardrailPolicy(project)
  const done = []
  for (const a of listPendingActions(project.path)) {
    if (a.status !== 'pending' || !a.command || autoRunning.has(a.id)) continue
    if (!policyCovers(project, a.command)) continue
    const pattern = matchPolicy(a.command, patterns)
    autoRunning.add(a.id)
    try {
      const res = await runPendingAction(project.path, a.id)
      const exit = res.error ? `erro: ${res.error}` : `exit ${res.exitCode}`
      // saída indentada: uma linha "## " nela não quebra o parse dos blocos
      const out = (res.output || '(sem saída)').trimEnd().split('\n').map(l => `    ${l}`).join('\n')
      const file = pendingFile(project.path)
      const re = new RegExp(`(## \\[${a.id}\\][\\s\\S]*?- status: )pending`)
      const raw = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, raw.replace(re, (_, head) =>
        `${head}done\n- resolvido pela política: \`${pattern}\` (${exit})\n- saída:\n\n${out}\n`))
      done.push({ id: a.id, pattern, exitCode: res.exitCode })
    } finally { autoRunning.delete(a.id) }
  }
  return done
}
