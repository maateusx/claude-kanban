// Catálogo de modelos da UI. Espelha server/src/lib/models.js: o `id` é o slug
// exato mandado para `claude --model`.
//
// A lista embutida é só o fallback (servidor fora do ar / sem credencial); o
// catálogo real vem de GET /api/models — que devolve o que a Models API da
// Anthropic retornou no último "atualizar modelos".
//
// MODELS é mutado no lugar em vez de trocado por outro array porque três telas
// o importam direto; assim o refresh não precisa ser passado por props.
export const MODELS = [
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

export function setModels(list) {
  if (!Array.isArray(list) || !list.length) return MODELS
  MODELS.splice(0, MODELS.length, ...list.map(m => ({ id: m.id, label: m.label || m.id })))
  return MODELS
}

// O que aparece no chip/select: o slug exato, com o nome amigável só como apoio.
export function modelLabel(id) {
  const hit = MODELS.find(m => m.id === id)
  return hit ? `${hit.id} (${hit.label})` : id
}
