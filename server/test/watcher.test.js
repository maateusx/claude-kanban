import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, renameSync, unlinkSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTask, updateTask, selfWrites } from '../src/lib/tasks.js'
import { bootstrapProject } from '../src/lib/bootstrap.js'
import { tasksDir } from '../src/lib/paths.js'
import { watchProject } from '../src/lib/watcher.js'

process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-home-'))

// awaitWriteFinish (300ms) + a janela de 1s do unlink: tudo aqui é assíncrono,
// então esperamos por condição (polling), nunca por sleep de duração fixa.
const WAIT_MS = 20000

// Em modo nativo (fs.watch), o macOS derruba eventos quando vários processos de teste
// observam diretórios ao mesmo tempo — a suíte roda os arquivos em paralelo. Polling
// entrega todos os eventos, então o teste exercita a lógica do watcher e não a
// (in)confiabilidade do FS. A produção segue no default nativo.
const POLLING = { usePolling: true, interval: 30, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 } }

function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'ck-watch-'))
  bootstrapProject(root)
  return root
}

// Liga o watcher depois de montada a fixture. O registro de self-writes é limpo aqui:
// o createTask da fixture marcaria os arquivos por 2s e o watcher ignoraria as
// alterações "humanas" que o teste faz em seguida.
async function start(root) {
  const events = []
  selfWrites.clear()
  const watcher = watchProject({ id: 'p1', path: root }, (type, payload) => events.push({ type, ...payload }), POLLING)
  await new Promise(resolve => watcher.on('ready', resolve))

  // No macOS o 'ready' do chokidar dispara antes de o stream do fsevents estar de
  // fato entregando: um evento logo depois dele se perde de vez (e nenhum polling
  // salva). Escrevemos um arquivo-sentinela e só liberamos o teste quando o evento
  // dele chega — aí o stream está comprovadamente vivo. Depois zeramos os eventos.
  const sentinela = path.join(tasksDir(root, 'backlog'), 'sentinela.md')
  writeFileSync(sentinela, '## Descrição\n\nsentinela\n')
  await waitFor(() => find(events, 'task.upserted', e => e.task.fileName === 'sentinela.md'))
  events.length = 0

  return { events, watcher }
}

function waitFor(fn, timeout = WAIT_MS) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const v = fn()
      if (v) return resolve(v)
      if (Date.now() - started > timeout) return reject(new Error('timeout esperando evento'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

const find = (events, type, pred = () => true) => events.find(e => e.type === type && pred(e))

test('move manual de todo/ para doing/ emite task.moved com from e to', async () => {
  const root = project()
  const t = createTask(root, { title: 'Mover na mao', status: 'todo' })
  const { events, watcher } = await start(root)
  try {
    const dest = path.join(tasksDir(root, 'doing'), path.basename(t.filePath))
    renameSync(t.filePath, dest)

    const moved = await waitFor(() => find(events, 'task.moved', e => e.taskId === t.id))
    assert.equal(moved.from, 'todo')
    assert.equal(moved.to, 'doing')
    assert.ok(find(events, 'task.upserted', e => e.task.id === t.id && e.task.status === 'doing'))
    assert.ok(!find(events, 'task.removed'), 'move não pode virar remoção')
  } finally { await watcher.close() }
})

test('escrita do proprio backend (updateTask) nao emite eventos', async () => {
  const root = project()
  const t = createTask(root, { title: 'Self write', status: 'todo' })
  const { events, watcher } = await start(root)
  try {
    updateTask(root, t.id, { status: 'doing', title: 'Self write renomeado' })

    // Marco de sincronia: um arquivo cru escrito à mão DEPOIS do updateTask. Quando
    // o evento dele chegar, os do updateTask (anteriores) já teriam chegado também.
    const marco = path.join(tasksDir(root, 'backlog'), 'marco.md')
    writeFileSync(marco, '## Descrição\n\nmarco\n')
    await waitFor(() => find(events, 'task.upserted', e => e.task.fileName === 'marco.md'))

    assert.ok(!find(events, 'task.upserted', e => e.task.id === t.id), 'self-write não pode emitir upserted')
    assert.ok(!find(events, 'task.moved'))
    assert.ok(!find(events, 'task.removed'))
  } finally { await watcher.close() }
})

test('delete de verdade emite task.removed apos a janela do unlink', async () => {
  const root = project()
  const t = createTask(root, { title: 'Apagar', status: 'todo' })
  const { events, watcher } = await start(root)
  try {
    unlinkSync(t.filePath)

    const removed = await waitFor(() => find(events, 'task.removed'))
    assert.equal(removed.taskId, t.id)
    assert.ok(!find(events, 'task.moved'))
  } finally { await watcher.close() }
})

test('rename fora de ordem (add antes do unlink) nao vira task.removed', async () => {
  const root = project()
  const t = createTask(root, { title: 'Fora de ordem', status: 'todo' })
  const { events, watcher } = await start(root)
  try {
    const dest = path.join(tasksDir(root, 'doing'), path.basename(t.filePath))
    // copy + unlink: o watcher vê o `add` do destino antes do `unlink` da origem.
    copyFileSync(t.filePath, dest)
    await waitFor(() => find(events, 'task.upserted', e => e.task.id === t.id && e.task.status === 'doing'))
    unlinkSync(t.filePath)

    // A janela de 1s expira e o watcher confirma no disco que a task continua viva.
    await waitFor(() => events.filter(e => e.type === 'task.upserted' && e.task.id === t.id).length >= 2)
    assert.ok(!find(events, 'task.removed'), 'a task ainda existe em doing/, não pode ser removida')
  } finally { await watcher.close() }
})

test('arquivo cru em backlog/ e adotado e emite task.upserted com id gerado', async () => {
  const root = project()
  const { events, watcher } = await start(root)
  try {
    const f = path.join(tasksDir(root, 'backlog'), 'ideia-crua.md')
    writeFileSync(f, '## Descrição\n\nUma ideia sem frontmatter.\n')

    const up = await waitFor(() => find(events, 'task.upserted', e => e.task.fileName === 'ideia-crua.md'))
    assert.match(up.task.id, /^\w{6}$/)
    assert.equal(up.task.status, 'backlog')
    assert.ok(up.task.title.length > 0)
    assert.ok(!find(events, 'task.removed'))
  } finally { await watcher.close() }
})
