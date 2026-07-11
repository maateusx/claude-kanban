// Catálogo de modelos oferecidos na UI. O `id` é exatamente o que vai para
// `claude --model`, então precisa ser o slug oficial do modelo — não o apelido
// ("opus", "sonnet") que resolve para "o mais recente da família" e muda com o
// tempo. `aliases` existe só para migrar tasks antigas gravadas com o apelido.
export const MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5', aliases: ['fable'] },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', aliases: ['opus'] },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', aliases: ['sonnet'] },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', aliases: ['haiku'] },
]

export const MODEL_IDS = MODELS.map(m => m.id)

// Aceita id oficial ou apelido legado; devolve sempre o id oficial.
// Valor vazio => null (herda o default). Valor desconhecido => null.
export function normalizeModel(value) {
  const v = String(value ?? '').trim()
  if (!v) return null
  const hit = MODELS.find(m => m.id === v || m.aliases.includes(v))
  return hit ? hit.id : null
}
