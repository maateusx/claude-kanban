import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { nanoid } from 'nanoid'
import {
  HOME_DIR, LOCK_FILE, loadProjects, saveProjects, diffFile,
} from './lib/paths.js'
import {
  listTasks, findTask, createTask, updateTask, reconcileProject,
} from './lib/tasks.js'
import { sortTasks } from './lib/sort.js'
import { bootstrapProject, bootstrapStatus, uninstallGuardrails } from './lib/bootstrap.js'
import { listPendingActions, resolvePendingAction } from './lib/pending.js'
import { listConfigFiles, readConfigFile, writeConfigFile } from './lib/claudeConfig.js'
import { watchProject } from './lib/watcher.js'
import { Runner } from './lib/runner.js'
import { analyzeProject, SUGGESTION_TYPES } from './lib/analyzer.js'
import { DevServers } from './lib/devservers.js'
import { DEFAULT_GIT, gitSettings, projectBranch, listBranches, checkoutBranch, fetchRemotes, isDirty } from './lib/git.js'
import { getUsage } from './lib/usage.js'
import { MODEL_IDS, normalizeModel } from './lib/models.js'
import { Scheduler, parseWhen, isFuture } from './lib/scheduler.js'

const PORT = Number(process.env.PORT || 4400)
const MIN_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 240 * 60_000

const invalidModelMsg = (v) => `modelo inválido: "${v}". Use um destes: ${MODEL_IDS.join(', ')}`

