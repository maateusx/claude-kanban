import { createHash } from 'node:crypto'

const TIMEOUT_MS = 30_000
const MAX_ITEMS = 100

const CONTENT_TYPE = { json: 'application/json', text: 'text/plain', form: 'application/x-www-form-urlencoded' }

// Erro com `code` para a rota traduzir em status HTTP (mesmo contrato do github.js).
export class SearchFetchError extends Error {
  constructor(message, code) { super(message); this.code = code }
}

// Tag que amarra a task ao item de origem — é ela (e não o título) que garante o
// dedupe. O hash é de title+url porque é o par que identifica o item em qualquer
// API (id nem sempre existe, e quando existe já entra na url).
export const itemTag = (sourceId, item) =>
  `search:${sourceId}:${createHash('sha1').update(`${item.title}\n${item.url || ''}`).digest('hex').slice(0, 10)}`

// "data.items" desce no objeto; caminho vazio = o próprio objeto.
const dig = (obj, p) => (p
  ? String(p).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj)
  : obj)

const str = v => (typeof v === 'string' ? v : (v == null || typeof v === 'object' ? '' : String(v))).trim()

// Campo configurado no source vence; senão, tenta os nomes que quase toda API usa.
const field = (item, configured, fallbacks) => {
  const v = str(dig(item, configured))
  if (v) return v
  for (const f of fallbacks) { const x = str(item?.[f]); if (x) return x }
  return ''
}

function buildRequest(source) {
  let url
  try { url = new URL(source.url) } catch { throw new SearchFetchError(`url inválida: ${source.url}`, 'bad_url') }
  for (const { key, value } of source.queryParams || []) url.searchParams.append(key, value)

  const headers = Object.fromEntries((source.headers || []).map(h => [h.key, h.value]))
  const method = (source.method || 'GET').toUpperCase()
  const init = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) }
  if (source.body && method !== 'GET' && method !== 'DELETE') {
    init.body = source.body
    const ct = CONTENT_TYPE[source.bodyType] || CONTENT_TYPE.json
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = ct
  }
  return { url, init }
}

// Executa a request da fonte e devolve os candidatos já normalizados e tagueados.
// Assume resposta JSON: `resultsPath` navega até o array, `titleField`/`descriptionField`
// mapeiam cada item (ambos aceitam caminho com ponto).
export async function fetchSource(source) {
  const { url, init } = buildRequest(source)

  let res
  try {
    res = await fetch(url, init)
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? `timeout de ${TIMEOUT_MS / 1000}s` : (e?.message || 'falha de rede')
    throw new SearchFetchError(`falha ao buscar ${url.host}: ${reason}`, 'fetch_failed')
  }
  if (!res.ok) throw new SearchFetchError(`${url.host} respondeu HTTP ${res.status}`, 'http_error')

  let data
  try { data = await res.json() } catch { throw new SearchFetchError('resposta não é JSON válido', 'bad_json') }

  const arr = dig(data, source.resultsPath)
  if (!Array.isArray(arr)) {
    const where = source.resultsPath ? `resultsPath "${source.resultsPath}"` : 'a raiz da resposta'
    throw new SearchFetchError(`${where} não é um array de resultados`, 'bad_results')
  }

  return arr.slice(0, MAX_ITEMS).map(raw => {
    const item = {
      sourceId: source.id,
      sourceName: source.name,
      title: field(raw, source.titleField, ['title', 'name', 'subject']).slice(0, 200),
      description: field(raw, source.descriptionField, ['description', 'body', 'summary', 'content']),
      url: field(raw, null, ['url', 'html_url', 'link', 'permalink']),
    }
    return { ...item, tag: itemTag(source.id, item) }
  }).filter(i => i.title)
}

// Corpo da task importada: o que veio da fonte + a referência, para o Claude citar.
export function itemDescription(item) {
  const body = item.description || '_(item sem descrição)_'
  const ref = item.url ? `[${item.url}](${item.url})` : '_(sem link)_'
  return `${body}\n\nImportada da fonte de busca **${item.sourceName || item.sourceId}**: ${ref}`
}
