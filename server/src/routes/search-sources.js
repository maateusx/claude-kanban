import { saveProjects, STATUSES } from '../lib/paths.js'
import { listSearchSources, normalizeSource } from '../lib/searchSources.js'
import { fetchSource, itemTag, itemDescription } from '../lib/searchFetch.js'
import { listTasks, createTask } from '../lib/tasks.js'
import { withProject, withProjectRecord, PRIORITIES } from './helpers.js'

// Tags `search:*` já usadas no projeto — é contra elas que o dedupe compara.
const importedTags = projectPath =>
  new Set(listTasks(projectPath).flatMap(t => (t.tags || []).filter(tag => tag.startsWith('search:'))))

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

  // ---- executar as buscas e importar os resultados como tasks ----
  // Cada candidato leva a tag `search:<sourceId>:<hash>`; buscar de novo marca
  // `already_imported` em vez de duplicar card (mesmo contrato do import de issues).
  app.post('/api/projects/:projectId/search-sources/fetch-all', async (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const sources = listSearchSources(p).filter(s => s.enabled)
    const imported = importedTags(p.path)
    const items = []
    const errors = []
    // Uma fonte fora do ar não pode derrubar a busca inteira: vira erro por fonte.
    await Promise.all(sources.map(async s => {
      try {
        items.push(...(await fetchSource(s)).map(i => ({ ...i, already_imported: imported.has(i.tag) })))
      } catch (e) {
        errors.push({ sourceId: s.id, sourceName: s.name, error: e.message })
      }
    }))
    return { items, errors }
  })

  app.post('/api/projects/:projectId/search-sources/import', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const input = Array.isArray(req.body?.items) ? req.body.items : []
    if (!input.length) return reply.code(400).send({ error: 'items é obrigatório (resultados a importar)' })
    const { priority, status } = req.body || {}
    // A tag é recalculada aqui: o cliente manda o item, não a identidade dele.
    const existing = importedTags(p.path)

    const created = []
    const skipped = []
    for (const raw of input) {
      const item = {
        sourceId: String(raw?.sourceId || '').trim(),
        sourceName: String(raw?.sourceName || '').trim(),
        title: String(raw?.title || '').trim().slice(0, 200),
        description: String(raw?.description || ''),
        url: String(raw?.url || '').trim(),
      }
      if (!item.sourceId || !item.title) { skipped.push({ title: item.title, reason: 'item inválido (sourceId/title)' }); continue }
      const tag = itemTag(item.sourceId, item)
      if (existing.has(tag)) { skipped.push({ title: item.title, tag, reason: 'já importada' }); continue }
      const task = createTask(p.path, {
        title: item.title,
        description: itemDescription(item),
        priority: PRIORITIES.includes(priority) ? priority : 'medium',
        tags: ['search', tag],
        status: STATUSES.includes(status) ? status : 'backlog',
      })
      existing.add(tag)
      created.push(task)
      emit('task.upserted', { projectId: p.id, task })
    }
    return { created, skipped }
  })

  app.post('/api/projects/:projectId/search-sources/:sourceId/fetch', async (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const source = listSearchSources(p).find(s => s.id === req.params.sourceId)
    if (!source) return reply.code(404).send({ error: 'fonte de busca não encontrada' })
    let items
    try { items = await fetchSource(source) }
    catch (e) { return reply.code(e.code ? 502 : 500).send({ error: e.message }) }
    const imported = importedTags(p.path)
    return { items: items.map(i => ({ ...i, already_imported: imported.has(i.tag) })) }
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
