import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { customAlphabet } from 'nanoid'
import { STATUSES, tasksDir, diffFile, logFile } from './paths.js'
import { normalizeModel } from './models.js'
import { findTemplate, bodyFromTemplate } from './templates.js'

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
  pr: null, // { url, number, state } quando a sessão abriu uma PR (autoPR)
}

export function defaultBody(description = '') {
  return `\n## Descrição\n\n${description || 'O que precisa ser feito, critérios de aceite, contexto, links.'}\n\n## Resultado\n<!-- Preenchido pelo Claude ao concluir: resumo, decisões, arquivos alterados, contexto para memória -->\n\n## Log de erros\n<!-- Preenchido pelo backend em caso de falha -->\n`
}

// gray-matter re-parseia o body ao stringificar: se ele começa com `---`
// (task com frontmatter duplicado no corpo), o YAML quebrado derruba o processo.
export function stringifyTask(body, fm) {
  const safe = /^\s*---/.test(body || '') ? `\n${body}` : body
  return matter.stringify(safe, fm)
}

export function serializeTask(task, body) {
  const fm = {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority || 'medium',
    tags: task.tags || [],
    depends_on: normalizeDependsOn(task.depends_on),
    model: task.model || null,
    enrich: task.enrich ?? null,
    decompose: task.decompose ?? null,
    scheduled_at: task.scheduled_at || null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    run: { ...DEFAULT_RUN, ...(task.run || {}) },
  }
  return stringifyTask(body ?? defaultBody(), fm)
}

// depends_on: lista de ids de tasks que precisam concluir antes desta rodar.
// Aceita string solta (humano editando o .md na mão) e limpa duplicatas/vazios.
export function normalizeDependsOn(value) {
  const list = value == null ? [] : Array.isArray(value) ? value : [value]
  const out = []
  for (const v of list) {
    const id = String(v ?? '').trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

// Detecta ciclo assumindo `deps` como as dependências de `taskId` (que pode ainda
// não existir, no caso de um POST). Percorre o grafo a partir de cada dependência
// procurando um caminho de volta para taskId.
export function hasDependencyCycle(tasks, taskId, deps) {
  const byId = new Map(tasks.map(t => [t.id, normalizeDependsOn(t.depends_on)]))
  byId.set(taskId, normalizeDependsOn(deps))
  const seen = new Set()
  const stack = [...byId.get(taskId)]
  while (stack.length) {
    const id = stack.pop()
    if (id === taskId) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(byId.get(id) || []))
  }
  return false
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
  // O YAML resolve um timestamp sem aspas (o humano editando o .md na mão) como
  // Date; o resto do sistema — e o JSON da API — só fala ISO string.
  if (fm.scheduled_at instanceof Date) fm.scheduled_at = fm.scheduled_at.toISOString()
  if (fm.scheduled_at === undefined) fm.scheduled_at = null

  const deps = normalizeDependsOn(fm.depends_on)
  if (JSON.stringify(deps) !== JSON.stringify(fm.depends_on ?? [])) { fm.depends_on = deps; dirty = true }

  // Migra o apelido legado ("opus") para o slug oficial ("claude-opus-4-8");
  // apaga o que não for um modelo conhecido, para não quebrar o spawn.
  if (fm.model) {
    const normalized = normalizeModel(fm.model)
    if (normalized !== fm.model) { fm.model = normalized; dirty = true }
  }

  if (dirty) {
    fm.updated_at = new Date().toISOString()
    markSelfWrite(filePath)
    fs.writeFileSync(filePath, stringifyTask(body, fm))
  }
  return { ...fm, body, filePath, fileName: path.basename(filePath) }
}

export function findTask(projectPath, taskId) {
  return listTasks(projectPath).find(t => t.id === taskId) || null
}

export function createTask(projectPath, { title, description, priority = null, tags = [], status = 'backlog', model = null, enrich = null, decompose = null, scheduled_at = null, template = null, depends_on = [] }) {
  if (!STATUSES.includes(status)) status = 'backlog'
  // O template dá o corpo e os defaults de prioridade/tags/modelo; o que veio
  // explícito no request sempre vence.
  const tpl = template ? findTemplate(projectPath, template) : null
  const now = new Date().toISOString()
  const task = {
    id: newId(), title, status,
    priority: priority || tpl?.priority || 'medium',
    tags: tags?.length ? tags : (tpl?.tags || []),
    depends_on: normalizeDependsOn(depends_on),
    model: normalizeModel(model || tpl?.model || null),
    enrich, decompose, scheduled_at, created_at: now, updated_at: now, run: { ...DEFAULT_RUN },
  }
  const body = tpl ? bodyFromTemplate(tpl, description) : defaultBody(description)
  const dir = tasksDir(projectPath, status)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, taskFileName(task))
  markSelfWrite(filePath)
  fs.writeFileSync(filePath, serializeTask(task, body))
  return loadTask(projectPath, filePath)
}