// ---- lockfile (única instância) ----
fs.mkdirSync(HOME_DIR, { recursive: true })
if (fs.existsSync(LOCK_FILE)) {
  const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'))
  let alive = false
  try { process.kill(pid, 0); alive = true } catch {}
  if (alive) {
    console.error(`Outra instância do claude-kanban está rodando (pid ${pid}). Abortando.`)
    process.exit(1)
  }
}
fs.writeFileSync(LOCK_FILE, String(process.pid))
// 'exit' é síncrono: timers não rodam, então matamos os grupos na marra.
const cleanup = () => { try { devServers?.killAll() } catch {}; try { fs.unlinkSync(LOCK_FILE) } catch {} }
process.on('exit', cleanup)
// Em sinais temos tempo: SIGTERM no grupo de cada dev server, pequena janela para
// eles encerrarem sozinhos, e o handler de 'exit' garante o SIGKILL do que sobrar.
const shutdown = () => {
  try { devServers?.stopAll() } catch {}
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ---- estado ----
const db = loadProjects()
const watchers = new Map()       // projectId -> chokidar watcher
const bootstrapErrors = new Map() // projectId -> msg
const sockets = new Set()

function emit(type, payload) {
  const msg = JSON.stringify({ type, ...payload })
  for (const ws of sockets) { try { ws.send(msg) } catch {} }
  maybeAutoRun(type, payload)
}

// Auto-executar: com o modo ligado, tudo que está (ou entra) em todo/ vai para a fila.
function autoEnqueue(project, excludeTaskId) {
  if (!project?.autoRun || !claudeAvailable || !fs.existsSync(project.path)) return
  // Task com horário marcado no futuro não entra na fila agora — quem a coloca
  // lá é o Scheduler, quando a hora chegar.
  const todo = listTasks(project.path).filter(t =>
    t.status === 'todo' && t.id !== excludeTaskId && !(t.tags || []).includes('blocked')
    && !isFuture(t.scheduled_at))
  // A ordem de entrada na fila é a mesma que o board mostra por default:
  // prioridade mais alta primeiro, empate pela mais antiga.
  for (const t of sortTasks(todo)) runner.enqueue(project.id, t.id, { auto: true })
}

function maybeAutoRun(type, payload) {
  const project = getProject(payload.projectId)
  if (!project?.autoRun) return
  if (type === 'run.finished') autoEnqueue(project)
  // task morta manualmente volta para todo, mas não re-entra sozinha na fila
  else if (type === 'run.killed') autoEnqueue(project, payload.taskId)
  else if (type === 'task.upserted' && payload.task?.status === 'todo') autoEnqueue(project)
  else if (type === 'task.moved' && payload.to === 'todo') autoEnqueue(project)
}

const getProject = id => db.projects.find(p => p.id === id) || null
const runner = new Runner(getProject, emit)
const devServers = new DevServers(emit)
const scheduler = new Scheduler({ db, saveProjects, runner, emit })

function projectView(p) {
  const available = fs.existsSync(p.path)
  return {
    ...p,
    git: gitSettings(p),
    available,
    bootstrap: bootstrapErrors.has(p.id) ? 'failed' : (available ? bootstrapStatus(p.path) : 'unknown'),
    bootstrapError: bootstrapErrors.get(p.id) || null,
    pendingCount: available ? listPendingActions(p.path).filter(a => a.status === 'pending').length : 0,
    devServerRunning: devServers.isRunning(p.id),
    branch: available ? projectBranch(p.path) : null,
  }
}

function startWatcher(project) {
  if (watchers.has(project.id) || !fs.existsSync(project.path)) return
  watchers.set(project.id, watchProject(project, emit))
}

// ---- boot ----
let claudeAvailable = true
try { execFileSync('claude', ['--version'], { stdio: 'ignore' }) } catch { claudeAvailable = false }

for (const p of db.projects) {
  if (!fs.existsSync(p.path)) continue
  try { reconcileProject(p.path) } catch {}
  startWatcher(p)
}
runner.recover(db.projects.filter(p => fs.existsSync(p.path)))
for (const p of db.projects) autoEnqueue(p)
// Depois do recover/autoEnqueue: o primeiro tick já solta o que venceu enquanto
// o servidor estava fora do ar.
scheduler.start()

// ---- app ----
const app = Fastify()
await app.register(cors, { origin: true })
await app.register(websocket)

app.get('/api/ws', { websocket: true }, socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

app.get('/api/health', () => ({ ok: true, claudeAvailable }))

// ---- usage/limites do plano Claude (sessão 5h + semanais) ----
app.get('/api/usage', () => getUsage())

// ---- folder picker (nativo) ----
app.post('/api/pick-folder', (req, reply) => {
  if (process.platform !== 'darwin') {
    return reply.code(501).send({ error: 'seletor de pasta disponível apenas no macOS' })
  }
  try {
    const out = execFileSync('osascript', [
      '-e', 'POSIX path of (choose folder with prompt "Selecione a pasta do projeto")',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return { path: out }
  } catch {
    // usuário cancelou a caixa de diálogo
    return { path: null }
  }
})

// ---- projects ----
app.get('/api/projects', () => ({ projects: db.projects.map(projectView) }))

app.post('/api/projects', (req, reply) => {
  const { name, path: projectPath } = req.body || {}
  if (!name || !projectPath) return reply.code(400).send({ error: 'name e path são obrigatórios' })
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return reply.code(400).send({ error: 'diretório não existe' })
  }
  try { fs.accessSync(projectPath, fs.constants.W_OK) } catch {
    return reply.code(400).send({ error: 'diretório não é gravável' })
  }
  const project = { id: nanoid(6), name, path: projectPath, createdAt: new Date().toISOString(), skipPermissions: false }
  db.projects.push(project)
  saveProjects(db)
  try {
    bootstrapProject(projectPath)
    bootstrapErrors.delete(project.id)
  } catch (e) {
    bootstrapErrors.set(project.id, e.message)
  }
  startWatcher(project)
  return { project: projectView(project) }
})

app.patch('/api/projects/:projectId', (req, reply) => {
  const p = getProject(req.params.projectId)
  if (!p) return reply.code(404).send({ error: 'projeto não encontrado' })
  const { name, skipPermissions, git, defaultModel, autoRun, autoDecompose, devServer, timeoutMs } = req.body || {}
  if (name !== undefined) p.name = name
  if (skipPermissions !== undefined) p.skipPermissions = !!skipPermissions
  if (timeoutMs !== undefined) {
    if (timeoutMs === null || timeoutMs === '') {
      p.timeoutMs = null
    } else {
      const ms = Number(timeoutMs)
      if (!Number.isFinite(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
        return reply.code(400).send({ error: 'timeoutMs deve estar entre 1 e 240 minutos' })
      }
      p.timeoutMs = Math.round(ms)
    }
  }
  if (defaultModel !== undefined) {
    if (defaultModel && !normalizeModel(defaultModel)) {
      return reply.code(400).send({ error: invalidModelMsg(defaultModel) })
    }
    p.defaultModel = normalizeModel(defaultModel)
  }
  if (devServer !== undefined && typeof devServer === 'object') {
    const next = { ...(p.devServer || {}) }
    if (devServer.command !== undefined) next.command = String(devServer.command || '').trim()
    if (devServer.url !== undefined) next.url = String(devServer.url || '').trim()
    p.devServer = next
  }
  if (autoDecompose !== undefined) p.autoDecompose = !!autoDecompose
  if (autoRun !== undefined) {
    p.autoRun = !!autoRun
    if (p.autoRun) autoEnqueue(p)
  }
  if (git !== undefined && typeof git === 'object') {
    const next = { ...gitSettings(p) }
    if (git.baseBranch !== undefined) next.baseBranch = String(git.baseBranch).trim() || DEFAULT_GIT.baseBranch
    for (const k of ['pullBeforeStart', 'useCurrentBranch', 'commitToNewBranch', 'useWorktree', 'autoPush', 'autoPR', 'autoPRDescription']) {
      if (git[k] !== undefined) next[k] = !!git[k]
    }
    p.git = next
  }
  saveProjects(db)
  return { project: projectView(p) }
})

app.post('/api/projects/:projectId/bootstrap', (req, reply) => {
  const p = getProject(req.params.projectId)
  if (!p) return reply.code(404).send({ error: 'projeto não encontrado' })
  try {
    bootstrapProject(p.path)
    bootstrapErrors.delete(p.id)
  } catch (e) {
    bootstrapErrors.set(p.id, e.message)
  }
  return { project: projectView(p) }
})

// ---- dev server ----
app.post('/api/projects/:projectId/dev-server/launch', async (req, reply) => {
  const p = getProject(req.params.projectId)
  if (!p) return reply.code(404).send({ error: 'projeto não encontrado' })
  try {
    return await devServers.launch(p)
  } catch (e) {
    return reply.code(400).send({ error: e.message })
  }
})

app.post('/api/projects/:projectId/dev-server/stop', (req, reply) => {
  const p = getProject(req.params.projectId)
  if (!p) return reply.code(404).send({ error: 'projeto não encontrado' })
  if (!devServers.stop(p.id)) return reply.code(409).send({ error: 'dev server não está rodando' })
  return devServers.status(p.id)
})

app.get('/api/projects/:projectId/dev-server', (req, reply) => {
  const p = getProject(req.params.projectId)
  if (!p) return reply.code(404).send({ error: 'projeto não encontrado' })
  return { ...devServers.status(p.id), logs: devServers.logs(p.id) }
})

app.delete('/api/projects/:projectId', (req, reply) => {
  const idx = db.projects.findIndex(p => p.id === req.params.projectId)
  if (idx === -1) return reply.code(404).send({ error: 'projeto não encontrado' })
  const [p] = db.projects.splice(idx, 1)
  saveProjects(db)
  runner.dropProject(p.id)
  devServers.stop(p.id)
  watchers.get(p.id)?.close()
  watchers.delete(p.id)
  if (req.query.uninstallGuardrails === 'true' && fs.existsSync(p.path)) {
    uninstallGuardrails(p.path)
  }
  return { ok: true }
})

// ---- branches ----
app.get('/api/projects/:projectId/branches', (req, reply) => {
  const p = getProject(req.params.projectId)
  if (!p) return reply.code(404).send({ error: 'projeto não encontrado' })
  if (!fs.existsSync(p.path)) return reply.code(409).send({ error: 'diretório do projeto indisponível' })
  let fetchError = null
  if (req.query.fetch === 'true') {
    try { fetchRemotes(p.path) } catch (e) { fetchError = e.message }
  }
  return { branch: projectBranch(p.path), branches: listBranches(p.path), fetchError }
})

app.post('/api/projects/:projectId/branch', (req, reply) => {
  const p = getProject(req.params.projectId)
  if (!p) return reply.code(404).send({ error: 'projeto não encontrado' })
  if (!fs.existsSync(p.path)) return reply.code(409).send({ error: 'diretório do projeto indisponível' })
  const name = (req.body?.branch || '').trim()
  if (!name) return reply.code(400).send({ error: 'branch obrigatória' })
  const stash = !!req.body?.stash
  try {
    const res = checkoutBranch(p.path, name, { stash })
    emit('project.updated', { projectId: p.id })
    return { ...res, project: projectView(p) }
  } catch (e) {
    // canStash: o checkout falhou e há mudanças que um stash resolveria — a UI
    // oferece "guardar e trocar". Se o stash já foi tentado, não reoferece.
    return reply.code(409).send({ error: e.message, canStash: !stash && isDirty(p.path) })
  }
})

// ---- tasks ----
function withProject(req, reply) {
  const p = getProject(req.params.projectId)
  if (!p) { reply.code(404).send({ error: 'projeto não encontrado' }); return null }
  if (!fs.existsSync(p.path)) { reply.code(409).send({ error: 'diretório do projeto indisponível' }); return null }
  return p
}

app.get('/api/projects/:projectId/tasks', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  return { tasks: listTasks(p.path) }
})

app.post('/api/projects/:projectId/tasks', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  const { title, description, priority, tags, status, model, decompose, scheduled_at } = req.body || {}
  if (!title) return reply.code(400).send({ error: 'title é obrigatório' })
  if (model && !normalizeModel(model)) return reply.code(400).send({ error: invalidModelMsg(model) })
  const when = scheduled_at ? parseWhen(scheduled_at) : null
  if (scheduled_at && !when) return reply.code(400).send({ error: 'scheduled_at inválido (use uma data ISO)' })
  const task = createTask(p.path, { title, description, priority, tags, status, model: normalizeModel(model), decompose, scheduled_at: when })
  emit('task.upserted', { projectId: p.id, task })
  return { task }
})

app.get('/api/projects/:projectId/tasks/:taskId', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  const task = findTask(p.path, req.params.taskId)
  if (!task) return reply.code(404).send({ error: 'task não encontrada' })
  return { task }
})

app.patch('/api/projects/:projectId/tasks/:taskId', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  const before = findTask(p.path, req.params.taskId)
  if (!before) return reply.code(404).send({ error: 'task não encontrada' })
  const patch = { ...(req.body || {}) }
  if (patch.model !== undefined) {
    if (patch.model && !normalizeModel(patch.model)) {
      return reply.code(400).send({ error: invalidModelMsg(patch.model) })
    }
    patch.model = normalizeModel(patch.model)
  }
  // scheduled_at: '' / null desagenda; qualquer outra coisa precisa ser uma data.
  if (patch.scheduled_at !== undefined) {
    if (!patch.scheduled_at) {
      patch.scheduled_at = null
    } else {
      const iso = parseWhen(patch.scheduled_at)
      if (!iso) return reply.code(400).send({ error: 'scheduled_at inválido (use uma data ISO)' })
      patch.scheduled_at = iso
    }
  }
  const task = updateTask(p.path, req.params.taskId, patch)
  if (before.status !== task.status) {
    emit('task.moved', { projectId: p.id, taskId: task.id, from: before.status, to: task.status })
  }
  emit('task.upserted', { projectId: p.id, task })
  return { task }
})

