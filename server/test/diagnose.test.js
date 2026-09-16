// Diagnóstico automático: esgotadas as tentativas, a causa decide o que
// acontece com a task em vez de blocked direto (sessão mockada).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-dx-home-'))

// claude falso: devolve FAKE_DIR/dx.json como diagnóstico e conta as chamadas.
const FAKE = fs.mkdtempSync(path.join(tmpdir(), 'ck-dx-fake-'))
process.env.FAKE_DIR = FAKE
fs.writeFileSync(path.join(FAKE, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), dir = process.env.FAKE_DIR
fs.appendFileSync(path.join(dir, 'calls.log'), 'x\\n')
const dx = fs.readFileSync(path.join(dir, 'dx.json'), 'utf8')
process.stdout.write(JSON.stringify({ result: dx, is_error: false, total_cost_usd: 0.25 }))
`, { mode: 0o755 })
process.env.PATH = `${FAKE}${path.delimiter}${process.env.PATH}`
const setDx = dx => fs.writeFileSync(path.join(FAKE, 'dx.json'), JSON.stringify(dx))
const calls = () => { try { return fs.readFileSync(path.join(FAKE, 'calls.log'), 'utf8').split('\n').length - 1 } catch { return 0 } }

const { createTask, findTask, updateTask, listTasks, getSection } = await import('../src/lib/tasks.js')
const { Runner, MAX_DIAGNOSES, AUTO_DECIDED_TAG } = await import('../src/lib/runner.js')
const { parseDiagnosis } = await import('../src/lib/diagnoser.js')
const { webhookEventsFor } = await import('../src/lib/webhook.js')
const { computeStats } = await import('../src/lib/stats.js')
const { applyAutopilot } = await import('../src/routes/projects.js')

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function setup(extra = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-dx-'))
  const project = {
    id: `dx${Math.random().toString(36).slice(2, 8)}`, path: root,
    retry: { maxAttempts: 1, backoffMinutes: 0 }, autopilot: { diagnose: { enabled: true } }, ...extra,
  }
  const task = createTask(root, { title: 'Falha', status: 'doing' })
  updateTask(root, task.id, { run: { attempts: 1, total_cost_usd: 1 } })
  const emitted = []
  const runner = new Runner(id => (id === project.id ? project : null), (type, p) => emitted.push({ type, ...p }))
  runner.tick = () => {}
  runner.queue = []
  // Falha na última tentativa e espera o diagnóstico que ela dispara.
  const fail = async () => {
    const a = {
      projectId: project.id, taskId: task.id, workspace: { cwd: root }, taskRelPath: 'x.md',
      result: {}, stderr: 'boom', logEvents: [], logBytes: 0, logStream: null,
    }
    runner.actives.set(task.id, a)
    runner.finish(a, 1)
    await runner.diagnosing.get(task.id)
    return findTask(root, task.id)
  }
  return { root, project, task, runner, emitted, fail }
}

test('desligado: blocked direto, sem sessão de diagnóstico', async () => {
  const { fail } = setup({ autopilot: {} })
  const before = calls()
  const t = await fail()
  assert.ok(t.tags.includes('blocked'))
  assert.equal(calls(), before)
})

test('ambiente: cria pré-requisito urgent e passa a depender dele', async () => {
  const { root, task, fail } = setup()
  setDx({ cause: 'ambiente', summary: 'falta o pnpm', task: { title: 'Instalar pnpm', description: 'x' } })
  const t = await fail()
  const pre = listTasks(root).find(x => x.title === 'Instalar pnpm')
  assert.equal(pre.priority, 'urgent')
  assert.equal(pre.status, 'todo')
  assert.deepEqual(t.depends_on, [pre.id])
  assert.equal(t.status, 'todo')
  assert.ok(!t.tags.includes('blocked'))
  assert.ok(t.tags.includes('diagnosticada:ambiente'))
  assert.equal(t.run.attempts, 0)
  assert.equal(t.run.diagnoses, 1)
  assert.equal(t.run.total_cost_usd, 1.25, 'custo do diagnóstico soma no total')
  assert.match(getSection(t.body, 'Log de erros'), /Diagnóstico automático \(1\/2\): \*\*ambiente\*\* — falta o pnpm/)
  assert.ok(pre.body.includes(task.id))
})

test('flaky: verify passa ao repetir → nova tentativa; falha de novo → task de quarentena', async () => {
  for (const [cmd, passes] of [['true', true], ['false', false]]) {
    const { root, task, fail } = setup({ verifyCommand: cmd })
    sh(root, 'init', '-q', '-b', 'main')
    sh(root, 'config', 'user.email', 't@t')
    sh(root, 'config', 'user.name', 't')
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
    sh(root, 'add', 'a.txt')
    sh(root, 'commit', '-q', '-m', 'init')
    sh(root, 'branch', `kanban/${task.id}`)
    updateTask(root, task.id, { run: { branch: `kanban/${task.id}` } })
    setDx({ cause: 'flaky', summary: 'teste intermitente' })
    const t = await fail()
    assert.ok(!t.tags.includes('blocked'), cmd)
    const fix = listTasks(root).find(x => x.tags.includes('flaky'))
    if (passes) {
      assert.equal(fix, undefined)
      assert.deepEqual(t.depends_on, [])
    } else {
      assert.equal(fix.priority, 'urgent')
      assert.deepEqual(t.depends_on, [fix.id])
    }
  }
})

test('spec_ambigua: resposta de auto-decisão pela spec e volta para a fila', async () => {
  const { fail } = setup()
  setDx({ cause: 'spec_ambigua', summary: 'não diz qual formato' })
  const t = await fail()
  assert.ok(t.tags.includes(AUTO_DECIDED_TAG))
  assert.ok(!t.tags.includes('blocked'))
  assert.match(getSection(t.body, 'Human Response'), /\[auto-decisão\][\s\S]*ADR[\s\S]*não diz qual formato/)
})

test('grande_demais: desmembra de novo mesmo no último nível', async () => {
  const { root, task, fail } = setup()
  updateTask(root, task.id, { tags: ['subtask', 'nivel:2'], decompose: false })
  setDx({ cause: 'grande_demais', summary: 'parou no meio' })
  const t = await fail()
  assert.equal(t.decompose, true)
  assert.ok(!t.tags.includes('blocked'))
})

test('falta_dependencia: encadeia na task que entrega; id desconhecido sem task fica blocked', async () => {
  const { root, fail } = setup()
  const dep = createTask(root, { title: 'API de usuários', status: 'todo' })
  setDx({ cause: 'falta_dependencia', summary: 'precisa da API', dependsOn: dep.id })
  const t = await fail()
  assert.deepEqual(t.depends_on, [dep.id])
  assert.ok(!t.tags.includes('blocked'))

  const other = setup()
  setDx({ cause: 'falta_dependencia', summary: '?', dependsOn: 'naoexiste' })
  const t2 = await other.fail()
  assert.ok(t2.tags.includes('blocked'))
  assert.equal(listTasks(other.root).length, 1)
})

test('externo: continua blocked e avisa por webhook', async () => {
  const { task, fail, emitted } = setup()
  setDx({ cause: 'externo', summary: 'precisa de token da Stripe' })
  const t = await fail()
  assert.ok(t.tags.includes('blocked'))
  assert.ok(t.tags.includes('diagnosticada:externo'))
  const att = emitted.find(e => e.type === 'task.attention')
  assert.equal(att.taskId, task.id)
  assert.deepEqual(webhookEventsFor(att), [{ event: 'task_needs_human', taskId: task.id, reason: 'externo: precisa de token da Stripe' }])
})

test(`teto de ${MAX_DIAGNOSES} diagnósticos por task e métricas por causa`, async () => {
  const { root, task, fail } = setup()
  setDx({ cause: 'grande_demais', summary: 's' })
  for (let i = 0; i < MAX_DIAGNOSES; i++) {
    updateTask(root, task.id, { status: 'doing', run: { attempts: 1 } })
    assert.ok(!(await fail()).tags.includes('blocked'))
  }
  updateTask(root, task.id, { status: 'doing', run: { attempts: 1 } })
  const before = calls()
  const t = await fail()
  assert.ok(t.tags.includes('blocked'))
  assert.equal(calls(), before, 'não diagnostica além do teto')
  const stats = computeStats(listTasks(root), { days: 0 })
  assert.deepEqual(stats.autonomy.byDiagnosis, [{ cause: 'grande_demais', n: 1 }])
})

test('parseDiagnosis e config', () => {
  assert.throws(() => parseDiagnosis('{"cause":"outra"}'), /causa desconhecida/)
  assert.deepEqual(parseDiagnosis('ok: {"cause":"flaky","summary":" x "}'),
    { cause: 'flaky', summary: 'x', dependsOn: null, task: null })
  const p = {}
  assert.equal(applyAutopilot(p, { diagnose: { enabled: 1 } }), null)
  assert.deepEqual(p.autopilot.diagnose, { enabled: true })
})
