import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// paths.js lê a env no load — tem que vir antes do import do app.
process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-sf-home-'))

const { buildApp } = await import('../src/app.js')

const runner = { getQueueView: () => ({ actives: [], queue: [] }), dropProject: () => {}, readLog: () => [] }
const devServers = { isRunning: () => false, stop: () => false, status: () => ({}), logs: () => [] }

const db = { projects: [] }
let app, project
const realFetch = global.fetch

// Cada teste registra o que `fetch` deve responder; guardamos as chamadas para
// conferir url/headers/body montados a partir da source.
let calls = []
const mockFetch = handler => {
  global.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init) }
}
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

before(async () => {
  app = await buildApp({ db, runner, devServers, emit: () => {} })
  await app.ready()
  const res = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'demo', path: mkdtempSync(path.join(tmpdir(), 'ck-sf-proj-')) },
  })
  project = res.json().project
})
after(() => { global.fetch = realFetch; app.close() })
afterEach(() => { calls = [] })

const base = () => `/api/projects/${project.id}/search-sources`

const addSource = async payload => {
  const res = await app.inject({ method: 'POST', url: base(), payload })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().source
}

test('fetch com sucesso: monta a request e mapeia os itens', async () => {
  const source = await addSource({
    name: 'API', method: 'POST', url: 'https://ex.com/search',
    headers: [{ key: 'Authorization', value: 'Bearer x' }],
    queryParams: [{ key: 'q', value: 'bug' }],
    body: '{"page":1}', bodyType: 'json',
    resultsPath: 'data.items', titleField: 'fields.summary', descriptionField: 'fields.desc',
  })
  mockFetch(() => jsonRes({
    data: { items: [
      { fields: { summary: 'Item A', desc: 'corpo A' }, url: 'https://ex.com/a' },
      { fields: { summary: 'Item B', desc: 'corpo B' }, html_url: 'https://ex.com/b' },
      { fields: { desc: 'sem título' } },
    ] },
  }))

  const res = await app.inject({ method: 'POST', url: `${base()}/${source.id}/fetch` })
  assert.equal(res.statusCode, 200)
  const { items } = res.json()

  assert.equal(calls.length, 1)
  assert.equal(String(calls[0].url), 'https://ex.com/search?q=bug', 'queryParams entram na url')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer x')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(calls[0].init.body, '{"page":1}')

  assert.deepEqual(items.map(i => i.title), ['Item A', 'Item B'], 'item sem título é descartado')
  assert.deepEqual(items.map(i => i.description), ['corpo A', 'corpo B'])
  assert.deepEqual(items.map(i => i.url), ['https://ex.com/a', 'https://ex.com/b'], 'html_url é fallback de url')
  assert.equal(items.every(i => i.tag.startsWith(`search:${source.id}:`)), true)
  assert.equal(items.every(i => i.already_imported === false), true)
  assert.notEqual(items[0].tag, items[1].tag)
})

test('erro de rede e HTTP viram 502 com mensagem', async () => {
  const source = await addSource({ name: 'Frágil', url: 'https://ex.com/x' })

  mockFetch(() => { throw new TypeError('fetch failed') })
  const net = await app.inject({ method: 'POST', url: `${base()}/${source.id}/fetch` })
  assert.equal(net.statusCode, 502)
  assert.match(net.json().error, /falha ao buscar ex\.com/)

  mockFetch(() => jsonRes({}, 500))
  const http = await app.inject({ method: 'POST', url: `${base()}/${source.id}/fetch` })
  assert.equal(http.statusCode, 502)
  assert.match(http.json().error, /HTTP 500/)

  mockFetch(() => jsonRes({ nada: true }))
  const shape = await app.inject({ method: 'POST', url: `${base()}/${source.id}/fetch` })
  assert.equal(shape.statusCode, 502)
  assert.match(shape.json().error, /não é um array/)

  assert.equal((await app.inject({ method: 'POST', url: `${base()}/naoexiste/fetch` })).statusCode, 404)
})

test('import cria as tasks com a tag e o refetch marca already_imported', async () => {
  const source = await addSource({ name: 'Fonte', url: 'https://ex.com/list' })
  const payload = [
    { title: 'Corrigir login', description: 'quebra no safari', url: 'https://ex.com/1' },
    { title: 'Melhorar cache', description: 'ttl fixo', url: 'https://ex.com/2' },
  ]
  mockFetch(() => jsonRes(payload))

  const found = (await app.inject({ method: 'POST', url: `${base()}/${source.id}/fetch` })).json().items
  assert.equal(found.length, 2)

  const imported = await app.inject({
    method: 'POST', url: `${base()}/import`,
    payload: { items: found.slice(0, 1), priority: 'high', status: 'todo' },
  })
  assert.equal(imported.statusCode, 200)
  const { created, skipped } = imported.json()
  assert.equal(skipped.length, 0)
  assert.equal(created.length, 1)
  assert.equal(created[0].title, 'Corrigir login')
  assert.equal(created[0].status, 'todo')
  assert.equal(created[0].priority, 'high')
  assert.deepEqual(created[0].tags, ['search', found[0].tag])
  assert.match(created[0].body, /quebra no safari/)
  assert.match(created[0].body, /https:\/\/ex\.com\/1/)

  // Nova busca: o item já importado vem marcado, o outro não.
  const again = (await app.inject({ method: 'POST', url: `${base()}/${source.id}/fetch` })).json().items
  assert.deepEqual(again.map(i => i.already_imported), [true, false])

  // E reimportar o mesmo item não cria task nova.
  const dupe = await app.inject({ method: 'POST', url: `${base()}/import`, payload: { items: found } })
  assert.equal(dupe.json().created.length, 1, 'só o item ainda não importado vira task')
  assert.deepEqual(dupe.json().skipped.map(s => s.reason), ['já importada'])

  assert.equal((await app.inject({ method: 'POST', url: `${base()}/import`, payload: { items: [] } })).statusCode, 400)
})

test('fetch-all busca só as habilitadas e isola erro por fonte', async () => {
  const db2 = { projects: [] }
  const app2 = await buildApp({ db: db2, runner, devServers, emit: () => {} })
  await app2.ready()
  const proj = (await app2.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'all', path: mkdtempSync(path.join(tmpdir(), 'ck-sf-all-')) },
  })).json().project
  const url = `/api/projects/${proj.id}/search-sources`
  const add = async p => (await app2.inject({ method: 'POST', url, payload: p })).json().source

  const ok = await add({ name: 'ok', url: 'https://ok.com/l' })
  const bad = await add({ name: 'bad', url: 'https://bad.com/l' })
  await add({ name: 'off', url: 'https://off.com/l', enabled: false })

  mockFetch(u => (String(u).includes('ok.com')
    ? jsonRes([{ title: 'da ok' }])
    : jsonRes({}, 404)))

  const res = await app2.inject({ method: 'POST', url: `${url}/fetch-all` })
  assert.equal(res.statusCode, 200)
  const { items, errors } = res.json()
  assert.equal(calls.length, 2, 'fonte desabilitada não é buscada')
  assert.deepEqual(items.map(i => i.title), ['da ok'])
  assert.equal(items[0].sourceId, ok.id)
  assert.deepEqual(errors.map(e => e.sourceId), [bad.id])
  assert.match(errors[0].error, /HTTP 404/)
  await app2.close()
})
