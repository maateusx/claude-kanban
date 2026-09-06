import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// paths.js lê a env no load — tem que vir antes do import do app.
process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-ss-home-'))

const { buildApp } = await import('../src/app.js')
const { PROJECTS_FILE } = await import('../src/lib/paths.js')

const runner = { getQueueView: () => ({ actives: [], queue: [] }), dropProject: () => {}, readLog: () => [] }
const devServers = { isRunning: () => false, stop: () => false, status: () => ({}), logs: () => [] }

const db = { projects: [] }
let app, project

before(async () => {
  app = await buildApp({ db, runner, devServers, emit: () => {} })
  await app.ready()
  const res = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'demo', path: mkdtempSync(path.join(tmpdir(), 'ck-ss-proj-')) },
  })
  project = res.json().project
})
after(() => app.close())

const base = () => `/api/projects/${project.id}/search-sources`

test('criar, listar, editar e remover uma search source', async () => {
  const created = await app.inject({
    method: 'POST', url: base(),
    payload: {
      name: 'Linear', method: 'post', url: 'https://api.linear.app/graphql',
      headers: [{ key: 'Authorization', value: 'Bearer x' }, { key: '  ', value: 'lixo' }],
      queryParams: [{ key: 'team', value: 'core' }],
      body: '{"query":"..."}', bodyType: 'json',
    },
  })
  assert.equal(created.statusCode, 200)
  const source = created.json().source
  assert.equal(source.method, 'POST', 'method é normalizado para maiúsculo')
  assert.equal(source.enabled, true)
  assert.deepEqual(source.headers, [{ key: 'Authorization', value: 'Bearer x' }], 'par sem chave é descartado')
  assert.deepEqual(created.json().project.searchSources.map(s => s.id), [source.id])

  const listed = await app.inject({ method: 'GET', url: base() })
  assert.deepEqual(listed.json().searchSources.map(s => s.name), ['Linear'])

  // persistiu em ~/.claude-kanban/projects.json (apontado para temp pela env)
  const saved = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
  assert.deepEqual(saved.projects.find(p => p.id === project.id).searchSources.map(s => s.name), ['Linear'])

  const patched = await app.inject({
    method: 'PATCH', url: `${base()}/${source.id}`,
    payload: { name: 'Linear (core)', enabled: false },
  })
  assert.equal(patched.statusCode, 200)
  assert.equal(patched.json().source.name, 'Linear (core)')
  assert.equal(patched.json().source.enabled, false)
  assert.equal(patched.json().source.url, source.url, 'PATCH parcial preserva o resto')

  const removed = await app.inject({ method: 'DELETE', url: `${base()}/${source.id}` })
  assert.equal(removed.statusCode, 200)
  assert.deepEqual(removed.json().project.searchSources, [])
  assert.equal((await app.inject({ method: 'DELETE', url: `${base()}/${source.id}` })).statusCode, 404)
})

test('validação: method fora do enum, url inválida, name vazio, bodyType inválido', async () => {
  const post = payload => app.inject({ method: 'POST', url: base(), payload })
  const ok = { name: 'x', method: 'GET', url: 'https://ex.com' }

  assert.equal((await post({ ...ok, method: 'HEAD' })).statusCode, 400)
  assert.equal((await post({ ...ok, url: 'nao-e-url' })).statusCode, 400)
  assert.equal((await post({ ...ok, url: 'file:///etc/passwd' })).statusCode, 400)
  assert.equal((await post({ ...ok, name: '  ' })).statusCode, 400)
  assert.equal((await post({ ...ok, bodyType: 'xml' })).statusCode, 400)
  assert.match((await post({ ...ok, method: 'HEAD' })).json().error, /method deve ser um de/)

  assert.equal((await post(ok)).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/naoexiste/search-sources' })).statusCode, 404)
})
