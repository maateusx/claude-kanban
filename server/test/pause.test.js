import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// HOME próprio: o state.json (onde a pausa global mora) é global do app.
process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-pause-home-'))

const { Runner } = await import('../src/lib/runner.js')
const { loadState } = await import('../src/lib/paths.js')

const past = () => new Date(Date.now() - 60_000).toISOString()
const future = () => new Date(Date.now() + 3600_000).toISOString()

const project = { id: 'p1', path: mkdtempSync(path.join(tmpdir(), 'ck-pause-')) }
const newRunner = () => new Runner(() => project, () => {})

test('pausa global impede o tick e não mexe nas ativas', () => {
  const runner = newRunner()
  const started = []
  runner.start = (pid, tid) => started.push(tid)

  runner.queue = [{ projectId: 'p1', taskId: 't1' }]
  runner.pause()

  assert.equal(runner.isPaused(), true)
  runner.tick()
  assert.deepEqual(started, [], 'nada sai da fila enquanto pausado')
  assert.equal(runner.queue.length, 1, 'os itens continuam na fila, na ordem')

  // Drenar: pausar não mata sessão — quem estava rodando segue rodando.
  runner.actives.set('ativa', { projectId: 'p1', taskId: 'ativa' })
  runner.pause()
  assert.equal(runner.actives.size, 1)

  runner.actives.clear()
  runner.resume()
  assert.equal(runner.isPaused(), false)
  assert.deepEqual(started, ['t1'], 'o resume destrava a fila')
})

test('pausa global sobrevive a restart e expira sozinha quando tem prazo', () => {
  const runner = newRunner()
  runner.pause(future())
  assert.equal(loadState().paused, true)

  // Restart: um Runner novo relê o state.json.
  const restarted = newRunner()
  assert.equal(restarted.isPaused(), true)
  assert.equal(restarted.getQueueView().pausedUntil, runner.pausedUntil)

  // Prazo vencido: o próprio check expira a pausa e persiste.
  restarted.pausedUntil = past()
  assert.equal(restarted.isPaused(), false)
  assert.equal(restarted.paused, false)
  assert.equal(loadState().paused, false)
})

test('pausa indefinida vai para a queueView sem pausedUntil', () => {
  const runner = newRunner()
  runner.pause()
  const view = runner.getQueueView()
  assert.equal(view.paused, true)
  assert.equal(view.pausedUntil, null)
  runner.resume()
  assert.equal(runner.getQueueView().paused, false)
})
