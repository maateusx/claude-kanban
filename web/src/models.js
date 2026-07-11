// Espelho de server/src/lib/models.js — o `id` é o slug exato mandado para
// `claude --model`. Mantenha os dois arquivos em sincronia.
export const MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

// O que aparece no chip/select: o slug exato, com o nome amigável só como apoio.
export function modelLabel(id) {
  const hit = MODELS.find(m => m.id === id)
  return hit ? `${hit.id} (${hit.label})` : id
}
