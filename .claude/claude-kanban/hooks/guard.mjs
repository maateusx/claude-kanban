#!/usr/bin/env node
// claude-kanban guardrails — PreToolUse hook.
// Uso: node guard.mjs <file|bash>   (evento JSON no stdin)
// Nega com JSON em stdout + exit 0; permite com exit 0 sem output.
// Limite honesto: parsing de comando não é sandbox — comandos ofuscados podem
// escapar. Cobre o caso realista do modelo tentar a ação diretamente.

import { execFileSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const mode = process.argv[2]

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}
const allow = () => process.exit(0)

// ---------- helpers exportáveis para teste ----------

const ENV_RE = /(^|[\/\s"'=])\.env(\.[\w.-]+)?($|[\/\s"'|;)&])/
const ENV_OK_RE = /\.env\.(example|template)$/i

export function isEnvPath(p) {
  if (!p) return false
  const base = path.basename(String(p))
  return /^\.env(\..+)?$/.test(base) && !ENV_OK_RE.test(base)
}

export function bashTouchesEnv(cmd) {
  // tokens que casem .env* (menos .example/.template)
  const tokens = String(cmd).split(/[\s;|&()<>]+/)
  return tokens.some(t => {
    const clean = t.replace(/^["']|["']$/g, '')
    if (!/\.env(\..+)?$/.test(clean)) return false
    return !ENV_OK_RE.test(clean)
  }) && ENV_RE.test(' ' + cmd)
}

export function currentBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch { return null }
}

export function checkGitRules(cmd, branch) {
  const c = String(cmd)
  const onMain = branch === 'main' || branch === 'master'

  if (/\bgit\b[^|;&]*\bcommit\b/.test(c) && onMain) {
    return `Commit direto em ${branch} é proibido. Crie um branch de trabalho (git checkout -b ...) e commite nele.`
  }
  // push explícito para main/master (inclui HEAD:main) e qualquer force-push para eles
  const pushMain = /\bgit\b[^|;&]*\bpush\b[^|;&]*\s(?:\S+\s+)?(?:HEAD:)?(main|master)\b/
  const forcePush = /\bgit\b[^|;&]*\bpush\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/
  if (pushMain.test(c)) {
    return 'Push para main/master é proibido. Abra um pull request a partir de um branch de trabalho.'
  }
  if (forcePush.test(c) && (pushMain.test(c) || onMain)) {
    return 'Force-push para main/master é proibido.'
  }
  if (/\bgit\b[^|;&]*\b(merge|rebase)\b/.test(c) && onMain) {
    return `merge/rebase com ${branch} como branch atual é proibido. Trabalhe em um branch e abra PR.`
  }
  return null
}

export function checkBranchDelete(cmd) {
  const c = String(cmd)
  if (/\bgit\b[^|;&]*\bbranch\b[^|;&]*\s(-d|-D|--delete)\b/.test(c)) return true
  if (/\bgit\b[^|;&]*\bpush\b[^|;&]*\s(--delete|-d)\b/.test(c)) return true
  if (/\bgit\b[^|;&]*\bpush\b[^|;&]*\s\S+\s+:\S+/.test(c)) return true
  if (/\bgit\b[^|;&]*\bworktree\s+remove\b[^|;&]*\s(--force|-f)\b/.test(c)) return true
  return false
}

// extrai alvos de comandos destrutivos; retorna null se comando não é destrutivo
export function destructiveTargets(cmd) {
  const c = String(cmd)
  const targets = []
  // find ... -delete
  if (/\bfind\b[^|;&]*\s-delete\b/.test(c)) {
    const m = c.match(/\bfind\s+((?:"[^"]*"|'[^']*'|\S)+)/)
    targets.push(m ? unquote(m[1]) : '/')
    return targets
  }
  const re = /\b(rm|rmdir|unlink|shred)\b((?:\s+(?:-\S+|"[^"]*"|'[^']*'|[^\s;|&]+))*)/g
  let m
  let found = false
  while ((m = re.exec(c))) {
    found = true
    const args = m[2].match(/(?:"[^"]*"|'[^']*'|[^\s;|&]+)/g) || []
    for (const a of args) {
      if (a.startsWith('-')) continue
      targets.push(unquote(a))
    }
  }
  // git clean com paths
  const gc = c.match(/\bgit\b[^|;&]*\bclean\b((?:\s+\S+)*)/)
  if (gc) {
    found = true
    const args = (gc[1].match(/\S+/g) || []).filter(a => !a.startsWith('-'))
    targets.push(...args)
  }
  return found ? targets : null
}

const unquote = s => s.replace(/^["']|["']$/g, '')

export function isOutsideProject(target, projectRoot, cwd) {
  const t = String(target)
  if (t.startsWith('~') || t.includes('$HOME')) return true
  const resolved = path.resolve(cwd || projectRoot, t.replace(/\$CLAUDE_PROJECT_DIR/g, projectRoot))
  const root = safeReal(projectRoot)
  const real = safeReal(resolved)
  return !(real === root || real.startsWith(root + path.sep))
}

export function isCatastrophic(cmd, target, projectRoot) {
  if (!/\brm\b[^|;&]*(-\w*r\w*f|-\w*f\w*r|--recursive[^|;&]*--force|--force[^|;&]*--recursive)/.test(String(cmd))) return false
  const real = safeReal(path.resolve(projectRoot, unquote(String(target))))
  return real === '/' || real === safeReal(os.homedir()) || real === safeReal(projectRoot)
}

function safeReal(p) {
  try { return realpathSync(p) } catch {
    // path pode não existir; resolve pais até achar um real
    const parent = path.dirname(p)
    if (parent === p) return p
    return path.join(safeReal(parent), path.basename(p))
  }
}

function nanoid(n = 6) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)]
  return s
}

function recordPendingAction(projectRoot, label, cmd) {
  try {
    const file = path.join(projectRoot, '.claude', 'claude-kanban', 'pending-actions.md')
    const taskId = process.env.CLAUDE_KANBAN_TASK_ID || null
    const block = [
      '',
      `## [pa-${nanoid()}] ${new Date().toISOString()} — ${label}`,
      `- comando bloqueado: \`${cmd}\``,
      ...(taskId ? [`- task: ${taskId}`] : []),
      '- status: pending',
      '',
    ].join('\n')
    appendFileSync(file, block)
  } catch { /* nunca falhar o hook por causa do log */ }
}

// ---------- main ----------

async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  let evt
  try { evt = JSON.parse(input) } catch { allow() }

  const toolInput = evt.tool_input || {}
  const cwd = evt.cwd || process.cwd()
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || cwd

  if (mode === 'file') {
    const candidates = [toolInput.file_path, toolInput.path, toolInput.pattern, toolInput.notebook_path]
    if (candidates.some(isEnvPath)) {
      deny('Leitura de .env bloqueada por política do projeto. Use variáveis já carregadas no ambiente ou peça ao humano o valor necessário.')
    }
    allow()
  }

  if (mode === 'bash') {
    const cmd = toolInput.command || ''

    // Regra A — .env
    if (bashTouchesEnv(cmd)) {
      deny('Leitura de .env bloqueada por política do projeto. Use variáveis já carregadas no ambiente ou peça ao humano o valor necessário.')
    }

    // Regra B — git em main/master
    if (/\bgit\b/.test(cmd)) {
      const needsBranch = /\b(commit|merge|rebase|push)\b/.test(cmd)
      const branch = needsBranch ? currentBranch(cwd) : null
      const gitReason = checkGitRules(cmd, branch)
      if (gitReason) deny(gitReason)

      // Regra C — deleção de branch
      if (checkBranchDelete(cmd)) {
        recordPendingAction(projectRoot, 'deletar branch', cmd)
        deny('Deleção de branch é ação exclusivamente humana. Registre a solicitação e siga em frente.')
      }
    }

    // Regra D — deleção fora do projeto
    const targets = destructiveTargets(cmd)
    if (targets) {
      for (const t of targets) {
        if (isCatastrophic(cmd, t, projectRoot)) {
          deny('rm -rf de path crítico bloqueado.')
        }
        if (isOutsideProject(t, projectRoot, cwd)) {
          recordPendingAction(projectRoot, 'deletar arquivo externo', cmd)
          deny('Deleção fora do escopo do projeto bloqueada. A solicitação foi registrada em pending-actions para execução manual pelo humano. Continue a task sem essa deleção.')
        }
      }
    }
    allow()
  }

  allow()
}

// só roda main quando executado diretamente (permite import nos testes)
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
