import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { customAlphabet } from 'nanoid'
import { STATUSES, tasksDir } from './paths.js'
import { normalizeModel } from './models.js'

export const newId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6)

// registro global de escritas próprias (consultado pelo watcher para se ignorar)
export const selfWrites = new Map() // filePath -> timestamp
export function markSelfWrite(...files) {
  const now = Date.now()
  for (const f of files) selfWrites.set(f, now)
  // GC
  for (const [f, t] of selfWrites) if (now - t > 2000) selfWrites.delete(f)
}
export function isSelfWrite(file) {
  const t = selfWrites.get(file)
  return t != null && Date.now() - t < 2000
}

export function slugify(title) {
  return String(title).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task'
}

export function taskFileName(task) {
  return `${slugify(task.title)}--${task.id}.md`
}

const DEFAULT_RUN = {
  session_id: null, started_at: null, completed_at: null, exit_code: null,
  cost_usd: null, duration_ms: null, num_turns: null, attempts: 0, has_diff: false,
}

export function defaultBody(description = '') {
  return `\n## Descrição\n\n${description || 'O que precisa ser feito, critérios de aceite, contexto, links.'}\n\n## Resultado\n<!-- Preenchido pelo Claude ao concluir: resumo, decisões, arquivos alterados, contexto para memória -->\n\n## Log de erros\n<!-- Preenchido pelo backend em caso de falha -->\n`
}

export function serializeTask(task, body) {
  const fm = {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority || 'medium',
    tags: task.tags || [],
    model: task.model || null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    run: { ...DEFAULT_RUN, ...(task.run || {}) },
  }
  return matter.stringify(body ?? defaultBody(), fm)
}

export function parseTaskFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const { data, content } = matter(raw)
  return { frontmatter: data, body: content, filePath }
}

export function statusFromPath(filePath) {
  const dir = path.basename(path.dirname(filePath))
  return STATUSES.includes(dir) ? dir : null
}

// Lê todas as tasks de um projeto, reconciliando pasta↔status (pasta vence)
export function listTasks(projectPath) {
  const tasks = []
  for (const status of STATUSES) {
    const dir = tasksDir(projectPath, status)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const filePath = path.join(dir, f)
      try {
        tasks.push(loadTask(projectPath, filePath))
      } catch { /* arquivo corrompido: ignora */ }
    }
  }
  return tasks
}

// Carrega uma task reconciliando: adota arquivos crus, corrige status pelo dir
export function loadTask(projectPath, filePath) {
  let { frontmatter: fm, body } = parseTaskFile(filePath)
  const folderStatus = statusFromPath(filePath)
  let dirty = false

  if (!fm.id) {
    fm.id = newId()
    if (!fm.title) fm.title = path.basename(filePath, '.md').replace(/--\w+$/, '').replace(/-/g, ' ') || 'Sem título'
    if (!fm.created_at) fm.created_at = new Date().toISOString()
    dirty = true
  }
  if (fm.status !== folderStatus) { fm.status = folderStatus; dirty = true }
  if (!STATUSES.includes(fm.status)) { fm.status = folderStatus || 'backlog'; dirty = true }
  if (!fm.priority) { fm.priority = 'medium'; dirty = true }
  if (!fm.run) { fm.run = { ...DEFAULT_RUN }; dirty = true }

  // Migra o apelido legado ("opus") para o slug oficial ("claude-opus-4-8");
  // apaga o que não for um modelo conhecido, para não quebrar o spawn.
  if (fm.model) {
    const normalized = normalizeModel(fm.model)
    if (normalized !== fm.model) { fm.model = normalized; dirty = true }
  }

  if (dirty) {
    fm.updated_at = new Date().toISOString()
    markSelfWrite(filePath)
    fs.writeFileSync(filePath, matter.stringify(body, fm))
  }
  return { ...fm, body, filePath, fileName: path.basename(filePath) }
}

export function findTask(projectPath, taskId) {
  return listTasks(projectPath).find(t => t.id === taskId) || null
}

export function createTask(projectPath, { title, description, priority = 'medium', tags = [], status = 'backlog', model = null }) {
  if (!STATUSES.includes(status)) status = 'backlog'
  const now = new Date().toISOString()
  const task = { id: newId(), title, status, priority, tags, model: normalizeModel(model), created_at: now, updated_at: now, run: { ...DEFAULT_RUN } }
  const dir = tasksDir(projectPath, status)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, taskFileName(task))
  markSelfWrite(filePath)
  fs.writeFileSync(filePath, serializeTask(task, defaultBody(description)))
  return loadTask(projectPath, filePath)
}

// Atualiza frontmatter/corpo e move de pasta se status mudou (escreve, depois rename)
export function updateTask(projectPath, taskId, patch) {
  const task = findTask(projectPath, taskId)
  if (!task) return null
  const { frontmatter: fm, body } = parseTaskFile(task.filePath)

  const newBody = patch.body !== undefined ? patch.body : body
  for (const k of ['title', 'priority', 'tags', 'status', 'model']) {
    if (patch[k] !== undefined) fm[k] = patch[k]
  }
  if (patch.run) fm.run = { ...DEFAULT_RUN, ...fm.run, ...patch.run }
  fm.updated_at = new Date().toISOString()

  let filePath = task.filePath
  markSelfWrite(filePath)
  fs.writeFileSync(filePath, matter.stringify(newBody, fm))

  // renomeia se título mudou ou pasta mudou
  const targetDir = tasksDir(projectPath, fm.status)
  const targetPath = path.join(targetDir, taskFileName(fm))
  if (targetPath !== filePath) {
    fs.mkdirSync(targetDir, { recursive: true })
    markSelfWrite(filePath, targetPath)
    fs.renameSync(filePath, targetPath)
    filePath = targetPath
  }
  return loadTask(projectPath, filePath)
}

export function appendToSection(projectPath, taskId, section, text) {
  const task = findTask(projectPath, taskId)
  if (!task) return null
  const { frontmatter: fm, body } = parseTaskFile(task.filePath)
  const header = `## ${section}`
  let newBody
  if (body.includes(header)) {
    newBody = body.replace(header, `${header}\n\n${text}\n`)
  } else {
    newBody = body + `\n${header}\n\n${text}\n`
  }
  fm.updated_at = new Date().toISOString()
  markSelfWrite(task.filePath)
  fs.writeFileSync(task.filePath, matter.stringify(newBody, fm))
  return loadTask(projectPath, task.filePath)
}

// Reconciliação completa (boot / cadastro): resolve ids duplicados e status divergentes
export function reconcileProject(projectPath) {
  const seen = new Map() // id -> {filePath, created}
  for (const status of STATUSES) {
    const dir = tasksDir(projectPath, status)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const filePath = path.join(dir, f)
      let task
      try { task = loadTask(projectPath, filePath) } catch { continue }
      const prev = seen.get(task.id)
      if (prev) {
        // id duplicado: regenera o do arquivo mais novo; o outro preserva o id
        const newer = fs.statSync(filePath).mtimeMs >= fs.statSync(prev).mtimeMs ? filePath : prev
        const keeper = newer === filePath ? prev : filePath
        const { frontmatter: fm, body } = parseTaskFile(newer)
        fm.id = newId()
        fm.updated_at = new Date().toISOString()
        markSelfWrite(newer)
        fs.writeFileSync(newer, matter.stringify(body, fm))
        console.warn(`[reconcile] id duplicado em ${newer}: novo id ${fm.id}`)
        seen.set(fm.id, newer)
        seen.set(task.id, keeper)
      } else {
        seen.set(task.id, filePath)
      }
    }
  }
  return listTasks(projectPath)
}
