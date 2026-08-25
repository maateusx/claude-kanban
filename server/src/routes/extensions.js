import fs from 'node:fs'
import { listExtensions, installExtension, toggleExtension, removeExtension, catalogView } from '../lib/extensions.js'
import { listPlugins, pluginAction } from '../lib/plugins.js'

// Uma família de rotas só, com `projectId` opcional no query/body: sem projeto o
// escopo é global (~/.claude), com projeto é <projeto>/.claude. Evita duplicar
// tudo em /api/extensions e /api/projects/:id/extensions.
export default function extensionRoutes(app, ctx) {
  const { emit } = ctx

  // devolve { path } do projeto, { path: null } para global, ou null se já respondeu erro
  const scopeOf = (req, reply) => {
    const pid = req.query?.projectId || req.body?.projectId
    if (!pid) return { path: null }
    const p = ctx.getProject(pid)
    if (!p) { reply.code(404).send({ error: 'projeto não encontrado' }); return null }
    if (!fs.existsSync(p.path)) { reply.code(409).send({ error: 'diretório do projeto indisponível' }); return null }
    return { path: p.path, id: p.id }
  }

  const done = (s, res) => {
    if (s.id) emit('project.updated', { projectId: s.id })
    return res
  }

  app.get('/api/extensions', (req, reply) => {
    const s = scopeOf(req, reply); if (!s) return
    try { return { ...listExtensions(s.path), catalog: catalogView() } }
    catch (e) { return reply.code(400).send({ error: e.message }) }
  })

  app.post('/api/extensions/install', (req, reply) => {
    const s = scopeOf(req, reply); if (!s) return
    try {
      installExtension(req.body?.id, s.path)
      return done(s, { ...listExtensions(s.path), catalog: catalogView() })
    } catch (e) { return reply.code(400).send({ error: e.message }) }
  })

  app.post('/api/extensions/toggle', (req, reply) => {
    const s = scopeOf(req, reply); if (!s) return
    try { return done(s, toggleExtension(req.body?.kind, req.body?.name, !!req.body?.enabled, s.path)) }
    catch (e) { return reply.code(400).send({ error: e.message }) }
  })

  app.post('/api/extensions/remove', (req, reply) => {
    const s = scopeOf(req, reply); if (!s) return
    try { return done(s, removeExtension(req.body?.kind, req.body?.name, s.path)) }
    catch (e) { return reply.code(400).send({ error: e.message }) }
  })

  // ---- plugins (delegados ao CLI `claude plugin`) ----

  app.get('/api/plugins', async (req, reply) => {
    if (!ctx.claudeAvailable()) return reply.code(503).send({ error: 'CLI do Claude Code não encontrado no PATH' })
    try { return await listPlugins({ force: req.query?.refresh === 'true' }) }
    catch (e) { return reply.code(502).send({ error: e.message }) }
  })

  app.post('/api/plugins/:action', async (req, reply) => {
    if (!ctx.claudeAvailable()) return reply.code(503).send({ error: 'CLI do Claude Code não encontrado no PATH' })
    const s = scopeOf(req, reply); if (!s) return
    try { return done(s, await pluginAction(req.params.action, req.body?.id, s.path)) }
    catch (e) { return reply.code(400).send({ error: e.message }) }
  })
}
