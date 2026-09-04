import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// HOME_DIR e o dir global do Claude são lidos do env — apontamos para temp ANTES
// de importar, senão o teste mexeria no ~/.claude e no ~/.claude-kanban de verdade.
process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-home-'))
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'ck-global-'))

const { listExtensions, installExtension, toggleExtension, removeExtension, globalRoot } =
  await import('../src/lib/extensions.js')

const proj = () => mkdtempSync(path.join(tmpdir(), 'ck-ext-'))
const find = (r, kind, name) => r.items[kind].find(i => i.name === name)

test('lista skills e agents do projeto com metadados do frontmatter', () => {
  const root = proj()
  mkdirSync(path.join(root, '.claude/skills/minha-skill'), { recursive: true })
  writeFileSync(path.join(root, '.claude/skills/minha-skill/SKILL.md'),
    '---\nname: minha-skill\ndescription: faz algo\n---\n\ncorpo')
  mkdirSync(path.join(root, '.claude/agents'), { recursive: true })
  writeFileSync(path.join(root, '.claude/agents/meu-agente.md'), '---\nname: meu-agente\ndescription: revisa\n---\n')

  const r = listExtensions(root)
  assert.equal(r.scope, 'project')
  assert.deepEqual(
    { ...find(r, 'skills', 'minha-skill'), path: undefined },
    { kind: 'skills', name: 'minha-skill', enabled: true, title: 'minha-skill', description: 'faz algo', path: undefined },
  )
  assert.equal(find(r, 'agents', 'meu-agente').description, 'revisa')
})

test('instalar do catálogo, desativar, reativar e remover uma skill', () => {
  const root = proj()
  installExtension('skill:commits-convencionais', root)
  const file = path.join(root, '.claude/skills/commits-convencionais/SKILL.md')
  assert.ok(existsSync(file))
  assert.match(readFileSync(file, 'utf8'), /^---\nname: commits-convencionais/)

  let r = toggleExtension('skills', 'commits-convencionais', false, root)
  assert.equal(find(r, 'skills', 'commits-convencionais').enabled, false)
  assert.ok(!existsSync(file), 'desativada sai da pasta que o Claude varre')
  assert.ok(existsSync(path.join(root, '.claude/skills-disabled/commits-convencionais/SKILL.md')))

  r = toggleExtension('skills', 'commits-convencionais', true, root)
  assert.equal(find(r, 'skills', 'commits-convencionais').enabled, true)
  assert.ok(existsSync(file))

  r = removeExtension('skills', 'commits-convencionais', root)
  assert.equal(find(r, 'skills', 'commits-convencionais'), undefined)
  assert.ok(!existsSync(file))
})

test('hook do catálogo entra em settings.json e volta inteiro depois de desativar', () => {
  const root = proj()
  const settings = path.join(root, '.claude/settings.json')
  mkdirSync(path.join(root, '.claude'), { recursive: true })
  writeFileSync(settings, JSON.stringify({ theme: 'dark' }))

  installExtension('hook:avisar-ao-terminar', root)
  let s = JSON.parse(readFileSync(settings, 'utf8'))
  assert.equal(s.theme, 'dark', 'não pode atropelar o resto do settings.json')
  assert.equal(s.hooks.Stop.length, 1)

  let r = listExtensions(root)
  assert.equal(r.items.hooks.length, 1)
  const hook = r.items.hooks[0]
  assert.equal(hook.enabled, true)
  assert.equal(hook.event, 'Stop')

  r = toggleExtension('hooks', hook.name, false, root)
  s = JSON.parse(readFileSync(settings, 'utf8'))
  assert.equal(s.hooks?.Stop, undefined, 'evento vazio some do settings.json')
  assert.deepEqual(r.items.hooks.map(h => [h.name, h.enabled]), [[hook.name, false]])

  r = toggleExtension('hooks', hook.name, true, root)
  s = JSON.parse(readFileSync(settings, 'utf8'))
  assert.equal(s.hooks.Stop.length, 1)
  assert.deepEqual(r.items.hooks.map(h => [h.name, h.enabled]), [[hook.name, true]])

  r = removeExtension('hooks', hook.name, root)
  assert.deepEqual(r.items.hooks, [])
})

test('dois hooks no mesmo evento têm ids distintos e desativam separado', () => {
  const root = proj()
  mkdirSync(path.join(root, '.claude'), { recursive: true })
  writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'b' }] },
      ],
    },
  }))
  const hooks = listExtensions(root).items.hooks
  assert.equal(new Set(hooks.map(h => h.name)).size, 2)

  const alvo = hooks.find(h => h.description === 'b')
  toggleExtension('hooks', alvo.name, false, root)
  const rest = JSON.parse(readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).hooks.PreToolUse
  assert.deepEqual(rest.map(e => e.hooks[0].command), ['a'])
})

test('nome com path traversal é rejeitado', () => {
  const root = proj()
  for (const nome of ['../evil', 'a/b', '..', '']) {
    assert.throws(() => toggleExtension('skills', nome, false, root), /nome inválido/)
    assert.throws(() => removeExtension('agents', nome, root), /nome inválido/)
  }
  assert.throws(() => toggleExtension('outros', 'x', false, root), /tipo inválido/)
})

test('escopo global usa o dir do Claude, não o do projeto', () => {
  installExtension('agent:revisor', null)
  assert.ok(existsSync(path.join(globalRoot(), 'agents/revisor.md')))
  const r = listExtensions(null)
  assert.equal(r.scope, 'global')
  assert.equal(find(r, 'agents', 'revisor').enabled, true)
  removeExtension('agents', 'revisor', null)
  assert.ok(!existsSync(path.join(globalRoot(), 'agents/revisor.md')))
})

/* ------------------------------------------------------------ rotas */

const { buildApp } = await import('../src/app.js')

const db = { projects: [] }
const app = await buildApp({
  db,
  runner: { getQueueView: () => ({ actives: [], queue: [] }), dropProject: () => {}, readLog: () => [] },
  devServers: { isRunning: () => false, stop: () => false, status: () => ({}), logs: () => [] },
  emit: () => {},
})
await app.ready()
test.after(() => app.close())

test('rotas: instalar no projeto vs global e projeto inexistente', async () => {
  const root = proj()
  db.projects.push({ id: 'p1', name: 'demo', path: root })

  const inst = await app.inject({ method: 'POST', url: '/api/extensions/install', payload: { projectId: 'p1', id: 'skill:testes-primeiro' } })
  assert.equal(inst.statusCode, 200)
  assert.ok(existsSync(path.join(root, '.claude/skills/testes-primeiro/SKILL.md')))
  assert.ok(!existsSync(path.join(globalRoot(), 'skills/testes-primeiro')), 'escopo do projeto não vaza para o global')

  const list = await app.inject({ url: '/api/extensions?projectId=p1' })
  assert.equal(list.json().scope, 'project')
  assert.ok(list.json().catalog.length > 0)
  assert.ok(list.json().items.skills.some(s => s.name === 'testes-primeiro'))

  const global = await app.inject({ url: '/api/extensions' })
  assert.equal(global.json().scope, 'global')

  const naoExiste = await app.inject({ method: 'POST', url: '/api/extensions/toggle', payload: { projectId: 'zzz', kind: 'skills', name: 'x', enabled: false } })
  assert.equal(naoExiste.statusCode, 404)

  const invalido = await app.inject({ method: 'POST', url: '/api/extensions/remove', payload: { projectId: 'p1', kind: 'skills', name: '../fora' } })
  assert.equal(invalido.statusCode, 400)
})
