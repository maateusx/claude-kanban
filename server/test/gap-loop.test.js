// Loop de objetivo: objetivo integrado → auditoria da spec → lacunas viram
// tasks filhas, até não sobrar lacuna, estourar as rodadas ou o teto de custo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-gap-home-'))

// claude falso: devolve as lacunas de FAKE_DIR/gaps.json e registra o cwd.
const FAKE = fs.mkdtempSync(path.join(tmpdir(), 'ck-gap-fake-'))
process.env.FAKE_DIR = FAKE
fs.writeFileSync(path.join(FAKE, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), dir = process.env.FAKE_DIR
fs.appendFileSync(path.join(dir, 'cwd.log'), process.cwd() + '\\n')
const suggestions = JSON.parse(fs.readFileSync(path.join(dir, 'gaps.json'), 'utf8'))
process.stdout.write(JSON.stringify({ result: JSON.stringify({ suggestions }), is_error: false, total_cost_usd: 0.5 }))
`, { mode: 0o755 })
process.env.PATH = `${FAKE}${path.delimiter}${process.env.PATH}`
const setGaps = list => fs.writeFileSync(path.join(FAKE, 'gaps.json'), JSON.stringify(list))

const { createTask, findTask, listTasks, updateTask, getSection } = await import('../src/lib/tasks.js')
const { Autopilot, gapCandidates, GAP_TAG, SPEC_DONE_TAG } = await import('../src/lib/autopilot.js')
const { DECOMPOSED_TAG } = await import('../src/lib/runner.js')
const { applyAutopilot } = await import('../src/routes/projects.js')
const { webhookEventsFor } = await import('../src/lib/webhook.js')
const { markSucceeded, wasSucceeded } = await import('../src/lib/ledger.js')

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function setup(gapLoop = { enabled: true }, extra = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-gap-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 't@t')
  sh(root, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'init')
  const project = { id: `gp${Math.random().toString(36).slice(2, 8)}`, name: 'gp', path: root, autopilot: { gapLoop }, ...extra }
  const goal = createTask(root, { title: 'Objetivo', description: 'Critérios: X e Y', status: 'done', tags: [DECOMPOSED_TAG] })
  updateTask(root, goal.id, { run: { gap_pending: true, cost_usd: 1, total_cost_usd: 1 } })
  markSucceeded(goal.id, {})
  const emitted = []
  const ap = new Autopilot({
    db: { projects: [project] }, saveProjects: () => {},
    runner: { actives: new Map(), queue: [] }, emit: (type, p) => emitted.push({ type, ...p }),
  })
  return { root, project, goal, ap, emitted }
}

test('lacunas viram tasks filhas e o objetivo volta a esperar por elas', async () => {
  const { root, goal, ap, emitted } = setup()
  setGaps([
    { title: 'Falta Y', description: 'implementar Y', type: 'feature', priority: 'high' },
    { title: 'Teste de X', description: 'cobrir X', type: 'teste', priority: 'low' },
  ])
  await ap.tick()

  const kids = listTasks(root).filter(t => t.tags.includes(`pai:${goal.id}`))
  assert.deepEqual(kids.map(k => k.title).sort(), ['Falta Y', 'Teste de X'])
  for (const k of kids) {
    assert.ok(k.tags.includes(GAP_TAG))
    assert.equal(k.status, 'backlog', 'entra em importStatus')
  }
  const g = findTask(root, goal.id)
  assert.equal(g.status, 'todo')
  assert.deepEqual([...g.depends_on].sort(), kids.map(k => k.id).sort())
  assert.equal(g.run.gap_pending, false)
  assert.equal(g.run.gap_rounds, 1)
  assert.equal(g.run.total_cost_usd, 1.5, 'custo da auditoria conta no objetivo')
  assert.equal(wasSucceeded(goal.id), false, 'sai do ledger para poder rodar de novo')
  assert.match(getSection(g.body, 'Resultado'), /rodada 1 abriu 2 lacuna/)
  assert.ok(emitted.some(e => e.type === 'task.moved' && e.taskId === goal.id && e.to === 'todo'))

  // A auditoria rodou na branch do objetivo (worktree destacado), não no checkout.
  const cwd = fs.readFileSync(path.join(FAKE, 'cwd.log'), 'utf8').trim().split('\n').pop()
  assert.match(cwd, /worktrees\/_gaps\//)
  assert.ok(!fs.existsSync(cwd), 'worktree removido no fim')
  assert.deepEqual(gapCandidates(root), [], 'não audita de novo sem nova integração')
})

test('sem lacunas: objetivo ganha spec-cumprida e para', async () => {
  const { root, goal, ap, emitted } = setup()
  setGaps([])
  await ap.tick()
  const g = findTask(root, goal.id)
  assert.equal(g.status, 'done')
  assert.ok(g.tags.includes(SPEC_DONE_TAG))
  assert.equal(g.run.gap_pending, false)
  assert.equal(listTasks(root).length, 1)
  assert.ok(!emitted.some(e => e.type === 'goal.attention'))
})

test('teto de rodadas: não abre mais tasks e pede humano', async () => {
  const { root, goal, ap, emitted } = setup({ enabled: true, maxRounds: 2 })
  updateTask(root, goal.id, { run: { gap_rounds: 2 } })
  setGaps([{ title: 'Ainda falta Z', description: 'z', type: 'feature', priority: 'medium' }])
  await ap.tick()
  const g = findTask(root, goal.id)
  assert.equal(g.status, 'done')
  assert.equal(listTasks(root).length, 1)
  const att = emitted.find(e => e.type === 'goal.attention')
  assert.match(att.reason, /teto de 2 rodada.*Ainda falta Z/s)
  assert.deepEqual(webhookEventsFor(att), [{ event: 'goal_needs_human', taskId: goal.id, reason: att.reason }])
})

test('lacuna repetida não duplica task; teto de custo nem audita', async () => {
  const dup = setup()
  createTask(dup.root, { title: 'Falta Y', description: '', status: 'done', tags: [GAP_TAG, `pai:${dup.goal.id}`] })
  setGaps([{ title: 'falta y', description: '', type: 'feature', priority: 'medium' }])
  await dup.ap.tick()
  assert.equal(listTasks(dup.root).length, 2)
  assert.ok(dup.emitted.some(e => e.type === 'goal.attention'))

  const cap = setup({ enabled: true }, { goalBudgetUsd: 1 })
  fs.writeFileSync(path.join(FAKE, 'cwd.log'), '')
  await cap.ap.tick()
  assert.equal(fs.readFileSync(path.join(FAKE, 'cwd.log'), 'utf8'), '', 'claude não rodou')
  assert.match(cap.emitted.find(e => e.type === 'goal.attention').reason, /teto de custo/)
  assert.equal(findTask(cap.root, cap.goal.id).run.gap_pending, false)
})

test('desligado não audita; config validada', async () => {
  const { root, goal, ap } = setup({ enabled: false })
  await ap.tick()
  assert.equal(findTask(root, goal.id).run.gap_pending, true)

  const p = {}
  assert.equal(applyAutopilot(p, { gapLoop: { enabled: true, maxRounds: 5 } }), null)
  assert.deepEqual(p.autopilot.gapLoop, { enabled: true, maxRounds: 5 })
  assert.match(applyAutopilot(p, { gapLoop: { maxRounds: 0 } }), /maxRounds/)
})
