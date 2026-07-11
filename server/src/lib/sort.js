// Ordem canônica das tasks. A fila de execução (autoRun) e a coluna do board no
// web usam a mesma regra default: prioridade mais alta primeiro; empate resolve
// pela mais antiga (created_at asc), para que nada fique preso atrás de uma task
// nova de mesma prioridade.
// Espelhado em web/src/sort.js — mudou aqui, muda lá.

export const PRIORITY_RANK = { urgent: 3, high: 2, medium: 1, low: 0 }

export const rank = t => PRIORITY_RANK[t?.priority] ?? PRIORITY_RANK.medium
const time = v => { const n = Date.parse(v || ''); return Number.isNaN(n) ? 0 : n }

export const SORTS = {
  priority: (a, b) => rank(b) - rank(a) || time(a.created_at) - time(b.created_at),
  created: (a, b) => time(a.created_at) - time(b.created_at),
  recent: (a, b) => time(b.created_at) - time(a.created_at),
  updated: (a, b) => time(b.updated_at) - time(a.updated_at),
  title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'pt-BR'),
}

export const DEFAULT_SORT = 'priority'

export function sortTasks(tasks, key = DEFAULT_SORT) {
  return [...tasks].sort(SORTS[key] || SORTS[DEFAULT_SORT])
}
