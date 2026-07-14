import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { bootstrapStatus } from './lib/bootstrap.js'
import { listPendingActions } from './lib/pending.js'
import { gitSettings, projectBranch } from './lib/git.js'
import { getUsage } from './lib/usage.js'
import projectRoutes from './routes/projects.js'
import taskRoutes from './routes/tasks.js'
import gitRoutes from './routes/git.js'
import runRoutes from './routes/run.js'
import configRoutes from './routes/config.js'

// Monta o app Fastify sem side effects (nada de lockfile, watcher ou listen) —
// é isso que permite testar as rotas com app.inject().
//
// deps obrigatórias: db, runner, devServers, emit.
// deps opcionais (o index.js passa as de verdade; os testes ficam com os defaults):
//   claudeAvailable, sockets, startWatcher, stopWatcher, autoEnqueue, bootstrapErrors.
export async function buildApp(deps) {
  const { db, runner, devServers, emit } = deps
  const bootstrapErrors = deps.bootstrapErrors || new Map()
  const sockets = deps.sockets || new Set()
  const claudeAvailable = typeof deps.claudeAvailable === 'function'
    ? deps.claudeAvailable
    : () => deps.claudeAvailable !== false

  const getProject = id => db.projects.find(p => p.id === id) || null

  const projectView = p => {
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

  const ctx = {
    db,
    runner,
    devServers,
    emit,
    claudeAvailable,
    bootstrapErrors,
    getProject,
    projectView,
    startWatcher: deps.startWatcher || (() => {}),
    stopWatcher: deps.stopWatcher || (() => {}),
    autoEnqueue: deps.autoEnqueue || (() => {}),
  }

  const app = Fastify()
  await app.register(cors, { origin: true })
  await app.register(websocket)

  app.get('/api/ws', { websocket: true }, socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  app.get('/api/health', () => ({ ok: true, claudeAvailable: claudeAvailable() }))

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

  projectRoutes(app, ctx)
  gitRoutes(app, ctx)
  taskRoutes(app, ctx)
  configRoutes(app, ctx)
  runRoutes(app, ctx)

  app.decorate('ctx', ctx)
  return app
}
