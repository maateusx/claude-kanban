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
