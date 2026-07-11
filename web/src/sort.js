// Ordem das tasks na coluna. O default (prioridade + criação) é o mesmo que o
// servidor usa para montar a fila de execução — o que aparece no topo da coluna
// é o que roda primeiro.
// Espelhado em server/src/lib/sort.js — mudou aqui, muda lá.

export const PRIORITY_RANK = { urgent: 3, high: 2, medium: 1, low: 0 }

const rank = t => PRIORITY_RANK[t?.priority] ?? PRIORITY_RANK.medium
const time = v => { const n = Date.parse(v || ''); return Number.isNaN(n) ? 0 : n }

export const SORTS = {
  priority: (a, b) => rank(b) - rank(a) || time(a.created_at) - time(b.created_at),
  created: (a, b) => time(a.created_at) - time(b.created_at),
  recent: (a, b) => time(b.created_at) - time(a.created_at),
  updated: (a, b) => time(b.updated_at) - time(a.updated_at),
  title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'pt-BR'),
}

export const SORT_OPTIONS = [
  { key: 'priority', label: 'Prioridade' },
  { key: 'created', label: 'Mais antigas' },
  { key: 'recent', label: 'Mais recentes' },
  { key: 'updated', label: 'Atualizadas' },
  { key: 'title', label: 'Título (A–Z)' },
]

export const DEFAULT_SORT = 'priority'

export function sortTasks(tasks, key = DEFAULT_SORT) {
  return [...tasks].sort(SORTS[key] || SORTS[DEFAULT_SORT])
}

// A escolha de sort é preferência de UI, por coluna — vive no localStorage.
const KEY = 'ck.sort'

export function loadSorts() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {} } catch { return {} }
}

export function saveSorts(sorts) {
  try { localStorage.setItem(KEY, JSON.stringify(sorts)) } catch { /* storage indisponível */ }
}