app.delete('/api/projects/:projectId/tasks/:taskId', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  const before = findTask(p.path, req.params.taskId)
  if (!before) return reply.code(404).send({ error: 'task não encontrada' })
  const task = updateTask(p.path, req.params.taskId, { status: 'archived' })
  emit('task.moved', { projectId: p.id, taskId: task.id, from: before.status, to: 'archived' })
  emit('task.upserted', { projectId: p.id, task })
  return { task }
})

app.get('/api/projects/:projectId/tasks/:taskId/diff', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  const task = findTask(p.path, req.params.taskId)
  if (!task) return reply.code(404).send({ error: 'task não encontrada' })
  const file = diffFile(p.path, task.id)
  if (!fs.existsSync(file)) return reply.code(404).send({ error: 'nenhum diff registrado para esta task' })
  return { diff: fs.readFileSync(file, 'utf8') }
})

app.get('/api/projects/:projectId/tasks/:taskId/log', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  const task = findTask(p.path, req.params.taskId)
  if (!task) return reply.code(404).send({ error: 'task não encontrada' })
  const events = runner.readLog(p.path, task.id)
  return { events: events || [] }
})

// ---- análise do projeto (sugestão de tasks) ----
app.get('/api/suggestion-types', () => ({ types: SUGGESTION_TYPES }))

