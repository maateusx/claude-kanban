import { nanoid } from 'nanoid'

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
export const BODY_TYPES = ['json', 'text', 'form']

export const listSearchSources = p => (Array.isArray(p?.searchSources) ? p.searchSources : [])

const isHttpUrl = u => {
  try { return ['http:', 'https:'].includes(new URL(u).protocol) } catch { return false }
}

// headers/queryParams são listas chave-valor (a UI edita como tabela); pares sem
// chave são lixo de linha em branco do formulário e caem fora.
const pairs = v => (Array.isArray(v) ? v : [])
  .map(x => ({ key: String(x?.key ?? '').trim(), value: String(x?.value ?? '') }))
  .filter(x => x.key)

// Aplica só os campos presentes em `input` sobre `base` (null = criar do zero) e
// valida o resultado inteiro. Lança Error com mensagem pronta para virar 400.
export function normalizeSource(input = {}, base = null) {
  const s = base ? { ...base } : {
    id: nanoid(6),
    name: '', method: 'GET', url: '',
    headers: [], queryParams: [], body: '', bodyType: 'json', enabled: true,
    resultsPath: '', titleField: '', descriptionField: '',
  }
  if (input.name !== undefined) s.name = String(input.name || '').trim()
  if (input.method !== undefined) s.method = String(input.method || '').toUpperCase()
  if (input.url !== undefined) s.url = String(input.url || '').trim()
  if (input.headers !== undefined) s.headers = pairs(input.headers)
  if (input.queryParams !== undefined) s.queryParams = pairs(input.queryParams)
  if (input.body !== undefined) s.body = String(input.body ?? '')
  if (input.bodyType !== undefined) s.bodyType = String(input.bodyType || '').toLowerCase()
  if (input.enabled !== undefined) s.enabled = !!input.enabled
  // Mapeamento da resposta JSON (ver searchFetch.js): caminhos com ponto, opcionais.
  for (const k of ['resultsPath', 'titleField', 'descriptionField']) {
    if (input[k] !== undefined) s[k] = String(input[k] || '').trim()
  }

  if (!s.name) throw new Error('name é obrigatório')
  if (!METHODS.includes(s.method)) throw new Error(`method deve ser um de: ${METHODS.join(', ')}`)
  if (!BODY_TYPES.includes(s.bodyType)) throw new Error(`bodyType deve ser um de: ${BODY_TYPES.join(', ')}`)
  if (!isHttpUrl(s.url)) throw new Error('url deve ser uma URL http(s) válida')
  return s
}
