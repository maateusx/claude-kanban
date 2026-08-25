import { MODELS_FILE, readJson, writeJson } from './paths.js'
import { readToken } from './usage.js'

// Catálogo de modelos oferecidos na UI. O `id` é exatamente o que vai para
// `claude --model`, então precisa ser o slug oficial do modelo — não o apelido
// ("opus", "sonnet") que resolve para "o mais recente da família" e muda com o
// tempo.
//
// A lista abaixo é só o fallback embutido (sem rede / sem credencial). A fonte
// da verdade é a Models API da Anthropic (`GET /v1/models`), buscada pelo botão
// "atualizar modelos" e persistida em ~/.claude-kanban/models.json.
//
// Ordem importa: newest-first. Apelidos legados ("opus") migram para o primeiro
// modelo da família na lista, que é o mais recente.
export const FALLBACK_MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
]

const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100'
const ALIASES = ['opus', 'sonnet', 'haiku', 'fable']

let cache // { fetchedAt, models } — carregado do disco na primeira leitura

function cached() {
  if (cache === undefined) cache = readJson(MODELS_FILE, null)
  return cache?.models?.length ? cache : null
}

// Catálogo vigente: o que veio da API se já houve refresh, senão o fallback.
export function listModels() {
  return cached()?.models || FALLBACK_MODELS
}

export function modelsCatalog() {
  const c = cached()
  return { models: listModels(), fetchedAt: c?.fetchedAt || null, source: c ? 'api' : 'fallback' }
}

// Busca a lista oficial na Models API usando o mesmo token OAuth do Claude Code
// que o widget de usage já consome. Grava em disco e devolve o catálogo novo.
export async function refreshModels() {
  const token = readToken()
  if (!token) throw new Error('sem credencial do Claude Code — faça login no CLI (`claude`) e tente de novo')

  const res = await fetch(MODELS_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Models API respondeu ${res.status}`)

  const body = await res.json()
  // A API já devolve newest-first; só normalizamos o rótulo ("Claude Opus 5" → "Opus 5").
  const models = (body.data || [])
    .filter(m => typeof m.id === 'string' && m.id.startsWith('claude-'))
    .map(m => ({ id: m.id, label: String(m.display_name || m.id).replace(/^Claude\s+/, '') }))
  if (!models.length) throw new Error('Models API não devolveu nenhum modelo')

  cache = { fetchedAt: new Date().toISOString(), models }
  writeJson(MODELS_FILE, cache)
  return modelsCatalog()
}

// Aceita id oficial ou apelido legado; devolve sempre o id oficial.
// Valor vazio => null (herda o default). Valor desconhecido => null.
//
// Reconhece ids do fallback mesmo depois de um refresh: se a Anthropic aposentar
// um modelo, uma task antiga que ainda o referencia não vira null em silêncio.
export function normalizeModel(value) {
  const v = String(value ?? '').trim()
  if (!v) return null
  const models = listModels()
  if (models.some(m => m.id === v) || FALLBACK_MODELS.some(m => m.id === v)) return v
  if (ALIASES.includes(v)) return models.find(m => m.id.startsWith(`claude-${v}-`))?.id || null
  return null
}

// só para testes: descarta o catálogo carregado do disco
export function _resetModelsCache() { cache = undefined }