app.post('/api/projects/:projectId/analyze', async (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  if (!claudeAvailable) return reply.code(409).send({ error: 'CLI `claude` não encontrado no PATH' })
  try {
    return await analyzeProject(p, req.body?.types)
  } catch (e) {
    return reply.code(500).send({ error: e.message })
  }
})

// ---- pending actions ----
app.get('/api/projects/:projectId/pending-actions', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  return { actions: listPendingActions(p.path) }
})

app.post('/api/projects/:projectId/pending-actions/:actionId/resolve', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  const ok = resolvePendingAction(p.path, req.params.actionId)
  if (!ok) return reply.code(404).send({ error: 'ação não encontrada ou já resolvida' })
  const actions = listPendingActions(p.path)
  emit('pending.updated', { projectId: p.id, actions })
  return { actions }
})

// ---- claude config (settings, mcp, hooks, skills, agents, commands…) ----
app.get('/api/projects/:projectId/claude-config', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  return { files: listConfigFiles(p.path) }
})

app.get('/api/projects/:projectId/claude-config/file', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  try { return readConfigFile(p.path, req.query.path) }
  catch (e) { return reply.code(400).send({ error: e.message }) }
})

app.put('/api/projects/:projectId/claude-config/file', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  try {
    const res = writeConfigFile(p.path, req.body?.path, req.body?.content)
    emit('project.updated', { projectId: p.id })
    return res
  } catch (e) { return reply.code(400).send({ error: e.message }) }
})

