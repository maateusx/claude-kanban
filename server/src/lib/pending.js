import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { pendingFile } from './paths.js'

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
    actions.push({ id: m[1], timestamp: m[2], label: m[3].trim(), command: cmd, taskId, status })
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
