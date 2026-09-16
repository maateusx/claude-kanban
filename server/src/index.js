import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { HOME_DIR, LOCK_FILE, loadProjects, saveProjects } from './lib/paths.js'
import { listTasks, reconcileProject } from './lib/tasks.js'
import { sortTasks } from './lib/sort.js'
import { watchProject } from './lib/watcher.js'
import { Runner } from './lib/runner.js'
import { DevServers } from './lib/devservers.js'
import { Scheduler, isFuture } from './lib/scheduler.js'
import { Autopilot } from './lib/autopilot.js'
import { notifyWebhook } from './lib/webhook.js'
import { listPendingActions } from './lib/pending.js'
import { buildApp } from './app.js'

const PORT = Number(process.env.PORT || 4400)

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
const webhookSeen = new Set() // pending-actions já enviadas por webhook

function emit(type, payload) {
  const msg = JSON.stringify({ type, ...payload })
  for (const ws of sockets) { try { ws.send(msg) } catch {} }
  maybeAutoRun(type, payload)
  const project = getProject(payload.projectId)
  if (project) notifyWebhook(project, { type, ...payload }, webhookSeen)
}

// Auto-executar: com o modo ligado, tudo que está (ou entra) em todo/ vai para a fila.
function autoEnqueue(project, excludeTaskId) {
  if (!project?.autoRun || !claudeAvailable || !fs.existsSync(project.path)) return
  // Task com horário marcado no futuro não entra na fila agora — quem a coloca
  // lá é o Scheduler, quando a hora chegar.
  const todo = listTasks(project.path).filter(t =>
    t.status === 'todo' && t.id !== excludeTaskId
    && !(t.tags || []).includes('blocked') && !(t.tags || []).includes('human-request')
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

function startWatcher(project) {
  if (watchers.has(project.id) || !fs.existsSync(project.path)) return
  watchers.set(project.id, watchProject(project, emit))
}

function stopWatcher(projectId) {
  watchers.get(projectId)?.close()
  watchers.delete(projectId)
}

// ---- boot ----
let claudeAvailable = true
try { execFileSync('claude', ['--version'], { stdio: 'ignore' }) } catch { claudeAvailable = false }

for (const p of db.projects) {
  if (!fs.existsSync(p.path)) continue
  try { reconcileProject(p.path) } catch {}
  // Pendências que já existiam não são novidade: entram no visto para o primeiro
  // pending.updated (que reemite a lista inteira) não disparar webhook do passado.
  for (const a of listPendingActions(p.path)) webhookSeen.add(a.id)
  startWatcher(p)
}
runner.recover(db.projects.filter(p => fs.existsSync(p.path)))
for (const p of db.projects) autoEnqueue(p)
// Depois do recover/autoEnqueue: o primeiro tick já solta o que venceu enquanto
// o servidor estava fora do ar.
scheduler.start()
const autopilot = new Autopilot({ db, saveProjects, runner, emit, claudeAvailable: () => claudeAvailable })
autopilot.start()

// ---- app ----
const app = await buildApp({
  db, runner, devServers, emit, sockets, bootstrapErrors, autopilot,
  claudeAvailable: () => claudeAvailable,
  startWatcher, stopWatcher, autoEnqueue,
})
await app.listen({ port: PORT, host: '127.0.0.1' })
console.log(`claude-kanban server em http://127.0.0.1:${PORT}${claudeAvailable ? '' : '  (aviso: claude CLI não encontrado no PATH)'}`)
