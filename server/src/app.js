import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { bootstrapStatus } from './lib/bootstrap.js'
import { listPendingActions } from './lib/pending.js'
import { gitSettings, projectBranch } from './lib/git.js'
import { retrySettings, DEFAULT_MAX_TURNS } from './lib/runner.js'
import { getUsage } from './lib/usage.js'
import { modelsCatalog, refreshModels } from './lib/models.js'
import { listSearchSources } from './lib/searchSources.js'
import projectRoutes from './routes/projects.js'
import taskRoutes from './routes/tasks.js'
import gitRoutes from './routes/git.js'
import runRoutes from './routes/run.js'
import configRoutes from './routes/config.js'
import extensionRoutes from './routes/extensions.js'
import searchSourceRoutes from './routes/search-sources.js'

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
      retry: retrySettings(p),
      maxTurns: p.maxTurns ?? DEFAULT_MAX_TURNS,
      searchSources: listSearchSources(p),
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

  // O servidor executa código (claude -p) via HTTP: sem essas checagens, qualquer
  // página aberta no navegador poderia disparar rotas em 127.0.0.1 (CSRF → RCE local).
  const allowedOrigins = new Set([
    'http://localhost:5544',
    'http://127.0.0.1:5544',
    ...(process.env.CLAUDE_KANBAN_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  ])
  // Host de localhost, qualquer porta (o proxy do Vite preserva o host :5544);
  // qualquer outro nome indica DNS rebinding.
  const localHost = h => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h || '')

  const app = Fastify()
  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)) })
  await app.register(websocket)

  // Uma página em https (ex.: o Launchpad) alcançando 127.0.0.1 é Private Network
  // Access: o Chrome só aceita se o preflight responder com este header.
  app.addHook('onSend', (req, reply, payload, done) => {
    if (req.headers.origin && allowedOrigins.has(req.headers.origin)) {
      reply.header('Access-Control-Allow-Private-Network', 'true')
    }
    done(null, payload)
  })

  app.addHook('onRequest', (req, reply, done) => {
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
      return reply.code(403).send({ error: 'origin não permitido' })
    }
    if (!localHost(req.headers.host)) {
      return reply.code(403).send({ error: 'host não permitido' })
    }
    done()
  })

  app.get('/api/ws', { websocket: true }, socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  app.get('/api/health', () => ({ ok: true, claudeAvailable: claudeAvailable() }))

  // ---- usage/limites do plano Claude (sessão 5h + semanais) ----
  app.get('/api/usage', () => getUsage())

  // ---- catálogo de modelos ----
  app.get('/api/models', () => modelsCatalog())

  // Busca a lista oficial na Models API da Anthropic (botão "atualizar modelos").
  app.post('/api/models/refresh', async (req, reply) => {
    try { return await refreshModels() }
    catch (e) { return reply.code(502).send({ error: e.message }) }
  })

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
  extensionRoutes(app, ctx)
  searchSourceRoutes(app, ctx)
  runRoutes(app, ctx)

  app.decorate('ctx', ctx)
  return app
}
