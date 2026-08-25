import { saveProjects } from '../lib/paths.js'
import { listSearchSources, normalizeSource } from '../lib/searchSources.js'
import { withProjectRecord } from './helpers.js'

// CRUD das fontes de busca customizadas do projeto (endpoints HTTP que o usuário
// cadastra para importar tasks). Persistem em p.searchSources no projects.json.
export default function searchSourceRoutes(app, ctx) {
  const { db, projectView, emit } = ctx

  const save = p => {
    saveProjects(db)
    emit('project.updated', { projectId: p.id })
  }

  app.get('/api/projects/:projectId/search-sources', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    return { searchSources: listSearchSources(p) }
  })

  app.post('/api/projects/:projectId/search-sources', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    let source
    try { source = normalizeSource(req.body || {}) }
    catch (e) { return reply.code(400).send({ error: e.message }) }
    p.searchSources = [...listSearchSources(p), source]
    save(p)
    return { source, project: projectView(p) }
  })

  app.patch('/api/projects/:projectId/search-sources/:sourceId', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    const sources = listSearchSources(p)
    const idx = sources.findIndex(s => s.id === req.params.sourceId)
    if (idx === -1) return reply.code(404).send({ error: 'fonte de busca não encontrada' })
    let source
    try { source = normalizeSource(req.body || {}, sources[idx]) }
    catch (e) { return reply.code(400).send({ error: e.message }) }
    sources[idx] = source
    p.searchSources = sources
    save(p)
    return { source, project: projectView(p) }
  })

  app.delete('/api/projects/:projectId/search-sources/:sourceId', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    const sources = listSearchSources(p)
    const next = sources.filter(s => s.id !== req.params.sourceId)
    if (next.length === sources.length) return reply.code(404).send({ error: 'fonte de busca não encontrada' })
    p.searchSources = next
    save(p)
    return { ok: true, project: projectView(p) }
  })
}