// Atualiza frontmatter/corpo e move de pasta se status mudou (escreve, depois rename)
export function updateTask(projectPath, taskId, patch) {
  const task = findTask(projectPath, taskId)
  if (!task) return null
  const { frontmatter: fm, body } = parseTaskFile(task.filePath)

  const newBody = patch.body !== undefined ? patch.body : body
  for (const k of ['title', 'priority', 'tags', 'status', 'model', 'enrich', 'decompose', 'scheduled_at']) {
    if (patch[k] !== undefined) fm[k] = patch[k]
  }
  if (patch.depends_on !== undefined) fm.depends_on = normalizeDependsOn(patch.depends_on)
  if (patch.run) fm.run = { ...DEFAULT_RUN, ...fm.run, ...patch.run }
  fm.updated_at = new Date().toISOString()

  let filePath = task.filePath
  markSelfWrite(filePath)
  fs.writeFileSync(filePath, stringifyTask(newBody, fm))

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

// Remove a task do disco de vez (arquivo .md + diff/log associados) e limpa
// referências em depends_on de outras tasks.
export function deleteTask(projectPath, taskId) {
  const task = findTask(projectPath, taskId)
  if (!task) return null
  markSelfWrite(task.filePath)
  fs.rmSync(task.filePath, { force: true })
  fs.rmSync(diffFile(projectPath, taskId), { force: true })
  fs.rmSync(logFile(projectPath, taskId), { force: true })
  for (const t of listTasks(projectPath)) {
    if ((t.depends_on || []).includes(taskId)) {
      updateTask(projectPath, t.id, { depends_on: t.depends_on.filter(id => id !== taskId) })
    }
  }
  return task
}

// Extrai o conteúdo de uma seção "## <header>" do corpo (sem comentários HTML).
export function getSection(body, header) {
  if (!body) return ''
  const re = new RegExp(`^##\\s+${header}\\s*$`, 'im')
  const m = re.exec(body)
  if (!m) return ''
  const rest = body.slice(m.index + m[0].length)
  const next = /^##\s+/m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest)
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
}

// Substitui o conteúdo de uma seção "## <header>" no corpo, preservando as demais.
export function replaceSection(body, header, text) {
  const re = new RegExp(`^##\\s+${header}\\s*$`, 'im')
  const m = re.exec(body || '')
  if (!m) return `${body || ''}\n## ${header}\n\n${text}\n`
  const rest = body.slice(m.index + m[0].length)
  const next = /^##\s+/m.exec(rest)
  const tail = next ? rest.slice(next.index) : ''
  return `${body.slice(0, m.index)}## ${header}\n\n${text}\n\n${tail}`
}

// Remove a seção "## <header>" (cabeçalho e conteúdo) do corpo. Sem a seção,
// devolve o corpo intacto.
export function removeSection(body, header) {
  const re = new RegExp(`^##\\s+${header}\\s*$`, 'im')
  const m = re.exec(body || '')
  if (!m) return body || ''
  const rest = body.slice(m.index + m[0].length)
  const next = /^##\s+/m.exec(rest)
  const tail = next ? rest.slice(next.index) : ''
  return `${body.slice(0, m.index)}${tail}`
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
  fs.writeFileSync(task.filePath, stringifyTask(newBody, fm))
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
        fs.writeFileSync(newer, stringifyTask(body, fm))
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