// ---- runner ----
app.post('/api/projects/:projectId/tasks/:taskId/run', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  if (!claudeAvailable) return reply.code(409).send({ error: 'CLI `claude` não encontrado no PATH' })
  const ok = runner.enqueue(p.id, req.params.taskId)
  if (!ok) return reply.code(409).send({ error: 'task já está na fila ou não existe' })
  return runner.getQueueView()
})

// Desmembrar agora: roda a sessão de decomposição imediatamente (fora da fila).
app.post('/api/projects/:projectId/tasks/:taskId/decompose', (req, reply) => {
  const p = withProject(req, reply); if (!p) return
  if (!claudeAvailable) return reply.code(409).send({ error: 'CLI `claude` não encontrado no PATH' })
  const ok = runner.decomposeNow(p.id, req.params.taskId)
  if (!ok) return reply.code(409).send({ error: 'task já está na fila/rodando ou não existe' })
  return runner.getQueueView()
})

app.post('/api/run/kill', (req, reply) => {
  if (!runner.kill(req.body?.taskId)) {
    return reply.code(409).send({ error: 'nenhuma sessão ativa correspondente (com mais de uma ativa, informe taskId)' })
  }
  return { ok: true }
})

// ---- agendamento da fila (adiar tudo de um projeto para X) ----
app.post('/api/projects/:projectId/queue/pause', (req, reply) => {
  const p = getProject(req.params.projectId)
  if (!p) return reply.code(404).send({ error: 'projeto não encontrado' })
  const until = parseWhen(req.body?.until)
  if (!until) return reply.code(400).send({ error: 'until inválido (use uma data ISO)' })
  if (!isFuture(until)) return reply.code(400).send({ error: 'until precisa estar no futuro' })
  p.queuePausedUntil = until
  saveProjects(db)
  emit('project.updated', { projectId: p.id })
  return { project: projectView(p) }
})

app.post('/api/projects/:projectId/queue/resume', (req, reply) => {
  const p = getProject(req.params.projectId)
  if (!p) return reply.code(404).send({ error: 'projeto não encontrado' })
  p.queuePausedUntil = null
  saveProjects(db)
  emit('project.updated', { projectId: p.id })
  runner.tick()
  return { project: projectView(p) }
})

app.post('/api/run/concurrency', req => {
  runner.setConcurrency(req.body?.max)
  return runner.getQueueView()
})

app.get('/api/run/queue', () => runner.getQueueView())

app.post('/api/run/queue/reorder', req => {
  runner.reorder(req.body?.taskIds || [])
  return runner.getQueueView()
})

await app.listen({ port: PORT, host: '127.0.0.1' })
console.log(`claude-kanban server em http://127.0.0.1:${PORT}${claudeAvailable ? '' : '  (aviso: claude CLI não encontrado no PATH)'}`)
