import path from 'node:path'
import { HOME_DIR, readJson, writeJson } from './paths.js'

// Ledger persistente de execução, independente do status no filesystem/git.
// Fonte de verdade para "este card já rodou com sucesso" — evita re-execução
// em loop quando o status (que vive na pasta) se perde por não ser commitado.
const ledgerFile = () => path.join(process.env.CLAUDE_KANBAN_HOME || HOME_DIR, 'ledger.json')

function load() { return readJson(ledgerFile(), { executed: {} }) }

export function getExecuted(taskId) { return load().executed[taskId] || null }

// Um card só é considerado "concluído" após uma execução com exit 0.
// Falhas (exit != 0, timeout, morte manual) NÃO entram aqui, então re-executam
// normalmente respeitando o limite de attempts.
export function wasSucceeded(taskId) {
  const e = getExecuted(taskId)
  return !!e && e.exitCode === 0
}

export function markSucceeded(taskId, entry = {}) {
  const l = load()
  l.executed[taskId] = { exitCode: 0, ...entry }
  writeJson(ledgerFile(), l)
}

// Limpa o registro — usado quando o usuário re-enfileira o card explicitamente,
// deixando claro que quer rodar de novo.
export function clearExecuted(taskId) {
  const l = load()
  if (l.executed[taskId]) { delete l.executed[taskId]; writeJson(ledgerFile(), l) }
}
