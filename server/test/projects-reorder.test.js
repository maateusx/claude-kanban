import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-home-'))
const { buildApp } = await import('../src/app.js')

const runner = { getQueueView: () => ({ actives: [], queue: [] }), dropProject: () => {}, readLog: () => [] }
const devServers = { isRunning: () => false, stop: () => false, status: () => ({}), logs: () => [] }
const db = { projects: [] }
let app
before(async () => { app = await buildApp({ db, runner, devServers, emit: () => {} }); await app.ready() })
after(() => app.close())

const ids = res => res.json().projects.map(p => p.id)

test('POST /api/projects/reorder reordena e persiste; ids faltantes/desconhecidos não quebram', async () => {
  for (const name of ['a', 'b', 'c']) {
    const root = mkdtempSync(path.join(tmpdir(), 'ck-proj-'))
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name, path: root } })
  }
  const [a, b, c] = db.projects.map(p => p.id)

  let res = await app.inject({ method: 'POST', url: '/api/projects/reorder', payload: { projectIds: [c, a, b] } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(ids(res), [c, a, b])
  assert.deepEqual(ids(await app.inject({ method: 'GET', url: '/api/projects' })), [c, a, b])

  const saved = JSON.parse(readFileSync(path.join(process.env.CLAUDE_KANBAN_HOME, 'projects.json'), 'utf8'))
  assert.deepEqual(saved.projects.map(p => p.id), [c, a, b], 'ordem vai para o projects.json')

  // parcial + desconhecido: o que veio vai primeiro, o resto mantém a ordem relativa
  res = await app.inject({ method: 'POST', url: '/api/projects/reorder', payload: { projectIds: [b, 'nope', b] } })
  assert.deepEqual(ids(res), [b, c, a])

  res = await app.inject({ method: 'POST', url: '/api/projects/reorder', payload: { projectIds: 'x' } })
  assert.equal(res.statusCode, 400)
})
