import React, { useEffect, useMemo, useRef, useState, useCallback, useReducer } from 'react'
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, useDraggable, closestCorners } from '@dnd-kit/core'
import { api, connectWS } from './api.js'
import { reducer, effectsFor, initialState, notificationsFor, pendingIds } from './events.js'
import * as notifications from './notify.js'
import * as sounds from './sounds.js'
import { THEMES, loadTheme, saveTheme, applyTheme, watchSystemTheme } from './theme.js'
import { LANGS, loadLang, saveLang, applyLang, locale, t, tn } from './i18n.js'
import { DiffDrawer } from './Diff.jsx'
import { sortTasks, loadSorts, saveSorts, SORT_OPTIONS, DEFAULT_SORT } from './sort.js'
import { MODELS, modelLabel } from './models.js'

// Nenhuma constante de módulo guarda texto traduízivel: t() é lida no render, então
// um label congelado aqui ficaria preso ao idioma que estava ativo no import.
const COLUMNS = [
  { key: 'backlog', dot: 'bg-st-backlog' },
  { key: 'todo', dot: 'bg-st-todo' },
  { key: 'doing', dot: 'bg-st-doing' },
  { key: 'done', dot: 'bg-st-done' },
  { key: 'archived', dot: 'bg-st-archived' },
]
const columnLabel = key => t(`column.${key}`)
const HUMAN_REQUEST_TAG = 'human-request'
const ENRICH_MODES = ['off', 'auto', 'always']
const enrichLabel = mode => t(`enrich.${ENRICH_MODES.includes(mode) ? mode : 'off'}`)

// Cada view escolhe as colunas visíveis. Archived nunca aparece por padrão.
const VIEWS = [
  { key: 'active', columns: ['todo', 'doing', 'done'] },
  { key: 'all', columns: ['backlog', 'todo', 'doing', 'done'] },
  { key: 'backlog', columns: ['backlog'] },
  { key: 'archived', columns: ['archived'] },
  // Não é um board: renderiza o painel de custos no lugar das colunas.
  { key: 'costs', columns: [] },
]
const viewOptions = () => VIEWS.map(v => ({ key: v.key, label: t(`view.${v.key}`) }))

const PRIORITY = {
  low: { arrow: '↓', cls: 'text-muted' },
  medium: { arrow: '—', cls: 'text-muted' },
  high: { arrow: '↑', cls: 'text-warning' },
  urgent: { arrow: '↑↑', cls: 'text-danger' },
}
const prioLabel = k => t(`priority.${PRIORITY[k] ? k : 'medium'}`)

const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) }
const tagHue = t => hash(t) % 360
const avatarBg = name => `hsl(${tagHue(name)} 62% 92%)`
const avatarInk = name => `hsl(${tagHue(name)} 45% 30%)`
const initials = name => (name || '?').trim().split(/[\s\-_/]+/).slice(0, 2).map(w => w[0]).join('').toUpperCase().slice(0, 2)

// O corpo da task é o .md inteiro; a UI mostra apenas a seção pedida.
export function section(body, header) {
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

const fmtCost = v => v == null ? null : `$${Number(v).toFixed(2)}`
const fmtDur = ms => {
  if (ms == null) return null
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
// ---- agendamento ----
// O <input type="datetime-local"> fala no fuso local sem timezone; o backend só
// entende ISO. Estas duas fazem a ponte nos dois sentidos.
export const toLocalInput = iso => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const fromLocalInput = v => {
  const t = Date.parse(v || '')
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}
export const isFuture = iso => {
  const t = Date.parse(iso || '')
  return !Number.isNaN(t) && t > Date.now()
}
// "hoje 23:00" / "amanhã 06:30" / "12/03 06:30" — o horário é a informação, a
// data só aparece quando não é hoje nem amanhã.
export const fmtWhen = iso => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hhmm = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const today = day(new Date())
  const diff = Math.round((day(d) - today) / 86400000)
  if (diff === 0) return t('time.today', { time: hhmm })
  if (diff === 1) return t('time.tomorrow', { time: hhmm })
  return `${d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' })} ${hhmm}`
}
// Presets de adiamento relativos ao agora, arredondando ao minuto.
export const inHours = h => new Date(Math.round((Date.now() + h * 3600_000) / 60000) * 60000).toISOString()
// Próxima ocorrência de HH:00 (hoje se ainda não passou, senão amanhã).
export const nextAt = hour => {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(0)
  if (d.getHours() >= hour) d.setDate(d.getDate() + 1)
  d.setHours(hour)
  return d.toISOString()
}

const ago = iso => {
  if (!iso) return ''
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return t('time.now')
  if (min < 60) return t('time.minutesAgo', { n: min })
  if (min < 1440) return t('time.hoursAgo', { n: Math.round(min / 60) })
  return t('time.daysAgo', { n: Math.round(min / 1440) })
}

export default function App() {
  const [projects, setProjects] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [{ tasks, pending, logs }, dispatch] = useReducer(reducer, initialState)
  const [queue, setQueue] = useState({ actives: [], queue: [], maxConcurrency: 1, paused: false, pausedUntil: null })
  const usage = useUsage()
  const [logTask, setLogTask] = useState(null)
  const [diffTask, setDiffTask] = useState(null)
  const [detailId, setDetailId] = useState(null)   // task aberta no drawer
  const [newTask, setNewTask] = useState(null)     // null | { status }
  const [showPending, setShowPending] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showGlobalSettings, setShowGlobalSettings] = useState(false)
  const [showSuggest, setShowSuggest] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const [showClaudeConfig, setShowClaudeConfig] = useState(false)
  const [showAddProject, setShowAddProject] = useState(false)
  const [view, setView] = useState('all')
  const [sorts, setSorts] = useState(loadSorts)  // colKey -> sort key
  const [query, setQuery] = useState('')
  const [health, setHealth] = useState({ ok: true, claudeAvailable: true })
  const [activeId, setActiveId] = useState(null)
  const [notifyOn, setNotifyOn] = useState(notifications.loadNotifyEnabled)
  const [theme, setTheme] = useState(loadTheme)
  const [lang, setLangState] = useState(loadLang)
  const searchRef = useRef(null)
  const selectedIdRef = useRef(null)
  selectedIdRef.current = selectedId

  // Refs para o handler do WS (que é montado uma vez) enxergar o estado atual
  // sem reconectar a cada render.
  const notifyRef = useRef(notifyOn)
  notifyRef.current = notifyOn
  const [soundOn, setSoundOn] = useState(sounds.loadSoundEnabled)
  const soundRef = useRef(soundOn)
  soundRef.current = soundOn
  const [soundMap, setSoundMap] = useState(sounds.loadSoundMap)
  const soundMapRef = useRef(soundMap)
  soundMapRef.current = soundMap
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  // pending-actions já vistas + projetos já "semeados": o watcher reemite a lista
  // inteira, então a primeira leitura de um projeto só registra os ids (senão o
  // board notificaria tudo que já estava pendente ao abrir).
  const seenPendingRef = useRef({ ids: new Set(), seeded: new Set() })

  const project = projects.find(p => p.id === selectedId) || null

  const setTasks = useCallback(ts => dispatch({ type: 'setTasks', tasks: ts }), [])
  const setPending = useCallback(p => dispatch({ type: 'setPending', pending: p }), [])

  // Ligar o toggle pede a permissão do browser; se o usuário negar, o toggle
  // volta para desligado (senão ficaria "ligado" sem nunca notificar).
  const setNotifyEnabled = useCallback(async v => {
    if (!v) { setNotifyOn(false); notifications.saveNotifyEnabled(false); return }
    const perm = await notifications.ensurePermission()
    const on = perm === 'granted'
    setNotifyOn(on)
    notifications.saveNotifyEnabled(on)
  }, [])

  const setSoundEnabled = useCallback(v => {
    setSoundOn(v)
    sounds.saveSoundEnabled(v)
    if (v) sounds.play('success', soundMapRef.current) // feedback imediato (e destrava o AudioContext no gesto)
  }, [])

  // Tema: 'system' segue o SO em tempo real, por isso o listener vive no effect.
  useEffect(() => {
    applyTheme(theme)
    return watchSystemTheme(() => applyTheme(theme))
  }, [theme])

  const setThemePref = useCallback(v => {
    setTheme(v)
    saveTheme(v)
  }, [])

  // Idioma: applyLang troca o dicionário no módulo i18n e o setState re-renderiza a
  // árvore inteira — como t() é lida no render, isso basta para traduzir tudo.
  const setLangPref = useCallback(v => {
    applyLang(v)
    saveLang(v)
    setLangState(v)
  }, [])

  // Troca o som de uma categoria e já toca o escolhido como preview.
  const setSoundFor = useCallback((category, variant) => {
    const map = { ...soundMapRef.current, [category]: variant }
    setSoundMap(map)
    sounds.saveSoundMap(map)
    sounds.playVariant(variant)
  }, [])

  const refreshProjects = useCallback(() => api.projects().then(d => {
    setProjects(d.projects)
    if (!selectedIdRef.current && d.projects[0]) setSelectedId(d.projects[0].id)
  }), [])

  useEffect(() => { refreshProjects(); api.health().then(setHealth); api.queue().then(setQueue) }, [refreshProjects])

  useEffect(() => {
    if (!selectedId) return
    api.tasks(selectedId).then(d => setTasks(d.tasks)).catch(() => setTasks([]))
    api.pending(selectedId).then(d => setPending(d.actions)).catch(() => setPending([]))
  }, [selectedId])

  useEffect(() => connectWS(evt => {
    const cur = selectedIdRef.current
    dispatch({ type: 'ws', evt, projectId: cur })
    for (const effect of effectsFor(evt, cur)) {
      if (effect === 'projects') refreshProjects()
      if (effect === 'queue') api.queue().then(setQueue)
      if (effect === 'tasks') api.tasks(cur).then(d => setTasks(d.tasks))
    }

    const seen = seenPendingRef.current
    const firstPending = evt.type === 'pending.updated' && !seen.seeded.has(evt.projectId)
    if ((notifyRef.current || soundRef.current) && !firstPending) {
      const ns = notificationsFor(evt, {
        projects: projectsRef.current,
        tasks: tasksRef.current,
        seenPendingIds: seen.ids,
      })
      for (const n of ns) {
        if (soundRef.current) sounds.play(n.sound, soundMapRef.current)
        if (notifyRef.current) notifications.notify(n, () => {
          if (n.projectId) setSelectedId(n.projectId)
          if (n.taskId) setDetailId(n.taskId)
        })
      }
    }
    if (evt.type === 'pending.updated') {
      for (const id of pendingIds(evt)) seen.ids.add(id)
      seen.seeded.add(evt.projectId)
    }
  }), [refreshProjects, setTasks])

  // Atalhos: n = nova task, / = busca, esc = fecha o drawer.
  useEffect(() => {
    const onKey = e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable
      if (e.key === 'Escape') { setDetailId(null); return }
      if (typing) return
      if (e.key === 'n' && project) { e.preventDefault(); setNewTask({ status: 'backlog' }) }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [project])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const onDragEnd = ({ active, over }) => {
    setActiveId(null)
    if (!over || !project) return
    const status = over.id
    const task = tasks.find(t => t.id === active.id)
    if (!task || task.status === status) return
    setTasks(tasks.map(t => t.id === task.id ? { ...t, status } : t)) // otimista
    api.patchTask(project.id, task.id, { status }).catch(() => api.tasks(project.id).then(d => setTasks(d.tasks)))
  }

  const runTask = tid => api.run(project.id, tid).then(setQueue).catch(e => alert(e.message))
  const dequeueTask = tid => api.dequeue(tid).then(setQueue).catch(e => alert(e.message))
  const [enriching, setEnriching] = useState(null) // taskId em enriquecimento
  const enrichNow = tid => {
    setEnriching(tid)
    api.enrichTask(project.id, tid)
      .then(d => {
        if (!d.enriched) alert(d.reason ? t('app.nothingChangedReason', { reason: d.reason }) : t('app.nothingChanged'))
        return api.tasks(project.id).then(x => setTasks(x.tasks))
      })
      .catch(e => alert(e.message))
      .finally(() => setEnriching(null))
  }
  const decomposeNow = tid => api.decompose(project.id, tid).then(setQueue).catch(e => alert(e.message))
  const pendingCount = pending.filter(a => a.status === 'pending').length
  const detail = tasks.find(t => t.id === detailId) || null

  // depends_on resolvido: taskId -> [{ id, title, status, done }]. Uma dependência
  // conta como cumprida quando está done/archived; id órfão (task apagada) some.
  const depsBy = useMemo(() => {
    const byId = new Map(tasks.map(t => [t.id, t]))
    const map = new Map()
    for (const t of tasks) {
      const deps = (t.depends_on || []).map(id => byId.get(id)).filter(Boolean)
        .map(d => ({ id: d.id, title: d.title, status: d.status, done: d.status === 'done' || d.status === 'archived' }))
      if (deps.length) map.set(t.id, deps)
    }
    return map
  }, [tasks])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tasks
    return tasks.filter(t =>
      t.title?.toLowerCase().includes(q) ||
      t.id?.toLowerCase().includes(q) ||
      (t.tags || []).some(tag => tag.toLowerCase().includes(q)))
  }, [tasks, query])

  const columns = VIEWS.find(v => v.key === view).columns

  const setSort = (colKey, sort) => setSorts(prev => {
    const next = { ...prev, [colKey]: sort }
    saveSorts(next)
    return next
  })

  const patchTask = (tid, patch) => api.patchTask(project.id, tid, patch)
    .then(() => api.tasks(project.id).then(d => setTasks(d.tasks)))
    .catch(e => alert(e.message))

  // Arquiva em série: cada DELETE reescreve o .md da task e o watcher reprocessa o diretório,
  // então disparar tudo em paralelo embaralharia os eventos de move.
  const archiveAll = async ids => {
    try {
      for (const id of ids) await api.archiveTask(project.id, id)
    } catch (e) {
      alert(e.message)
    }
    const d = await api.tasks(project.id)
    setTasks(d.tasks)
    if (ids.includes(detailId)) setDetailId(null)
  }

  return (
    <div className="flex h-full bg-bg text-ink">
      <Rail
        projects={projects} selectedId={selectedId} onSelect={setSelectedId} queue={queue} usage={usage}
        onAdd={() => setShowAddProject(true)}
        onRemove={p => {
          if (!confirm(t('rail.confirmRemove', { name: p.name }))) return
          api.removeProject(p.id, false)
            .then(() => { if (p.id === selectedIdRef.current) setSelectedId(null); refreshProjects() })
            .catch(e => alert(e.message))
        }}
        onSettings={() => setShowGlobalSettings(true)}
      />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!health.claudeAvailable && (
          <div className="border-b border-line bg-accent-soft px-4 py-2 text-body text-danger">
            {t('app.claudeMissing')}
          </div>
        )}
        {project ? (
          <>
            <BoardHeader
              project={project} health={health} view={view} onView={setView}
              query={query} onQuery={setQuery} searchRef={searchRef}
              pendingCount={pendingCount}
              onNewTask={() => setNewTask({ status: 'backlog' })}
              onPending={() => setShowPending(true)}
              onSuggest={() => setShowSuggest(true)}
              onImportIssues={() => setShowIssues(true)}
              onClaudeConfig={() => setShowClaudeConfig(true)}
              onSettings={() => setShowSettings(true)}
              onRerun={() => api.rebootstrap(project.id).then(refreshProjects)}
              onAutoRun={() => api.patchProject(project.id, { autoRun: !project.autoRun }).then(refreshProjects)}
              onChanged={refreshProjects}
            />
            <div className="flex min-h-0 flex-1">
              {view === 'costs' ? (
                <CostsView project={project} tasks={tasks} onOpen={setDetailId} />
              ) : (
              <DndContext sensors={sensors} collisionDetection={closestCorners}
                onDragStart={({ active }) => setActiveId(active.id)}
                onDragCancel={() => setActiveId(null)} onDragEnd={onDragEnd}>
                <div className="flex min-w-0 flex-1 overflow-x-auto">
                  {COLUMNS.filter(c => columns.includes(c.key)).map(col => (
                    <Column key={col.key} col={col} tasks={visible.filter(t => t.status === col.key)}
                      queue={queue} onRun={runTask} onOpen={setDetailId} selectedId={detailId} depsBy={depsBy}
                      defaultModel={project.defaultModel} pending={pending}
                      sort={sorts[col.key] || DEFAULT_SORT} onSort={s => setSort(col.key, s)}
                      onAddTask={col.key !== 'archived' ? () => setNewTask({ status: col.key }) : null}
                      onArchiveAll={col.key === 'done' ? archiveAll : null} />
                  ))}
                </div>
                <DragOverlay>
                  {activeId ? (
                    <CardBody task={tasks.find(t => t.id === activeId)} queue={queue} pending={pending}
                      deps={depsBy.get(activeId)} defaultModel={project.defaultModel} dragging />
                  ) : null}
                </DragOverlay>
              </DndContext>
              )}
              {detail && (
                <TaskDrawer task={detail} project={project} queue={queue}
                  pending={pending.filter(a => a.taskId === detail.id)}
                  deps={depsBy.get(detail.id) || []}
                  onClose={() => setDetailId(null)}
                  onPatch={patch => patchTask(detail.id, patch)}
                  onRun={() => runTask(detail.id)}
                  onDequeue={() => dequeueTask(detail.id)}
                  onEnrich={() => enrichNow(detail.id)}
                  enriching={enriching === detail.id}
                  onDecompose={() => decomposeNow(detail.id)}
                  onKill={() => api.kill(detail.id)}
                  onLog={() => setLogTask(detail.id)}
                  onAnswer={text => api.answerHumanRequest(project.id, detail.id, text)}
                  onDiff={() => setDiffTask(detail)}
                  onArchive={() => api.archiveTask(project.id, detail.id).then(() => setDetailId(null))}
                  onDelete={() => api.deleteTask(project.id, detail.id)
                    .then(() => { setDetailId(null); api.tasks(project.id).then(d => setTasks(d.tasks)) })
                    .catch(e => alert(e.message))}
                  onResolve={aid => api.resolvePending(project.id, aid).then(d => setPending(d.actions))} />
              )}
            </div>
          </>
        ) : (
          <EmptyProjects onAdd={() => setShowAddProject(true)} />
        )}
        <QueueBar queue={queue} tasks={tasks} projects={projects} usage={usage}
          onOpen={(q, withLog) => {
            if (q.projectId && q.projectId !== selectedId) setSelectedId(q.projectId)
            setDetailId(q.taskId)
            setLogTask(withLog ? q.taskId : null)
          }}
          onKill={tid => api.kill(tid).then(() => api.queue().then(setQueue))}
          onReorder={ids => api.reorderQueue(ids).then(setQueue)}
          onDequeue={dequeueTask}
          onPause={until => api.pauseRuns(until).then(setQueue).catch(e => alert(e.message))}
          onResume={() => api.resumeRuns().then(setQueue).catch(e => alert(e.message))} />
      </main>

      {showAddProject && (
        <AddProjectModal onClose={() => setShowAddProject(false)}
          onAdd={(name, path, description) => api.addProject(name, path, description)
            .then(d => { setShowAddProject(false); refreshProjects(); setSelectedId(d.project.id) })
            .catch(e => alert(e.message))} />
      )}
      {newTask && project && (
        <TaskModal projectId={project.id} onClose={() => setNewTask(null)}
          onSave={data => api.addTask(project.id, { ...data, status: newTask.status })
            .then(() => { setNewTask(null); api.tasks(project.id).then(d => setTasks(d.tasks)) })
            .catch(e => alert(e.message))} />
      )}
      {diffTask && project && (
        <DiffDrawer projectId={project.id} task={diffTask} onClose={() => setDiffTask(null)}
          onResolved={(kind, res) => {
            setDiffTask(null)
            if (kind === 'approve' && res.pushError) alert(t('app.mergedPushFailed', { error: res.pushError }))
            api.tasks(project.id).then(d => setTasks(d.tasks))
            refreshProjects()
          }} />
      )}
      {logTask && project && (
        <LogDrawer projectId={project.id} taskId={logTask} events={logs[logTask] || []} onClose={() => setLogTask(null)}
          active={queue.actives?.some(a => a.taskId === logTask)} onKill={() => api.kill(logTask)} />
      )}
      {showSuggest && project && (
        <SuggestModal project={project} onClose={() => setShowSuggest(false)}
          onCreated={() => { setShowSuggest(false); api.tasks(project.id).then(d => setTasks(d.tasks)) }} />
      )}
      {showIssues && project && (
        <ImportIssuesModal project={project} onClose={() => setShowIssues(false)}
          onImported={() => { setShowIssues(false); api.tasks(project.id).then(d => setTasks(d.tasks)) }} />
      )}
      {showPending && project && (
        <PendingPanel actions={pending} onClose={() => setShowPending(false)}
          onResolve={aid => api.resolvePending(project.id, aid).then(d => setPending(d.actions))} />
      )}
      {showClaudeConfig && project && (
        <ClaudeConfigModal project={project} onClose={() => setShowClaudeConfig(false)} />
      )}
      {showGlobalSettings && (
        <GlobalSettingsModal onClose={() => setShowGlobalSettings(false)}
          queue={queue} onConcurrency={max => api.setConcurrency(max).then(setQueue)}
          notifyOn={notifyOn} onNotify={setNotifyEnabled}
          soundOn={soundOn} onSound={setSoundEnabled}
          soundMap={soundMap} onSoundFor={setSoundFor}
          theme={theme} onTheme={setThemePref}
          lang={lang} onLang={setLangPref} />
      )}
      {showSettings && project && (
        <SettingsModal project={project} onClose={() => setShowSettings(false)}
          onPatch={patch => api.patchProject(project.id, patch).then(refreshProjects).catch(e => { alert(e.message); refreshProjects() })}
          onRemove={uninstall => {
            api.removeProject(project.id, uninstall).then(() => { setShowSettings(false); setSelectedId(null); refreshProjects() })
          }} />
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- primitivos */

const Btn = ({ variant = 'ghost', className = '', ...props }) => {
  const base = 'rounded-[6px] px-3 py-1.5 text-body disabled:opacity-40'
  const styles = {
    primary: 'bg-accent font-medium text-white hover:bg-accent-hover',
    ghost: 'border border-line text-ink-2 hover:bg-hover',
    quiet: 'text-ink-2 hover:bg-hover',
    danger: 'border border-line text-danger hover:bg-hover',
  }
  return <button {...props} className={`${base} ${styles[variant]} ${className}`} />
}

const Chip = ({ children, className = '', ...props }) => {
  const Tag = props.onClick ? 'button' : 'span'
  return (
    <Tag {...props} className={`inline-flex items-center gap-1.5 rounded-[6px] bg-chip px-2 py-0.5 text-meta text-chip-ink ${props.onClick ? 'hover:bg-line' : ''} ${className}`}>
      {children}
    </Tag>
  )
}

const Dot = ({ className = '', style }) => <span style={style} className={`size-2 shrink-0 rounded-full ${className}`} />

const TagChip = ({ tag }) => (
  <Chip><Dot style={{ background: `hsl(${tagHue(tag)} 65% 55%)` }} />{tag}</Chip>
)

const Segmented = ({ value, onChange, options }) => (
  <div className="flex items-center gap-0.5 rounded-[6px] bg-subtle p-0.5">
    {options.map(o => (
      <button key={o.key} onClick={() => onChange(o.key)}
        className={`rounded-[4px] px-2.5 py-1 text-meta ${value === o.key ? 'border border-line bg-bg text-ink' : 'text-ink-2 hover:text-ink'}`}>
        {o.label}
      </button>
    ))}
  </div>
)

function Menu({ items, label = '···' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(v => !v)} title={t('menu.more')}
        className="rounded-[6px] px-2 py-1 text-ink-2 hover:bg-hover">{label}</button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-60 rounded-[8px] border border-line bg-bg py-1">
          {items.filter(Boolean).map(it => (
            <button key={it.label} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick() }}
              className={`block w-full px-3 py-1.5 text-left text-body hover:bg-hover disabled:opacity-40 ${it.danger ? 'text-danger' : 'text-ink-2'}`}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------------- rail */

const RAIL_KEY = 'ck.rail.expanded'

// Default é colapsado: o rail só mostra as iniciais. A preferência de expansão
// é de UI, então vive no localStorage (mesma política do sort das colunas).
function useRailExpanded() {
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  const toggle = () => setExpanded(v => {
    try { localStorage.setItem(RAIL_KEY, v ? '0' : '1') } catch { /* storage indisponível */ }
    return !v
  })
  return [expanded, toggle]
}

// O rail tem overflow-y, o que recorta um tooltip absoluto — daí o position: fixed
// ancorado no rect do gatilho.
function HoverTip({ label, disabled, children, className }) {
  const [rect, setRect] = useState(null)
  const show = e => !disabled && setRect(e.currentTarget.getBoundingClientRect())
  return (
    <div className={`relative ${className || ''}`}
      onMouseEnter={show} onMouseLeave={() => setRect(null)} onFocus={show} onBlur={() => setRect(null)}>
      {children}
      {rect && (
        <div role="tooltip" style={{ position: 'fixed', left: rect.right + 8, top: rect.top + rect.height / 2 }}
          className="pointer-events-none z-50 -translate-y-1/2 whitespace-nowrap rounded-[6px] border border-line bg-ink px-2 py-1 text-meta text-bg">
          {label}
        </div>
      )}
    </div>
  )
}

function Rail({ projects, selectedId, onSelect, onAdd, onRemove, onSettings, queue, usage }) {
  const [expanded, toggle] = useRailExpanded()
  return (
    <aside style={{ width: expanded ? 'var(--rail-w-open)' : 'var(--rail-w)' }}
      className={`flex shrink-0 flex-col gap-2 border-r border-line py-3 ${expanded ? 'items-stretch px-2' : 'items-center'}`}>
      <div className={`flex items-center gap-2 ${expanded ? 'justify-between px-1' : 'flex-col'}`}>
        <span title="claude-kanban"
          className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-accent text-meta font-bold text-white">K</span>
        <button onClick={toggle} aria-expanded={expanded}
          title={expanded ? t('rail.collapse') : t('rail.expand')}
          className="rounded-[6px] p-1.5 text-muted hover:bg-hover hover:text-ink-2">{expanded ? '«' : '»'}</button>
      </div>
      <div className={`mt-2 flex flex-1 flex-col gap-2 overflow-y-auto ${expanded ? '' : 'items-center'}`}>
        {projects.map(p => {
          const running = queue.actives?.some(a => a.projectId === p.id)
          return (
            <HoverTip key={p.id} label={p.name} disabled={expanded} className="group">
              <button onClick={() => onSelect(p.id)}
                className={`flex w-full items-center gap-2 rounded-[8px] ${expanded ? 'px-1.5 py-1 hover:bg-hover' : 'justify-center'} ${p.id === selectedId ? (expanded ? 'bg-hover' : '') : ''}`}>
                <span
                  className={`relative flex size-9 shrink-0 items-center justify-center rounded-[8px] text-meta font-semibold ${p.id === selectedId ? 'ring-2 ring-accent' : ''}`}
                  style={{ background: avatarBg(p.name), color: avatarInk(p.name) }}>
                  {initials(p.name)}
                  {!p.available && <span title={t('rail.dirUnavailable')} className="absolute -left-1 -top-1 text-danger">!</span>}
                  {p.pendingCount > 0 && (
                    <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-warning px-1 text-[10px] font-semibold leading-4 text-white">{p.pendingCount}</span>
                  )}
                  {running && <Dot className="absolute -bottom-0.5 -right-0.5 animate-pulse bg-st-doing" />}
                </span>
                {expanded && (
                  <span className={`truncate text-body ${p.id === selectedId ? 'font-semibold text-ink' : 'text-ink-2'}`}>{p.name}</span>
                )}
              </button>
              {expanded && (
                <button onClick={() => onRemove(p)} title={t('rail.removeProject')}
                  aria-label={t('rail.removeProject')}
                  className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded-[6px] px-1.5 py-0.5 text-muted hover:bg-hover hover:text-danger group-hover:block">×</button>
              )}
            </HoverTip>
          )
        })}
        <HoverTip label={t('rail.addProject')} disabled={expanded}>
          <button onClick={onAdd}
            className={`flex items-center gap-2 rounded-[8px] text-muted hover:bg-hover hover:text-ink-2 ${expanded ? 'w-full px-1.5 py-1' : 'size-9 justify-center border border-dashed border-line-strong'}`}>
            <span className={expanded ? 'flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-dashed border-line-strong' : ''}>+</span>
            {expanded && <span className="truncate text-body">{t('rail.addProject')}</span>}
          </button>
        </HoverTip>
      </div>
      <QueueIndicator queue={queue} />
      <button onClick={onSettings} title={t('rail.globalSettings')}
        className={`rounded-[6px] p-1.5 text-muted hover:bg-hover hover:text-ink-2 ${expanded ? 'flex items-center gap-2 text-left' : ''}`}>
        <span>⚙</span>
        {expanded && <span className="text-body">{t('rail.globalSettingsShort')}</span>}
      </button>
      <UsageRail usage={usage} />
    </aside>
  )
}

function QueueIndicator({ queue }) {
  const actives = queue.actives?.length || 0
  const waiting = queue.queue?.length || 0
  if (!actives && !waiting) return null
  return (
    <div title={t('rail.queueTip', { actives, waiting })}
      className="flex flex-col items-center gap-0.5 text-[10px] text-muted">
      <Dot className="animate-pulse bg-st-doing" />
      <span className="font-mono">{actives}/{actives + waiting}</span>
    </div>
  )
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_RETRY = { maxAttempts: 3, backoffMinutes: 0 }

const USAGE_LABEL = {
  session: 'usage.session',
  weekly_all: 'usage.weekly',
  weekly_scoped: 'usage.weekly', // recebe o nome do modelo via scope
}

function usageResetLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return t('usage.resetsAt', { time })
  return t('usage.resetsOn', { day: d.toLocaleDateString(locale(), { weekday: 'short' }), time })
}

// "reseta em 2h 13min" — mais acionável que a hora absoluta quando o reset está perto.
function usageResetIn(iso) {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return t('usage.resetsAnyMoment')
  const mins = Math.round(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d) return t('usage.inDaysHours', { d, h })
  if (h) return t('usage.inHoursMinutes', { h, m })
  return t('usage.inMinutes', { m })
}

function usageBarColor(l) {
  const pct = usagePct(l)
  return pct >= 90 || (l.severity && l.severity !== 'normal') ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-success'
}

const usagePct = l => Math.min(100, Math.max(0, l?.percent ?? 0))
const usageName = l => `${USAGE_LABEL[l.kind] ? t(USAGE_LABEL[l.kind]) : l.kind}${l.model ? ` · ${l.model}` : ''}`

// Um único poll do uso no App: o rail mostra o consumo e a QueueBar usa o mesmo
// dado para sugerir a pausa global quando o limite fica crítico.
function useUsage() {
  const [usage, setUsage] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => api.usage().then(d => { if (alive) setUsage(d) }).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return usage
}

// Limite em situação crítica: o próprio backend do Claude marca severity != normal;
// o corte por percentual cobre o caso de a API não mandar severity.
export function criticalLimit(usage) {
  if (!usage?.available) return null
  return (usage.limits || []).find(l => usagePct(l) >= 90 || (l.severity && l.severity !== 'normal')) || null
}

// No rail cabe só o essencial: a sessão de 5h, que é a janela que de fato
// limita o trabalho do dia. Os limites semanais vivem no popover.
function UsageRail({ usage }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!usage?.available || !usage.limits?.length) return null
  // Sem sessão (janela ainda não aberta), cai no limite mais crítico pra não sumir com o rail.
  const session = usage.limits.find(l => l.kind === 'session')
    || usage.limits.reduce((a, b) => usagePct(b) > usagePct(a) ? b : a)
  const pct = usagePct(session)

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(v => !v)} title={t('usage.tip', { name: usageName(session), pct })}
        className="flex w-8 flex-col items-center gap-1 rounded-[6px] pb-1 pt-1 hover:bg-hover">
        <div className="h-1 w-full overflow-hidden rounded-full bg-line">
          <div className={`h-full ${usageBarColor(session)}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="font-mono text-[10px] text-muted">{pct}%</span>
      </button>
      {open && (
        <div className="absolute bottom-0 left-full z-30 ml-2 w-72 rounded-[8px] border border-line bg-bg p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-meta font-semibold text-ink">{t('usage.title')}</h3>
            <button onClick={() => setOpen(false)} className="text-muted hover:text-ink">✕</button>
          </div>
          <div className="flex flex-col gap-3">
            {usage.limits.map((l, i) => (
              <div key={`${l.kind}-${l.model || i}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-body text-ink-2">{usageName(l)}</span>
                  <span className="font-mono text-meta text-ink">{usagePct(l)}%</span>
                </div>
                <div className="my-1 h-1 overflow-hidden rounded-full bg-line">
                  <div className={`h-full ${usageBarColor(l)}`} style={{ width: `${usagePct(l)}%` }} />
                </div>
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted">
                  <span>{usageResetLabel(l.resetsAt)}</span>
                  <span>{usageResetIn(l.resetsAt)}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-line pt-2 text-[10px] text-muted">
            {t('usage.footnote')}
          </p>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------- header */

function BoardHeader({ project, health, view, onView, query, onQuery, searchRef, pendingCount,
  onNewTask, onPending, onSuggest, onImportIssues, onClaudeConfig, onSettings, onRerun, onAutoRun, onChanged }) {
  return (
    <header className="border-b border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <h1 className="text-title font-semibold">{project.name}</h1>
        <BootstrapBadge project={project} onRerun={onRerun} />
        <BranchSelector project={project} onChanged={onChanged} />
        {project.skipPermissions && <Chip className="text-danger">skip-permissions</Chip>}
        <div className="flex-1" />
        <DevServerButton project={project} onChanged={onChanged} />
        <button onClick={onSettings} title={t('header.projectSettings')}
          className="rounded-[6px] border border-line px-3 py-1.5 text-body text-ink-2 hover:bg-hover">
          {t('header.config')}
        </button>
        <Menu items={[
          { label: t('header.rerunBootstrap'), onClick: onRerun },
          { label: t('header.claudeConfig'), onClick: onClaudeConfig },
          { label: t('header.suggest'), onClick: onSuggest, disabled: !health.claudeAvailable },
          { label: t('header.importIssues'), onClick: onImportIssues },
        ]} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Segmented value={view} onChange={onView} options={viewOptions()} />
        <input ref={searchRef} value={query} onChange={e => onQuery(e.target.value)}
          placeholder={t('header.search')}
          className="w-64 rounded-[6px] border border-transparent bg-subtle px-3 py-1.5 text-body outline-none placeholder:text-muted focus:border-line focus:bg-bg" />
        <div className="flex-1" />
        <QueuePauseButton project={project} onChanged={onChanged} />
        <button onClick={onAutoRun}
          title={t('header.autoPilotTip')}
          className={`rounded-[6px] border px-3 py-1.5 text-body ${project.autoRun ? 'border-line bg-subtle text-ink' : 'border-line text-ink-2 hover:bg-hover'}`}>
          {project.autoRun ? <Dot className="mr-1.5 inline-block bg-success" /> : null}
          {project.autoRun ? t('header.autoPilotOn') : t('header.autoPilotOff')}
        </button>
        <Btn onClick={onPending} className={pendingCount ? 'border-warning text-warning' : ''}>
          {t('header.pendingActions')}{pendingCount ? ` (${pendingCount})` : ''}
        </Btn>
        <Btn variant="primary" onClick={onNewTask}>{t('header.newTask')}</Btn>
      </div>
    </header>
  )
}

function DevServerButton({ project, onChanged }) {
  const [busy, setBusy] = useState(false)
  const running = !!project.devServerRunning
  const configured = !!project.devServer?.command
  const launch = () => {
    if (!configured) { alert(t('devserver.configure')); return }
    setBusy(true)
    api.launchDevServer(project.id).then(onChanged).catch(e => alert(e.message)).finally(() => setBusy(false))
  }
  const stop = () => {
    setBusy(true)
    api.stopDevServer(project.id).then(onChanged).catch(e => alert(e.message)).finally(() => setBusy(false))
  }
  return (
    <div className="flex items-center overflow-hidden rounded-[6px] border border-line">
      <button onClick={launch} disabled={busy}
        title={configured ? project.devServer.command : t('devserver.configureTip')}
        className="px-3 py-1.5 text-body text-ink-2 hover:bg-hover disabled:opacity-40">
        {running && <Dot className="mr-1.5 inline-block animate-pulse bg-success" />}
        {t('devserver.label')}
      </button>
      {running && (
        <button onClick={stop} disabled={busy} title={t('devserver.stop')}
          className="border-l border-line px-2 py-1.5 text-body text-danger hover:bg-hover disabled:opacity-40">✕</button>
      )}
    </div>
  )
}

function BranchSelector({ project, onChanged }) {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!project.branch) return null // não é repo git

  const load = doFetch => {
    setBranches(b => doFetch ? b : null)
    api.branches(project.id, doFetch)
      .then(d => { setBranches(d.branches); if (d.fetchError) alert(t('branch.fetchFailed', { error: d.fetchError })) })
      .catch(() => setBranches([]))
  }

  const toggle = () => {
    if (open) { setOpen(false); return }
    setOpen(true); load(false)
  }

  const switchTo = (name, stash = false) => {
    if (name === project.branch) { setOpen(false); return }
    setBusy(true)
    api.checkoutBranch(project.id, name, stash)
      .then(res => { setOpen(false); if (res.stashed) alert(t('branch.stashed')); onChanged() })
      .catch(e => {
        if (e.canStash && confirm(t('branch.confirmStash'))) {
          switchTo(name, true); return
        }
        alert(e.message)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="relative" ref={ref}>
      <button title={t('branch.currentTip')} onClick={toggle} disabled={busy}
        className="flex items-center gap-1 rounded-[6px] bg-chip px-2 py-0.5 text-meta text-chip-ink hover:bg-line disabled:opacity-40">
        <span className="text-muted">⑃</span>
        <span className="max-w-[16rem] truncate font-mono">{project.branch}</span>
        <span className="text-muted">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-64 rounded-[8px] border border-line bg-bg">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <span className="text-meta text-muted">{t('branch.listTitle')}</span>
            <button onClick={() => load(true)} disabled={busy}
              title={t('branch.fetchTip')}
              className="rounded px-1.5 py-0.5 text-meta text-ink-2 hover:bg-hover disabled:opacity-40">{t('branch.fetch')}</button>
          </div>
          <div className="max-h-72 overflow-auto py-1">
            {branches === null && <div className="px-3 py-1.5 text-meta text-muted">{t('branch.loading')}</div>}
            {branches?.length === 0 && <div className="px-3 py-1.5 text-meta text-muted">{t('branch.empty')}</div>}
            {branches?.map(b => (
              <button key={b.name} onClick={() => switchTo(b.name)} disabled={busy}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta hover:bg-hover disabled:opacity-40 ${b.current ? 'text-accent' : 'text-ink-2'}`}>
                <span className="w-3">{b.current ? '✓' : ''}</span>
                <span className="flex-1 truncate font-mono">{b.name}</span>
                {b.remote && <span className="rounded bg-chip px-1 text-[10px] text-muted">{t('branch.remote')}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function BootstrapBadge({ project, onRerun }) {
  const map = {
    ok: ['text-success', t('bootstrap.ok')],
    outdated: ['text-warning', t('bootstrap.outdated')],
    failed: ['text-danger', project.bootstrapError || t('bootstrap.failed')],
    missing: ['text-muted', t('bootstrap.missing')],
    unknown: ['text-muted', t('bootstrap.unknown')],
  }
  const [cls, title] = map[project.bootstrap] || map.unknown
  return (
    <button title={title} onClick={project.bootstrap !== 'ok' ? onRerun : undefined}
      className={`rounded-[6px] bg-chip px-2 py-0.5 text-meta ${cls}`}>
      {project.bootstrap === 'ok' ? t('bootstrap.badgeOk') : t('bootstrap.badge', { state: project.bootstrap })}
    </button>
  )
}

/* ------------------------------------------------------------------ colunas */

function SortMenu({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const current = SORT_OPTIONS.find(o => o.key === value) || SORT_OPTIONS[0]
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(v => !v)} title={t('sortMenu.tip', { label: t(`sort.${current.key}`) })}
        className="rounded-[4px] px-1.5 text-meta text-muted hover:bg-hover hover:text-ink-2">⇅</button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-48 rounded-[8px] border border-line bg-bg py-1">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">{t('sortMenu.title')}</div>
          {SORT_OPTIONS.map(o => (
            <button key={o.key} onClick={() => { onChange(o.key); setOpen(false) }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta hover:bg-hover ${o.key === value ? 'text-accent' : 'text-ink-2'}`}>
              <span className="w-3">{o.key === value ? '✓' : ''}</span>
              <span className="flex-1">{t(`sort.${o.key}`)}</span>
              {o.key === DEFAULT_SORT && <span className="text-[10px] text-muted">{t('sortMenu.default')}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Column({ col, tasks, queue, onRun, onOpen, onAddTask, selectedId, pending, defaultModel, sort, onSort, onArchiveAll, depsBy }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.key })
  const ordered = useMemo(() => sortTasks(tasks, sort), [tasks, sort])
  const [archiving, setArchiving] = useState(false)
  const archiveAll = () => {
    if (!confirm(t('column.confirmArchiveAll', { n: tasks.length, column: columnLabel(col.key) }))) return
    setArchiving(true)
    Promise.resolve(onArchiveAll(ordered.map(t => t.id))).finally(() => setArchiving(false))
  }
  return (
    <div ref={setNodeRef} data-column={col.key}
      className={`flex w-[var(--col-min-w)] shrink-0 flex-col border-r border-line ${isOver ? 'border-t-2 border-t-accent' : 'border-t-2 border-t-transparent'}`}>
      <div className="flex items-center gap-2 px-4 py-3">
        <Dot className={col.dot} />
        <span className="text-body font-medium">{columnLabel(col.key)}</span>
        <span className="text-meta text-muted">{tasks.length}</span>
        <div className="flex-1" />
        <SortMenu value={sort} onChange={onSort} />
        {onArchiveAll && tasks.length > 0 && (
          <button onClick={archiveAll} disabled={archiving}
            title={t('column.archiveAllTip', { column: columnLabel(col.key) })}
            className="rounded-[4px] px-1.5 text-meta text-ink-2 hover:bg-hover disabled:opacity-50">
            {archiving ? t('column.archiving') : t('column.archiveAll')}
          </button>
        )}
        {onAddTask && (
          <button onClick={onAddTask} title={t('column.newTaskIn', { column: columnLabel(col.key) })}
            className="rounded-[4px] px-1.5 text-ink-2 hover:bg-hover">+</button>
        )}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-4">
        {ordered.map(t => (
          <Card key={t.id} task={t} queue={queue} onRun={onRun} onOpen={onOpen}
            selected={t.id === selectedId} defaultModel={defaultModel} pending={pending} deps={depsBy?.get(t.id)} />
        ))}
        {tasks.length === 0 && (
          onAddTask ? (
            <button onClick={onAddTask} title={t('column.newTaskIn', { column: columnLabel(col.key) })}
              className="w-full rounded-[8px] border border-dashed border-line px-3 py-6 text-center text-meta text-muted hover:border-accent hover:text-ink-2">
              {t('column.emptyHint')}
            </button>
          ) : (
            <div className="rounded-[8px] border border-dashed border-line px-3 py-6 text-center text-meta text-muted">
              {t('column.emptyArchived')}
            </div>
          )
        )}
      </div>
    </div>
  )
}

function Card(props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: props.task.id })
  // Enquanto arrasta, o card real fica invisível; o clone renderiza no DragOverlay (fora do overflow).
  return (
    <CardBody {...props} innerRef={setNodeRef} handleProps={{ ...attributes, ...listeners }}
      hidden={isDragging} />
  )
}

function CardBody({ task, queue, onRun, onOpen, selected, defaultModel, pending = [], deps = [], innerRef, handleProps, hidden, dragging }) {
  const waiting = deps.filter(d => !d.done)
  const running = queue.actives?.some(a => a.taskId === task.id)
  const queued = queue.queue?.some(q => q.taskId === task.id)
  const desc = section(task.body, 'Descrição')
  const prio = PRIORITY[task.priority] || PRIORITY.medium
  const openPending = pending.filter(a => a.taskId === task.id && a.status === 'pending').length
  // O card inteiro é a área de drag; só é clique (abre o drawer) se o ponteiro
  // mal se moveu — senão todo drop abriria o detalhe.
  const down = useRef(null)
  const onPointerUp = e => {
    const p = down.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) onOpen?.(task.id)
    down.current = null
  }

  return (
    <div ref={innerRef} {...handleProps}
      onPointerDown={e => { down.current = { x: e.clientX, y: e.clientY }; handleProps?.onPointerDown?.(e) }}
      onPointerUp={onPointerUp}
      className={`rounded-[8px] bg-bg p-3.5 text-body ${selected ? 'border-2 border-accent p-[13px]' : 'border border-line'} ${hidden ? 'opacity-0' : ''} ${dragging ? 'cursor-grabbing' : 'cursor-grab hover:bg-hover'}`}>
      <div className="font-mono text-key uppercase text-muted">{task.id}</div>
      <div className="mt-1 line-clamp-2 text-card font-semibold leading-snug">{task.title}</div>
      {desc && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-body text-ink-2">{desc}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span title={prioLabel(task.priority)} className={`text-body ${prio.cls}`}>{prio.arrow}</span>
        {(task.tags || []).filter(t => t !== HUMAN_REQUEST_TAG).map(tag => <TagChip key={tag} tag={tag} />)}
        {(task.tags || []).includes(HUMAN_REQUEST_TAG) && (
          <Chip className="text-warning" title={t('card.humanRequestTip')}>
            {t('card.humanRequest')}
          </Chip>
        )}
        <div className="flex-1" />
        {isFuture(task.scheduled_at) && (
          <Chip className="text-info" title={t('card.scheduledFor', { when: new Date(task.scheduled_at).toLocaleString(locale()) })}>
            ⏱ {fmtWhen(task.scheduled_at)}
          </Chip>
        )}
        {waiting.length > 0 && !running && (
          <Chip className="text-warning"
            title={t('card.waitingTip', { deps: waiting.map(d => `${d.id} — ${d.title}`).join(', ') })}>
            {tn('card.waitingDeps', waiting.length)}
          </Chip>
        )}
        {queued && <Chip className="text-info">{t('card.queued')}</Chip>}
        {task.decompose === true && <Chip title={t('card.decomposeTip')}>{t('card.decompose')}</Chip>}
        {task.model && task.model !== defaultModel && (
          <Chip className="font-mono" title={t('card.modelTip', { model: modelLabel(task.model) })}>{task.model}</Chip>
        )}
      </div>

      <RunStrip task={task} running={running} openPending={openPending}
        onRun={onRun ? () => onRun(task.id) : null} />
    </div>
  )
}

// Assinatura da UI: bloco inset com o estado do run — vivo enquanto executa,
// pós-mortem quando termina.
function RunStrip({ task, running, openPending, onRun }) {
  const run = task.run || {}
  const idle = !running && !run.completed_at && !run.started_at
  if (idle) {
    if (!onRun || !['backlog', 'todo'].includes(task.status)) return null
    return (
      <button onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onRun() }}
        className="mt-3 w-full rounded-[6px] bg-subtle px-2.5 py-1.5 text-left text-meta text-ink-2 hover:bg-hover">
        {t('run.execute')}
      </button>
    )
  }
  const failed = !running && run.exit_code != null && run.exit_code !== 0
  return (
    <div className="mt-3 rounded-[6px] bg-subtle px-2.5 py-2 text-meta">
      {openPending > 0 && (
        <div className="mb-1.5 border-b border-warning/60 pb-1.5 text-warning">
          {tn('run.pendingActions', openPending)}
        </div>
      )}
      {running ? (
        <div className="flex items-center gap-2 text-ink-2">
          <span className="flex gap-0.5">
            {[0, 1, 2].map(i => <Dot key={i} className="ck-dot size-1.5 bg-st-doing" />)}
          </span>
          <span>{t('run.running')}</span>
          <LiveTimer since={run.started_at} />
          {run.cost_usd != null && <span className="font-mono">· {fmtCost(run.cost_usd)}</span>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-1.5 text-ink-2">
          <Dot className={`size-1.5 ${failed ? 'bg-danger' : 'bg-success'}`} />
          <span>{failed ? t('run.exit', { code: run.exit_code }) : t('run.finished')}</span>
          {run.completed_at && <span className="text-muted">· {ago(run.completed_at)}</span>}
          {run.cost_usd != null && <span className="font-mono text-muted">· {fmtCost(run.cost_usd)}</span>}
          {run.duration_ms != null && <span className="text-muted">· {fmtDur(run.duration_ms)}</span>}
          {run.num_turns != null && <span className="text-muted">· {t('run.turns', { n: run.num_turns })}</span>}
          {(run.attempts ?? 0) > 1 && <span className="text-muted">· {t('run.attempts', { n: run.attempts })}</span>}
        </div>
      )}
      {run.branch && (
        <div className="mt-1 truncate font-mono text-[11px] text-muted">{run.branch}{run.has_diff ? ' · diff' : ''}</div>
      )}
      {run.pr?.url && (
        <a href={run.pr.url} target="_blank" rel="noreferrer"
          onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
          className="mt-1.5 inline-block text-meta text-accent hover:underline">
          {t('run.viewPR')}{run.pr.number ? ` #${run.pr.number}` : ''} ↗
        </a>
      )}
    </div>
  )
}

function LiveTimer({ since }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  if (!since) return null
  return <span className="font-mono">· {fmtDur(Date.now() - new Date(since).getTime())}</span>
}

/* ------------------------------------------------------- drawer de detalhe */

function Section({ title, badge, action, children }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="border-t border-line py-3">
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen(v => !v)}
          className="flex flex-1 items-center gap-1.5 text-left text-meta font-semibold uppercase tracking-wide text-muted hover:text-ink-2">
          <span>{open ? '▾' : '▸'}</span>{title}
          {badge ? <span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold text-white">{badge}</span> : null}
        </button>
        {action}
      </div>
      {open && <div className="mt-2.5">{children}</div>}
    </section>
  )
}

const Empty = ({ children }) => <div className="text-body text-muted">{children}</div>

// Resposta à "## Human Request" direto do drawer: grava a resposta na task e a
// devolve para a fila. Havendo sessão anterior, o backend a retoma (--resume) em
// vez de recomeçar do zero.
function HumanResponseForm({ onSubmit, disabled, hasSession }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const send = () => {
    const answer = text.trim()
    if (!answer || sending) return
    setSending(true); setError(null)
    Promise.resolve(onSubmit(answer))
      .then(() => setText(''))
      .catch(e => setError(e.message))
      .finally(() => setSending(false))
  }

  return (
    <div className="mt-2.5 space-y-2">
      <textarea value={text} onChange={e => setText(e.target.value)} disabled={disabled || sending}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
        placeholder={t('humanResponse.placeholder')}
        className="h-24 w-full resize-none rounded-[6px] bg-subtle p-2 text-body outline-none disabled:opacity-40" />
      {error && <div className="text-meta text-danger">{error}</div>}
      <div className="flex items-center gap-2">
        <Btn variant="primary" disabled={disabled || sending || !text.trim()} onClick={send}>
          {sending ? t('humanResponse.sending') : t('humanResponse.submit')}
        </Btn>
        <span className="text-meta text-muted">
          {disabled ? t('humanResponse.disabled')
            : hasSession ? t('humanResponse.resume')
            : t('humanResponse.fresh')}
        </span>
      </div>
    </div>
  )
}

function TaskDrawer({ task, project, queue, pending, deps = [], onClose, onPatch, onRun, onDequeue, onDecompose, onKill, onLog, onAnswer, onDiff, onArchive, onDelete, onResolve, onEnrich, enriching }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState(task.body ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => { setTitle(task.title); setBody(task.body ?? ''); setEditing(false); setConfirmDelete(false) }, [task.id])

  const running = queue.actives?.some(a => a.taskId === task.id)
  const queued = queue.queue?.some(q => q.taskId === task.id)
  const run = task.run || {}
  const col = COLUMNS.find(c => c.key === task.status) || COLUMNS[0]
  const prio = PRIORITY[task.priority] || PRIORITY.medium
  const desc = section(body, 'Descrição')
  const result = section(body, 'Resultado')
  const humanRequest = section(body, 'Human Request')
  const openPending = pending.filter(a => a.status === 'pending')

  return (
    <aside className="flex w-[var(--detail-w)] shrink-0 flex-col overflow-y-auto border-l border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-key uppercase text-muted">{task.id}</span>
        <div className="flex-1" />
        <Menu items={[
          // Na fila (ainda não começou): a ação disponível é cancelar, não matar.
          queued
            ? { label: t('drawer.dequeue'), onClick: onDequeue, danger: true }
            : { label: running ? t('drawer.kill') : t('drawer.runNow'), onClick: running ? onKill : onRun },
          { label: enriching ? t('drawer.enriching') : t('drawer.enrich'), onClick: onEnrich, disabled: running || queued || enriching },
          { label: t('drawer.decomposeNow'), onClick: onDecompose, disabled: running || queued },
          { label: t('drawer.viewLog'), onClick: onLog },
          { label: t('drawer.viewDiff'), onClick: onDiff, disabled: !run.has_diff },
          { label: t('drawer.viewPR'), onClick: () => window.open(run.pr.url, '_blank', 'noreferrer'), disabled: !run.pr?.url },
          { label: t('drawer.archive'), onClick: onArchive, danger: true, disabled: task.status === 'archived' },
          { label: t('drawer.delete'), onClick: () => setConfirmDelete(true), danger: true, disabled: running || queued },
        ]} />
        <button onClick={onClose} title={t('drawer.close')} className="rounded-[6px] px-2 py-1 text-muted hover:bg-hover hover:text-ink">✕</button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <select value={task.status} onChange={e => onPatch({ status: e.target.value })}
          className="rounded-[6px] bg-chip px-2 py-1 text-meta text-chip-ink outline-none">
          {COLUMNS.map(c => <option key={c.key} value={c.key}>{columnLabel(c.key)}</option>)}
        </select>
        <select value={task.priority} onChange={e => onPatch({ priority: e.target.value })}
          className={`rounded-[6px] bg-chip px-2 py-1 text-meta outline-none ${prio.cls}`}>
          {Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.arrow} {prioLabel(k)}</option>)}
        </select>
        <select value={task.model || ''} disabled={running || queued}
          onChange={e => onPatch({ model: e.target.value || null })}
          title={t('drawer.modelTip')}
          className="rounded-[6px] bg-chip px-2 py-1 font-mono text-meta text-chip-ink outline-none disabled:opacity-40">
          <option value="">{project.defaultModel ? `↳ ${project.defaultModel}` : t('drawer.modelAuto')}</option>
          {MODELS.map(m => <option key={m.id} value={m.id}>{m.id} ({m.label})</option>)}
        </select>
        <select value={task.decompose === true ? 'on' : task.decompose === false ? 'off' : ''}
          disabled={running || queued}
          onChange={e => onPatch({ decompose: e.target.value === 'on' ? true : e.target.value === 'off' ? false : null })}
          title={t('drawer.decomposeTip')}
          className="rounded-[6px] bg-chip px-2 py-1 text-meta text-chip-ink outline-none disabled:opacity-40">
          <option value="">{t('drawer.decomposeInherit', { mode: t(project.autoDecompose ? 'drawer.decomposeInheritAuto' : 'drawer.decomposeInheritOff') })}</option>
          <option value="on">{t('drawer.decomposeYes')}</option>
          <option value="off">{t('drawer.decomposeNo')}</option>
        </select>
        <select value={task.enrich === true ? 'on' : task.enrich === false ? 'off' : ''}
          disabled={running || queued}
          onChange={e => onPatch({ enrich: e.target.value === 'on' ? true : e.target.value === 'off' ? false : null })}
          title={t('drawer.enrichTip')}
          className="rounded-[6px] bg-chip px-2 py-1 text-meta text-chip-ink outline-none disabled:opacity-40">
          <option value="">{t('drawer.enrichInherit', { mode: enrichLabel(project.enrichMode) })}</option>
          <option value="on">{t('drawer.enrichYes')}</option>
          <option value="off">{t('drawer.enrichNo')}</option>
        </select>
        {(task.tags || []).filter(t => t !== HUMAN_REQUEST_TAG).map(t => <TagChip key={t} tag={t} />)}
        {(task.tags || []).includes(HUMAN_REQUEST_TAG) && <Chip className="text-warning">{t('drawer.awaitingHuman')}</Chip>}
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <input value={title} onChange={e => setTitle(e.target.value)}
            className="w-full rounded-[6px] border border-line px-2 py-1.5 text-card font-semibold outline-none focus:border-accent" />
          <textarea value={body} onChange={e => setBody(e.target.value)} spellCheck={false}
            className="h-64 w-full resize-none rounded-[6px] bg-subtle p-3 font-mono text-body outline-none" />
          <div className="flex justify-end gap-2">
            <Btn variant="quiet" onClick={() => { setTitle(task.title); setBody(task.body ?? ''); setEditing(false) }}>{t('common.cancel')}</Btn>
            <Btn variant="primary" disabled={!title.trim()}
              onClick={() => { onPatch({ title: title.trim(), body }); setEditing(false) }}>{t('common.save')}</Btn>
          </div>
        </div>
      ) : (
        <>
          <h2 className="mt-3 text-[17px] font-semibold leading-snug">{task.title}</h2>
          <div className="mt-1.5 whitespace-pre-wrap text-body text-ink-2">{desc || <Empty>{t('drawer.noDescription')}</Empty>}</div>
          <button onClick={() => setEditing(true)} className="mt-2 self-start text-meta text-accent hover:underline">{t('drawer.edit')}</button>
        </>
      )}

      {confirmDelete && (
        <div className="mt-3 space-y-2 rounded-[8px] border border-danger p-3">
          <div className="text-body text-danger">
            {t('drawer.confirmDelete')}
          </div>
          <div className="flex gap-2">
            <Btn variant="danger" onClick={onDelete}>{t('drawer.deleteForever')}</Btn>
            <Btn variant="quiet" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Btn>
          </div>
        </div>
      )}

      {humanRequest && (
        <div className="mt-3 rounded-[8px] border border-warning p-3">
          <div className="text-meta font-semibold uppercase tracking-wide text-warning">{t('drawer.humanNeeded')}</div>
          <div className="mt-1.5 whitespace-pre-wrap text-body text-ink-2">{humanRequest}</div>
          <HumanResponseForm
            disabled={running || queued}
            hasSession={!!run.session_id}
            onSubmit={onAnswer} />
        </div>
      )}

      <Section title={t('drawer.deps')}>
        {deps.length === 0 ? <Empty>{t('drawer.depsEmpty')}</Empty> : (
          <div className="space-y-1.5">
            {deps.map(d => (
              <div key={d.id} className="flex items-center gap-2 rounded-[6px] border border-line p-2 text-body">
                <Dot className={d.done ? 'bg-success' : 'bg-warning'} />
                <span className="font-mono text-meta text-muted">{d.id}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{d.title}</span>
                <span className="text-meta text-muted">{d.done ? t('drawer.depDone') : d.status}</span>
                <button title={t('drawer.depRemove')}
                  onClick={() => onPatch({ depends_on: deps.filter(x => x.id !== d.id).map(x => x.id) })}
                  className="text-meta text-danger hover:underline">×</button>
              </div>
            ))}
            <div className="text-meta text-muted">
              {t('drawer.depsHint')}
            </div>
          </div>
        )}
      </Section>

      <Section title={t('drawer.schedule')}>
        <SchedulePicker
          value={task.scheduled_at}
          disabled={running || queued || !['backlog', 'todo'].includes(task.status)}
          onChange={iso => onPatch({ scheduled_at: iso })} />
      </Section>

      <Section title={t('drawer.runs')}
        action={running
          ? <button onClick={onKill} className="text-meta text-danger hover:underline">{t('drawer.kill')}</button>
          : queued
            ? <button onClick={onDequeue} className="text-meta text-danger hover:underline">{t('drawer.dequeue')}</button>
            : (run.has_diff || run.pr?.url) ? (
              <span className="flex items-center gap-2">
                {run.pr?.url && (
                  <a href={run.pr.url} target="_blank" rel="noreferrer" className="text-meta text-accent hover:underline">
                    {t('drawer.viewPR')}{run.pr.number ? ` #${run.pr.number}` : ''} ↗
                  </a>
                )}
                {run.has_diff && <button onClick={onDiff} className="text-meta text-accent hover:underline">{t('drawer.viewDiff')}</button>}
              </span>
            ) : null}>
        {!run.started_at && !running ? (
          <Empty>{t('drawer.runsEmpty')}</Empty>
        ) : (
          <div className="rounded-[6px] border border-line p-2.5 text-meta">
            <div className="flex items-center gap-2">
              <Dot className={running ? 'animate-pulse bg-success' : run.exit_code ? 'bg-danger' : 'bg-muted'} />
              <span className="text-ink-2">
                {running ? t('drawer.runActive') : run.exit_code ? t('drawer.runFailed', { code: run.exit_code }) : t('drawer.runDone')}
              </span>
              <div className="flex-1" />
              <button onClick={onLog} className="text-accent hover:underline">
                {running ? t('drawer.viewLiveLog') : t('drawer.viewLog')}
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-2 text-muted">
              {run.duration_ms != null && <span>{fmtDur(run.duration_ms)}</span>}
              {run.cost_usd != null && <span className="font-mono">{fmtCost(run.cost_usd)}</span>}
              {run.num_turns != null && <span>{t('run.turns', { n: run.num_turns })}</span>}
              {(run.attempts ?? 0) > 0 && <span>{t('drawer.attempts', { n: run.attempts })}</span>}
              {run.session_id && <span className="font-mono">{String(run.session_id).slice(0, 8)}</span>}
            </div>
            {run.branch && <div className="mt-1 truncate font-mono text-[11px] text-muted">{run.branch}</div>}
          </div>
        )}
      </Section>

      <Section title={t('drawer.pendingActions')} badge={openPending.length || null}>
        {openPending.length === 0 ? <Empty>{t('drawer.pendingEmpty')}</Empty> : (
          <div className="space-y-2">
            {openPending.map(a => (
              <div key={a.id} className="rounded-[6px] border border-line p-2.5">
                <div className="flex items-start gap-2">
                  <span className="flex-1 text-body text-ink-2">{a.label}</span>
                  <button onClick={() => onResolve(a.id)} className="text-meta text-accent hover:underline">{t('drawer.resolved')}</button>
                </div>
                {a.command && (
                  <code className="mt-1.5 block overflow-x-auto rounded-[4px] bg-subtle p-2 font-mono text-[11px] text-ink-2">{a.command}</code>
                )}
                <div className="mt-1 font-mono text-[11px] text-muted">{a.id}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('drawer.result')}>
        {result
          ? <div className="whitespace-pre-wrap text-body text-ink-2">{result}</div>
          : <Empty>{t('drawer.resultEmpty')}</Empty>}
      </Section>
    </aside>
  )
}

// Agendamento de uma task: quando a hora chegar, o servidor a coloca na fila
// (mesmo com o auto-pilot desligado) e limpa o horário.
function SchedulePicker({ value, disabled, onChange }) {
  const scheduled = isFuture(value)
  const presets = [
    { label: t('schedule.in1h'), at: () => inHours(1) },
    { label: t('schedule.in4h'), at: () => inHours(4) },
    { label: t('schedule.today22'), at: () => nextAt(22) },
    { label: t('schedule.tomorrow9'), at: () => nextAt(9) },
  ]
  return (
    <div className="space-y-2">
      {scheduled ? (
        <div className="flex items-center gap-2 rounded-[6px] border border-line p-2.5 text-meta">
          <Dot className="bg-info" />
          <span className="text-ink-2">{t('schedule.entersQueue', { when: fmtWhen(value) })}</span>
          <div className="flex-1" />
          <button onClick={() => onChange(null)} className="text-meta text-danger hover:underline">{t('common.cancel')}</button>
        </div>
      ) : (
        <Empty>{t('schedule.none')}</Empty>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <input type="datetime-local" disabled={disabled}
          value={toLocalInput(value)}
          onChange={e => onChange(fromLocalInput(e.target.value))}
          className="rounded-[6px] border border-line bg-bg px-2 py-1 text-meta text-ink-2 outline-none focus:border-accent disabled:opacity-40" />
        {presets.map(p => (
          <Chip key={p.label} onClick={disabled ? undefined : () => onChange(p.at())}
            className={disabled ? 'opacity-40' : ''}>{p.label}</Chip>
        ))}
      </div>
      {disabled && <div className="text-meta text-muted">{t('schedule.disabled')}</div>}
    </div>
  )
}

// Adiar a fila inteira do projeto: os itens continuam enfileirados, na ordem,
// mas nenhum sai da fila até a hora marcada.
function QueuePauseButton({ project, onChanged }) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const ref = useRef(null)
  const paused = isFuture(project.queuePausedUntil)

  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const pause = iso => {
    if (!iso) return
    setOpen(false)
    api.pauseQueue(project.id, iso).then(onChanged).catch(e => alert(e.message))
  }
  const resume = () => api.resumeQueue(project.id).then(onChanged).catch(e => alert(e.message))

  const presets = [
    { label: t('queuePause.1h'), at: () => inHours(1) },
    { label: t('queuePause.4h'), at: () => inHours(4) },
    { label: t('queuePause.at22'), at: () => nextAt(22) },
    { label: t('queuePause.tomorrow9'), at: () => nextAt(9) },
  ]

  if (paused) {
    return (
      <div className="flex items-center overflow-hidden rounded-[6px] border border-warning">
        <span className="px-3 py-1.5 text-body text-warning" title={new Date(project.queuePausedUntil).toLocaleString(locale())}>
          {t('queuePause.pausedUntil', { when: fmtWhen(project.queuePausedUntil) })}
        </span>
        <button onClick={resume} title={t('queuePause.resumeTip')}
          className="border-l border-warning px-2 py-1.5 text-body text-warning hover:bg-hover">✕</button>
      </div>
    )
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(v => !v)}
        title={t('queuePause.tip')}
        className="rounded-[6px] border border-line px-3 py-1.5 text-body text-ink-2 hover:bg-hover">
        {t('queuePause.button')}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-64 rounded-[8px] border border-line bg-bg py-1">
          {presets.map(p => (
            <button key={p.label} onClick={() => pause(p.at())}
              className="block w-full px-3 py-1.5 text-left text-body text-ink-2 hover:bg-hover">{p.label}</button>
          ))}
          <div className="flex items-center gap-1.5 border-t border-line px-3 py-2">
            <input type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)}
              className="min-w-0 flex-1 rounded-[6px] border border-line bg-bg px-2 py-1 text-meta text-ink-2 outline-none focus:border-accent" />
            <button onClick={() => pause(fromLocalInput(custom))} disabled={!fromLocalInput(custom)}
              className="text-meta text-accent hover:underline disabled:opacity-40">{t('queuePause.ok')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- modais */

function TaskModal({ projectId, onClose, onSave }) {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState('medium')
  const [tags, setTags] = useState('')
  const [model, setModel] = useState('')
  const [decompose, setDecompose] = useState(false)
  const [description, setDescription] = useState('')
  const [when, setWhen] = useState('')
  const [templates, setTemplates] = useState([])
  const [template, setTemplate] = useState('')

  useEffect(() => { api.templates(projectId).then(d => setTemplates(d.templates)).catch(() => setTemplates([])) }, [projectId])

  // Trocar de template repõe prioridade/tags/descrição a partir dele; as demais
  // seções do template (repro, critérios de aceite...) o backend monta no .md.
  const pickTemplate = id => {
    setTemplate(id)
    const tpl = templates.find(t => t.id === id)
    if (!tpl) return
    if (tpl.priority) setPriority(tpl.priority)
    setTags((tpl.tags || []).join(', '))
    setDescription(section(tpl.body, 'Descrição'))
  }

  return (
    <Modal onClose={onClose} title={t('taskModal.title')}>
      <div className="space-y-3">
        {templates.length > 0 && (
          <select value={template} onChange={e => pickTemplate(e.target.value)}
            title={t('taskModal.templateTip')}
            className="w-full rounded-[6px] border border-line px-2 py-2 text-body outline-none focus:border-accent">
            <option value="">{t('taskModal.noTemplate')}</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.title}{t.description ? ` — ${t.description}` : ''}</option>
            ))}
          </select>
        )}
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder={t('taskModal.titlePlaceholder')}
          className="w-full rounded-[6px] border border-line px-3 py-2 text-body outline-none placeholder:text-muted focus:border-accent" />
        <div className="flex gap-2">
          <select value={priority} onChange={e => setPriority(e.target.value)}
            className="rounded-[6px] border border-line px-2 py-2 text-body outline-none">
            {Object.entries(PRIORITY).map(([k]) => <option key={k} value={k}>{prioLabel(k)}</option>)}
          </select>
          <select value={model} onChange={e => setModel(e.target.value)} title={t('taskModal.modelTip')}
            className="rounded-[6px] border border-line px-2 py-2 text-body outline-none">
            <option value="">{t('taskModal.modelDefault')}</option>
            {MODELS.map(m => <option key={m.id} value={m.id}>{m.id} ({m.label})</option>)}
          </select>
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder={t('taskModal.tagsPlaceholder')}
            className="flex-1 rounded-[6px] border border-line px-3 py-2 text-body outline-none placeholder:text-muted focus:border-accent" />
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)}
            title={t('taskModal.scheduleTip')}
            className="rounded-[6px] border border-line px-2 py-2 text-body text-ink-2 outline-none focus:border-accent" />
        </div>
        <textarea value={description} onChange={e => setDescription(e.target.value)}
          placeholder={t('taskModal.descriptionPlaceholder')} spellCheck={false}
          className="h-56 w-full resize-none rounded-[6px] bg-subtle p-3 font-mono text-body outline-none placeholder:text-muted" />
        <label className="flex items-center gap-2 text-body text-ink-2">
          <input type="checkbox" checked={decompose} onChange={e => setDecompose(e.target.checked)}
            className="accent-[var(--color-accent)]" />
          {t('taskModal.decompose')}
        </label>
        <div className="flex justify-end gap-2">
          <Btn variant="quiet" onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn variant="primary" disabled={!title.trim()}
            onClick={() => onSave({ title, priority, tags: splitTags(tags), model: model || null, decompose: decompose || null, description, scheduled_at: fromLocalInput(when), template: template || null })}>

            {t('taskModal.create')}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
const splitTags = s => s.split(',').map(t => t.trim()).filter(Boolean)

function AddProjectModal({ onClose, onAdd }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [description, setDescription] = useState('')
  return (
    <Modal onClose={onClose} title={t('addProject.title')}>
      <form className="space-y-3"
        onSubmit={e => { e.preventDefault(); if (name && path) onAdd(name, path, description) }}>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t('addProject.namePlaceholder')}
          className="w-full rounded-[6px] border border-line px-3 py-2 text-body outline-none placeholder:text-muted focus:border-accent" />
        <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t('addProject.descriptionPlaceholder')}
          rows={2}
          className="w-full resize-none rounded-[6px] border border-line px-3 py-2 text-body outline-none placeholder:text-muted focus:border-accent" />
        <div className="flex gap-2">
          <input value={path} onChange={e => setPath(e.target.value)} placeholder={t('addProject.pathPlaceholder')}
            className="flex-1 rounded-[6px] border border-line px-3 py-2 font-mono text-body outline-none placeholder:text-muted focus:border-accent" />
          <Btn type="button" onClick={() => api.pickFolder().then(d => { if (d.path) setPath(d.path) }).catch(e => alert(e.message))}>
            {t('addProject.pickFolder')}
          </Btn>
        </div>
        <div className="flex justify-end gap-2">
          <Btn variant="quiet" type="button" onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn variant="primary" type="submit" disabled={!name || !path}>{t('addProject.submit')}</Btn>
        </div>
      </form>
    </Modal>
  )
}

/* -------------------------------------------------------------------- custos */

const periodOptions = () => [
  { key: '7', label: t('period.7') },
  { key: '30', label: t('period.30') },
  { key: '0', label: t('period.all') },
]

// Custos de sessão são centavos: 2 casas escondem a maior parte deles.
export const fmtUsd = v => `$${Number(v || 0).toFixed(Number(v || 0) < 1 ? 3 : 2)}`
export const fmtPct = v => v == null ? '—' : `${Math.round(v * 100)}%`
const fmtDay = d => d.slice(8, 10) + '/' + d.slice(5, 7)

function CostsView({ project, tasks, onOpen }) {
  const [days, setDays] = useState('30')
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)

  // `tasks` muda quando o WebSocket entrega run.finished (o App refaz o fetch das
  // tasks), então o painel se atualiza sozinho ao fim de cada execução.
  useEffect(() => {
    let alive = true
    api.stats(project.id, days)
      .then(d => { if (alive) { setStats(d); setError(null) } })
      .catch(e => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [project.id, days, tasks])

  if (error) return <div className="flex-1 p-6 text-body text-danger">{error}</div>
  if (!stats) return <div className="flex-1 p-6 text-body text-muted">{t('costs.loading')}</div>

  const { totals, byDay, byModel, top } = stats
  const maxDay = Math.max(...byDay.map(d => d.costUsd), 0)

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-2">
        <Segmented value={days} onChange={setDays} options={periodOptions()} />
        <span className="text-meta text-muted">
          {t('costs.ranSummary', { runs: totals.runs, tasks: totals.tasks })}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('costs.total')} value={fmtUsd(totals.costUsd)} />
        <Stat label={t('costs.avg')} value={fmtUsd(totals.avgCostUsd)} />
        <Stat label={t('costs.successRate')} value={fmtPct(totals.successRate)}
          hint={t('costs.successHint', { successes: totals.successes, attempts: totals.attempts })} />
        <Stat label={t('costs.totalTime')} value={fmtDur(totals.durationMs) || '—'}
          hint={t('costs.turnsHint', { n: totals.numTurns })} />
      </div>

      <Panel title={t('costs.byDay')}>
        {byDay.length === 0 ? <Nothing /> : (
          <div className="flex h-40 items-end gap-1.5">
            {byDay.map(d => (
              <div key={d.date} className="flex min-w-0 flex-1 flex-col items-center gap-1"
                title={t('costs.dayTip', { date: d.date, cost: fmtUsd(d.costUsd), runs: d.runs })}>
                <div className="w-full rounded-t-[3px] bg-accent"
                  style={{ height: `${maxDay ? Math.max(2, (d.costUsd / maxDay) * 120) : 2}px` }} />
                <span className="truncate text-meta text-muted">{fmtDay(d.date)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={t('costs.byModel')}>
        {byModel.length === 0 ? <Nothing /> : (
          <table className="w-full text-body">
            <tbody>
              {byModel.map(m => (
                <tr key={m.model} className="border-b border-line last:border-0">
                  <td className="py-1.5 font-mono text-meta">{m.model}</td>
                  <td className="py-1.5 text-right text-meta text-muted">{t('costs.runs', { n: m.runs })}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtUsd(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={t('costs.top')}>
        {top.length === 0 ? <Nothing /> : (
          <table className="w-full text-body">
            <tbody>
              {top.map(row => (
                <tr key={row.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-hover"
                  onClick={() => onOpen(row.id)}>
                  <td className="max-w-0 truncate py-1.5 pr-2">{row.title}</td>
                  <td className="py-1.5 text-right text-meta text-muted">{fmtDur(row.durationMs) || '—'}</td>
                  <td className="py-1.5 text-right text-meta text-muted">
                    {row.exitCode === 0 ? t('costs.ok') : t('costs.exit', { code: row.exitCode ?? '?' })}
                  </td>
                  <td className="py-1.5 pl-2 text-right tabular-nums">{fmtUsd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}

const Stat = ({ label, value, hint }) => (
  <div className="rounded-[8px] border border-line p-3">
    <div className="text-meta text-muted">{label}</div>
    <div className="mt-1 text-title font-semibold tabular-nums">{value}</div>
    {hint && <div className="mt-0.5 text-meta text-muted">{hint}</div>}
  </div>
)

const Panel = ({ title, children }) => (
  <section className="mt-5">
    <h2 className="mb-2 text-body font-medium text-ink-2">{title}</h2>
    <div className="rounded-[8px] border border-line p-3">{children}</div>
  </section>
)

const Nothing = () => <div className="py-3 text-center text-meta text-muted">{t('costs.empty')}</div>

function EmptyProjects({ onAdd }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <div className="text-body text-muted">{t('projects.empty')}</div>
      <Btn variant="primary" onClick={onAdd}>{t('projects.add')}</Btn>
    </div>
  )
}

const SUGGEST_TAG = 'sugerida' // tag fixa em toda task criada via análise, para filtrar no board

function SuggestModal({ project, onClose, onCreated }) {
  const [types, setTypes] = useState(null)          // { key: label }
  const [picked, setPicked] = useState({})          // key -> bool
  const [phase, setPhase] = useState('pick')        // pick | loading | results | creating
  const [suggestions, setSuggestions] = useState([])
  const [selected, setSelected] = useState({})      // index -> bool
  const [costUsd, setCostUsd] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.suggestionTypes().then(d => {
      setTypes(d.types)
      setPicked(Object.fromEntries(Object.keys(d.types).map(k => [k, true])))
    }).catch(e => setError(e.message))
  }, [])

  const pickedKeys = Object.keys(picked).filter(k => picked[k])

  const analyze = () => {
    setPhase('loading'); setError(null)
    api.analyze(project.id, pickedKeys)
      .then(d => {
        setSuggestions(d.suggestions)
        setSelected(Object.fromEntries(d.suggestions.map((_, i) => [i, true])))
        setCostUsd(d.costUsd)
        setPhase('results')
      })
      .catch(e => { setError(e.message); setPhase('pick') })
  }

  const create = async () => {
    setPhase('creating'); setError(null)
    const chosen = suggestions.filter((_, i) => selected[i])
    try {
      for (const s of chosen) {
        await api.addTask(project.id, {
          title: s.title, description: s.description, priority: s.priority,
          tags: [SUGGEST_TAG, s.type], status: 'backlog',
        })
      }
      onCreated()
    } catch (e) { setError(e.message); setPhase('results') }
  }

  const selectedCount = suggestions.filter((_, i) => selected[i]).length

  return (
    <Modal onClose={phase === 'loading' ? () => {} : onClose} title={t('suggest.title', { project: project.name })}>
      {error && <div className="mb-3 rounded-[6px] border border-line px-3 py-2 text-body text-danger">{error}</div>}

      {phase === 'pick' && (
        <div className="space-y-3">
          <div className="text-body text-ink-2">
            {t('suggest.intro')} <Chip>{SUGGEST_TAG}</Chip> {t('suggest.introSuffix')}
          </div>
          {types === null ? (
            <div className="text-body text-muted">{t('suggest.loadingTypes')}</div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(types).map(([key, label]) => (
                <label key={key} className={`flex cursor-pointer items-start gap-2 rounded-[8px] border p-2.5 text-body ${picked[key] ? 'border-accent bg-accent-soft' : 'border-line'}`}>
                  <input type="checkbox" checked={!!picked[key]} className="mt-0.5 accent-[var(--color-accent)]"
                    onChange={e => setPicked(p => ({ ...p, [key]: e.target.checked }))} />
                  <span>
                    <span className="font-medium">{key}</span>
                    <span className="mt-0.5 block text-meta text-muted">{label}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Btn variant="quiet" onClick={onClose}>{t('common.cancel')}</Btn>
            <Btn variant="primary" onClick={analyze} disabled={!pickedKeys.length}>{t('suggest.analyze')}</Btn>
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="flex flex-col items-center gap-3 py-10 text-body text-ink-2">
          <span className="size-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {t('suggest.analyzing')}
        </div>
      )}

      {(phase === 'results' || phase === 'creating') && (
        <div className="space-y-3">
          <div className="flex items-center text-body text-ink-2">
            <span>{t('suggest.count', { n: suggestions.length })}{costUsd != null ? ` · $${Number(costUsd).toFixed(3)}` : ''}</span>
            <div className="flex-1" />
            <button onClick={() => setSelected(Object.fromEntries(suggestions.map((_, i) => [i, selectedCount < suggestions.length])))}
              className="text-meta text-accent hover:underline">
              {selectedCount < suggestions.length ? t('suggest.selectAll') : t('suggest.deselectAll')}
            </button>
          </div>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {suggestions.length === 0 && <Empty>{t('suggest.empty')}</Empty>}
            {suggestions.map((s, i) => (
              <label key={i} className={`flex cursor-pointer items-start gap-3 rounded-[8px] border p-3 text-body ${selected[i] ? 'border-accent' : 'border-line opacity-60'}`}>
                <input type="checkbox" checked={!!selected[i]} className="mt-1 accent-[var(--color-accent)]"
                  onChange={e => setSelected(sel => ({ ...sel, [i]: e.target.checked }))} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{s.title}</span>
                    <span className={`text-body ${(PRIORITY[s.priority] || PRIORITY.medium).cls}`}>{(PRIORITY[s.priority] || PRIORITY.medium).arrow}</span>
                    <Chip>{s.type}</Chip>
                  </span>
                  {s.description && <span className="mt-1 block whitespace-pre-wrap text-meta text-muted">{s.description}</span>}
                </span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Btn variant="quiet" onClick={() => setPhase('pick')} disabled={phase === 'creating'}>{t('suggest.redo')}</Btn>
            <Btn variant="primary" onClick={create} disabled={!selectedCount || phase === 'creating'}>
              {phase === 'creating' ? t('suggest.creating') : t('suggest.create', { n: selectedCount })}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}

const ISSUE_TAG = 'issue' // tag fixa em toda task importada do GitHub (a outra é gh:<n>)

function ImportIssuesModal({ project, onClose, onImported }) {
  const [issues, setIssues] = useState(null)        // null = carregando
  const [selected, setSelected] = useState({})      // number -> bool
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.issues(project.id)
      .then(d => {
        setIssues(d.issues)
        // Já importadas vêm desmarcadas: reimportar não duplica, mas também não faz nada.
        setSelected(Object.fromEntries(d.issues.filter(i => !i.imported).map(i => [i.number, true])))
      })
      .catch(e => { setError(e.message); setIssues([]) })
  }, [project.id])

  const importable = (issues || []).filter(i => !i.imported)
  const selectedNumbers = importable.filter(i => selected[i.number]).map(i => i.number)

  const doImport = () => {
    setImporting(true); setError(null)
    api.importIssues(project.id, selectedNumbers)
      .then(onImported)
      .catch(e => { setError(e.message); setImporting(false) })
  }

  return (
    <Modal onClose={importing ? () => {} : onClose} title={t('issues.title', { project: project.name })}>
      {error && <div className="mb-3 rounded-[6px] border border-line px-3 py-2 text-body text-danger">{error}</div>}

      {issues === null ? (
        <div className="flex flex-col items-center gap-3 py-10 text-body text-ink-2">
          <span className="size-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {t('issues.loading')}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center text-body text-ink-2">
            <span>
              {t('issues.count', { n: issues.length })}{' '}
              <Chip>{ISSUE_TAG}</Chip> + <Chip>gh:&lt;n&gt;</Chip>
            </span>
            <div className="flex-1" />
            {importable.length > 0 && (
              <button onClick={() => setSelected(
                Object.fromEntries(importable.map(i => [i.number, selectedNumbers.length < importable.length])))}
                className="text-meta text-accent hover:underline">
                {selectedNumbers.length < importable.length ? t('issues.selectAll') : t('issues.deselectAll')}
              </button>
            )}
          </div>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {issues.length === 0 && !error && <Empty>{t('issues.empty')}</Empty>}
            {issues.map(i => (
              <label key={i.number}
                className={`flex items-start gap-3 rounded-[8px] border p-3 text-body ${i.imported ? 'cursor-default border-line opacity-50' : `cursor-pointer ${selected[i.number] ? 'border-accent' : 'border-line opacity-60'}`}`}>
                <input type="checkbox" checked={!!selected[i.number] && !i.imported} disabled={i.imported}
                  className="mt-1 accent-[var(--color-accent)]"
                  onChange={e => setSelected(sel => ({ ...sel, [i.number]: e.target.checked }))} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-meta text-muted">#{i.number}</span>
                    <span className="font-medium">{i.title}</span>
                    {i.imported && <Chip>{t('issues.alreadyImported')}</Chip>}
                    {i.labels.map(l => <Chip key={l}>{l}</Chip>)}
                  </span>
                  {i.body && <span className="mt-1 block line-clamp-3 whitespace-pre-wrap text-meta text-muted">{i.body}</span>}
                </span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Btn variant="quiet" onClick={onClose} disabled={importing}>{t('common.cancel')}</Btn>
            <Btn variant="primary" onClick={doImport} disabled={!selectedNumbers.length || importing}>
              {importing ? t('issues.importing') : t('issues.import', { n: selectedNumbers.length })}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------------- drawers */

function LogDrawer({ projectId, taskId, events, onClose, active, onKill }) {
  const [debug, setDebug] = useState(false)
  const [history, setHistory] = useState(null) // null = ainda carregando
  const endRef = useRef(null)
  // Quantos eventos do WS já estavam refletidos no histórico que o servidor
  // devolveu — tudo além disso chegou depois e vai por cima.
  const baseRef = useRef(0)
  const eventsRef = useRef(events)
  eventsRef.current = events

  useEffect(() => {
    let cancelled = false
    setHistory(null)
    api.taskLog(projectId, taskId)
      .then(d => {
        if (cancelled) return
        baseRef.current = eventsRef.current.length
        setHistory(d.events || [])
      })
      .catch(() => { if (!cancelled) { baseRef.current = 0; setHistory([]) } })
    return () => { cancelled = true }
  }, [projectId, taskId])

  const all = history ? [...history, ...events.slice(baseRef.current)] : events
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [all.length])
  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[560px] flex-col border-l border-line bg-bg">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="text-body font-semibold">{t('log.title')} <span className="font-mono uppercase">{taskId}</span></span>
        {active && <Dot className="animate-pulse bg-success" />}
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-meta text-muted">
          <input type="checkbox" checked={debug} onChange={e => setDebug(e.target.checked)} className="accent-[var(--color-accent)]" /> {t('log.rawJson')}
        </label>
        {active && <Btn variant="danger" onClick={onKill}>{t('drawer.kill')}</Btn>}
        <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-4 font-mono text-[12px]">
        {history === null && all.length === 0 && <Empty>{t('log.loading')}</Empty>}
        {history !== null && all.length === 0 && <Empty>{t('log.empty')}</Empty>}
        {all.map((e, i) => <LogEvent key={i} event={e} debug={debug} />)}
        <div ref={endRef} />
      </div>
    </div>
  )
}

function LogEvent({ event, debug }) {
  if (debug) return <pre className="whitespace-pre-wrap break-all text-muted">{JSON.stringify(event)}</pre>
  const deny = JSON.stringify(event).includes('"deny"')
  if (event.type === 'assistant' || event.type === 'user') {
    const content = event.message?.content || []
    return content.map((c, i) => {
      if (c.type === 'text') return <div key={i} className="whitespace-pre-wrap text-ink">{c.text}</div>
      if (c.type === 'tool_use') return <div key={i} className="text-info">⚙ {c.name} {summarize(c.input)}</div>
      if (c.type === 'tool_result') {
        const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
        const isDeny = /permissionDecision.{1,4}deny|blocked|bloquead/i.test(txt)
        return (
          <div key={i} className={`whitespace-pre-wrap ${isDeny ? 'border-l-2 border-danger pl-2 text-danger' : 'text-muted'}`}>
            {txt.slice(0, 400)}
          </div>
        )
      }
      return null
    })
  }
  if (event.type === 'result') {
    return (
      <div className="rounded-[6px] bg-subtle p-2 text-success">
        {t('log.result', { cost: event.total_cost_usd?.toFixed?.(3), seconds: (event.duration_ms / 1000).toFixed(0), turns: event.num_turns })}
      </div>
    )
  }
  if (event.type === 'verify') {
    return (
      <div className={`rounded-[6px] p-2 ${event.ok ? 'bg-subtle text-success' : 'border-l-2 border-danger bg-subtle pl-2 text-danger'}`}>
        <div>{event.ok ? '✓' : '✕'} {t('log.verify')} — <span className="font-mono">{event.command}</span> (exit {event.exitCode})</div>
        {!event.ok && <pre className="mt-1 whitespace-pre-wrap break-all text-ink-2">{event.text}</pre>}
      </div>
    )
  }
  if (event.type === 'system') return <div className="text-muted">[{event.subtype}] {t('log.session')} {event.session_id?.slice(0, 8)}</div>
  return <div className={deny ? 'border-l-2 border-danger pl-2 text-danger' : 'text-muted'}>{JSON.stringify(event).slice(0, 200)}</div>
}
const summarize = input => {
  if (!input) return ''
  const s = input.command || input.file_path || input.pattern || input.prompt || ''
  return String(s).slice(0, 80)
}

function PendingPanel({ actions, onClose, onResolve }) {
  const pend = actions.filter(a => a.status === 'pending')
  const done = actions.filter(a => a.status !== 'pending')
  return (
    <Modal onClose={onClose} title={t('pending.title')}>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        {pend.length === 0 && <Empty>{t('pending.empty')}</Empty>}
        {pend.map(a => (
          <div key={a.id} className="rounded-[8px] border border-line p-3 text-body">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-medium">
                <Dot className="bg-warning" />{a.label}
              </span>
              <Btn onClick={() => onResolve(a.id)}>{t('pending.resolve')}</Btn>
            </div>
            {a.command && <code className="mt-2 block overflow-x-auto rounded-[4px] bg-subtle p-2 font-mono text-[11px] text-ink-2">{a.command}</code>}
            <div className="mt-1.5 font-mono text-[11px] text-muted">{a.timestamp}{a.taskId ? ` · ${t('pending.task', { id: a.taskId })}` : ''} · {a.id}</div>
          </div>
        ))}
        {done.length > 0 && <div className="pt-2 text-meta text-muted">{t('pending.resolvedCount', { n: done.length })}</div>}
      </div>
    </Modal>
  )
}

function GitCheck({ label, desc, checked, disabled, onChange }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={e => onChange(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
      <span>
        <span className="text-ink">{label}</span>
        {desc && <span className="mt-0.5 block text-meta text-muted">{desc}</span>}
      </span>
    </label>
  )
}

function DevServerSettings({ project, onPatch }) {
  const d = project.devServer || {}
  const [command, setCommand] = useState(d.command || '')
  const [url, setUrl] = useState(d.url || '')
  const save = () => onPatch({ devServer: { command: command.trim(), url: url.trim() } })
  return (
    <div className="space-y-3 rounded-[8px] border border-line p-3">
      <div className="text-meta font-semibold uppercase tracking-wide text-muted">{t('devserverSettings.title')}</div>
      <label className="block">
        <span className="text-ink">{t('devserverSettings.command')}</span>
        <input value={command} onChange={e => setCommand(e.target.value)} onBlur={save}
          placeholder="npm run dev"
          className="mt-1 w-full rounded-[6px] bg-subtle px-2 py-1.5 font-mono text-body outline-none placeholder:text-muted" />
        <span className="mt-1 block text-meta text-muted">{t('devserverSettings.commandHint', { path: project.path })}</span>
      </label>
      <label className="block">
        <span className="text-ink">{t('devserverSettings.url')}</span>
        <input value={url} onChange={e => setUrl(e.target.value)} onBlur={save}
          placeholder="http://localhost:3000"
          className="mt-1 w-full rounded-[6px] bg-subtle px-2 py-1.5 font-mono text-body outline-none placeholder:text-muted" />
        <span className="mt-1 block text-meta text-muted">{t('devserverSettings.urlHint')}</span>
      </label>
    </div>
  )
}

const CONFIG_GROUPS = ['settings', 'mcp', 'hooks', 'skills', 'agents', 'commands', 'plugins', 'outros']

function ClaudeConfigModal({ project, onClose }) {
  const [files, setFiles] = useState(null)
  const [selected, setSelected] = useState(null)
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(0)
  const dirty = content !== original

  const loadList = () => api.claudeConfig(project.id).then(d => setFiles(d.files)).catch(e => setError(e.message))
  useEffect(() => { loadList() }, [project.id])

  const open = rel => {
    if (dirty && !confirm(t('claudeConfig.confirmDiscard'))) return
    setSelected(rel); setLoading(true); setError(null)
    api.claudeConfigFile(project.id, rel)
      .then(d => { setContent(d.content); setOriginal(d.content) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  const save = () => {
    setSaving(true); setError(null)
    api.saveClaudeConfigFile(project.id, selected, content)
      .then(d => { setOriginal(d.content); setSavedAt(Date.now()); loadList() })
      .catch(e => setError(e.message))
      .finally(() => setSaving(false))
  }

  const grouped = CONFIG_GROUPS
    .map(key => ({ key, items: (files || []).filter(f => f.category === key) }))
    .filter(g => g.items.length)

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/10" onMouseDown={onClose} />
      <div className="fixed inset-y-0 right-0 z-40 flex w-[900px] max-w-full flex-col border-l border-line bg-bg">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <h2 className="font-semibold">{t('claudeConfig.title', { project: project.name })}</h2>
          <span className="text-meta text-muted">{t('claudeConfig.subtitle')}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 overflow-y-auto border-r border-line py-2">
            {files === null && <div className="px-4 py-2 text-meta text-muted">{t('claudeConfig.loading')}</div>}
            {files?.length === 0 && <div className="px-4 py-2 text-meta text-muted">{t('claudeConfig.emptyFiles')}</div>}
            {grouped.map(g => (
              <div key={g.key} className="mb-1">
                <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{t(`configGroup.${g.key}`)}</div>
                {g.items.map(f => (
                  <button key={f.path} onClick={() => open(f.path)}
                    className={`block w-full truncate px-4 py-1.5 text-left font-mono text-meta ${selected === f.path ? 'bg-hover text-accent' : 'text-ink-2 hover:bg-hover'}`}
                    title={f.path}>
                    {f.path.replace(/^\.claude\//, '')}
                    {selected === f.path && dirty && <span className="ml-1 text-warning">•</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-body text-muted">{t('claudeConfig.pickFile')}</div>
            ) : (
              <>
                <div className="flex items-center gap-3 border-b border-line px-4 py-2">
                  <span className="truncate font-mono text-meta text-ink-2">{selected}</span>
                  <div className="flex-1" />
                  {savedAt > 0 && !dirty && <span className="text-meta text-success">{t('claudeConfig.saved')}</span>}
                  <Btn variant="primary" onClick={save} disabled={!dirty || saving}>{saving ? t('claudeConfig.saving') : t('common.save')}</Btn>
                </div>
                {error && <div className="border-b border-line px-4 py-2 text-meta text-danger">{error}</div>}
                {loading ? (
                  <div className="flex flex-1 items-center justify-center text-body text-muted">{t('claudeConfig.loading')}</div>
                ) : (
                  <textarea value={content} onChange={e => setContent(e.target.value)} spellCheck={false}
                    className="flex-1 resize-none bg-subtle p-4 font-mono text-meta leading-relaxed text-ink outline-none" />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function SettingsModal({ project, onClose, onPatch, onRemove }) {
  const [confirmRemove, setConfirmRemove] = useState(0)
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description || '')
  const [projPath, setProjPath] = useState(project.path)
  // Um PATCH rejeitado (ex.: pasta inexistente) não muda o projeto: re-sincroniza os campos.
  useEffect(() => { setName(project.name); setDescription(project.description || ''); setProjPath(project.path) },
    [project.name, project.description, project.path])
  const g = project.git || {}
  const [baseBranch, setBaseBranch] = useState(g.baseBranch ?? 'main')
  const [timeoutMin, setTimeoutMin] = useState(String(Math.round((project.timeoutMs || DEFAULT_TIMEOUT_MS) / 60000)))
  const [verifyCommand, setVerifyCommand] = useState(project.verifyCommand || '')
  const retry = project.retry || DEFAULT_RETRY
  const [maxAttempts, setMaxAttempts] = useState(String(retry.maxAttempts))
  const [backoffMin, setBackoffMin] = useState(String(retry.backoffMinutes))
  const patchGit = patch => onPatch({ git: patch })

  // Campos inválidos voltam ao valor salvo em vez de virar patch — mesmo contrato
  // do timeout, e evita mandar NaN para o backend.
  const commitRetry = () => {
    const a = Number(maxAttempts)
    const b = Number(backoffMin)
    const okA = Number.isInteger(a) && a >= 1 && a <= 10
    const okB = Number.isFinite(b) && b >= 0 && b <= 1440
    if (!okA) setMaxAttempts(String(retry.maxAttempts))
    if (!okB) setBackoffMin(String(retry.backoffMinutes))
    if (!okA || !okB) return
    if (a === retry.maxAttempts && b === retry.backoffMinutes) return
    onPatch({ retry: { maxAttempts: a, backoffMinutes: b } })
  }

  const commitTimeout = () => {
    const min = Number(timeoutMin)
    if (!Number.isFinite(min) || min < 1 || min > 240) {
      setTimeoutMin(String(Math.round((project.timeoutMs || DEFAULT_TIMEOUT_MS) / 60000)))
      return
    }
    onPatch({ timeoutMs: Math.round(min) * 60000 })
  }
  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/10" onMouseDown={onClose} />
      <div className="fixed inset-y-0 right-0 z-40 flex w-[560px] max-w-full flex-col border-l border-line bg-bg">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <h2 className="font-semibold">{t('settings.title', { project: project.name })}</h2>
          <div className="flex-1" />
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-body">
        <label className="flex items-center gap-3">
          <span>{t('settings.name')}</span>
          <input value={name} onChange={e => setName(e.target.value)}
            onBlur={() => { const v = name.trim(); if (!v) return setName(project.name); if (v !== project.name) onPatch({ name: v }) }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            className="flex-1 rounded-[6px] border border-line px-2 py-1 text-body outline-none focus:border-accent" />
        </label>
        <label className="flex items-start gap-3">
          <span className="mt-1">{t('settings.description')}</span>
          <textarea value={description} rows={2} onChange={e => setDescription(e.target.value)}
            onBlur={() => { if (description.trim() !== (project.description || '')) onPatch({ description: description.trim() }) }}
            placeholder={t('settings.descriptionPlaceholder')}
            className="flex-1 resize-none rounded-[6px] border border-line px-2 py-1 text-body outline-none placeholder:text-muted focus:border-accent" />
        </label>
        <label className="flex items-center gap-3">
          <span>{t('settings.rootFolder')}</span>
          <input value={projPath} onChange={e => setProjPath(e.target.value)}
            onBlur={() => { const v = projPath.trim(); if (!v) return setProjPath(project.path); if (v !== project.path) onPatch({ path: v }) }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            className="flex-1 rounded-[6px] border border-line px-2 py-1 font-mono text-body outline-none focus:border-accent" />
          <Btn type="button" onClick={() => api.pickFolder().then(d => { if (d.path && d.path !== project.path) { setProjPath(d.path); onPatch({ path: d.path }) } }).catch(e => alert(e.message))}>
            {t('settings.pickFolder')}
          </Btn>
        </label>

        <label className="flex items-center gap-3">
          <span>{t('settings.defaultModel')}</span>
          <select value={project.defaultModel || ''} onChange={e => onPatch({ defaultModel: e.target.value || null })}
            className="rounded-[6px] border border-line px-2 py-1 text-body outline-none">
            <option value="">{t('settings.defaultModelNone')}</option>
            {MODELS.map(m => <option key={m.id} value={m.id}>{m.id} ({m.label})</option>)}
          </select>
          <span className="text-meta text-muted">{t('settings.defaultModelHint')}</span>
        </label>

        <label className="flex items-start gap-3">
          <span className="mt-1">{t('settings.enrich')}</span>
          <span className="flex-1">
            <select value={project.enrichMode || 'off'} onChange={e => onPatch({ enrichMode: e.target.value })}
              className="rounded-[6px] border border-line px-2 py-1 text-body outline-none">
              {ENRICH_MODES.map(k => <option key={k} value={k}>{enrichLabel(k)}</option>)}
            </select>
            <span className="mt-1 block text-meta text-muted">{t('settings.enrichHint')}</span>
          </span>
        </label>

        <label className="flex items-center gap-3">
          <span>{t('settings.timeout')}</span>
          <input type="number" min={1} max={240} value={timeoutMin}
            onChange={e => setTimeoutMin(e.target.value)}
            onBlur={commitTimeout}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            className="w-20 rounded-[6px] border border-line px-2 py-1 text-body outline-none focus:border-accent" />
          <span className="text-meta text-muted">{t('settings.timeoutHint')}</span>
        </label>

        <label className="flex items-start gap-3">
          <span className="mt-1">{t('settings.verifyCommand')}</span>
          <span className="flex-1">
            <input value={verifyCommand} onChange={e => setVerifyCommand(e.target.value)}
              onBlur={() => onPatch({ verifyCommand })}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
              placeholder="npm test"
              className="w-full rounded-[6px] border border-line px-2 py-1 font-mono text-body outline-none focus:border-accent" />
            <span className="mt-1 block text-meta text-muted">{t('settings.verifyHint')}</span>
          </span>
        </label>
        <div className="flex items-start gap-3">
          <span className="mt-1">{t('settings.retries')}</span>
          <span className="flex-1">
            <span className="flex items-center gap-2">
              <input type="number" min={1} max={10} value={maxAttempts}
                onChange={e => setMaxAttempts(e.target.value)}
                onBlur={commitRetry}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className="w-16 rounded-[6px] border border-line px-2 py-1 text-body outline-none focus:border-accent" />
              <span className="text-meta text-muted">{t('settings.retriesHint')} <code>blocked</code></span>
              <input type="number" min={0} max={1440} value={backoffMin}
                onChange={e => setBackoffMin(e.target.value)}
                onBlur={commitRetry}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className="w-16 rounded-[6px] border border-line px-2 py-1 text-body outline-none focus:border-accent" />
              <span className="text-meta text-muted">{t('settings.retriesWait')}</span>
            </span>
            <span className="mt-1 block text-meta text-muted">{t('settings.retriesNote')}</span>
          </span>
        </div>
        <div className="rounded-[8px] border border-line p-3">
          <GitCheck label={t('settings.autoDecompose')}
            desc={t('settings.autoDecomposeHint')}
            checked={!!project.autoDecompose}
            onChange={v => onPatch({ autoDecompose: v })} />
        </div>

        <DevServerSettings project={project} onPatch={onPatch} />

        <div className="space-y-3 rounded-[8px] border border-line p-3">
          <div className="text-meta font-semibold uppercase tracking-wide text-muted">{t('settings.git')}</div>
          <label className={`flex items-center gap-3 ${g.useCurrentBranch ? 'opacity-40' : ''}`}>
            <span>{t('settings.baseBranch')}</span>
            <input value={baseBranch} disabled={!!g.useCurrentBranch}
              onChange={e => setBaseBranch(e.target.value)}
              onBlur={() => patchGit({ baseBranch: baseBranch.trim() || 'main' })}
              placeholder="main"
              className="w-40 rounded-[6px] border border-line px-2 py-1 font-mono text-body outline-none focus:border-accent" />
            <span className="text-meta text-muted">{t('settings.baseBranchHint')}</span>
          </label>
          <GitCheck label={t('settings.pullBeforeStart')}
            checked={!!g.pullBeforeStart} disabled={!!g.useCurrentBranch}
            onChange={v => patchGit({ pullBeforeStart: v })} />
          <GitCheck label={t('settings.useCurrentBranch')}
            desc={t('settings.useCurrentBranchHint')}
            checked={!!g.useCurrentBranch}
            onChange={v => patchGit({ useCurrentBranch: v })} />
          <GitCheck label={t('settings.commitToNewBranch')}
            desc={t(g.useWorktree ? 'settings.commitToNewBranchWorktree' : 'settings.commitToNewBranchHint')}
            checked={!!g.useWorktree || !!g.commitToNewBranch} disabled={!!g.useWorktree}
            onChange={v => patchGit({ commitToNewBranch: v })} />
          <GitCheck label={t('settings.useWorktree')}
            desc={t('settings.useWorktreeHint')}
            checked={!!g.useWorktree}
            onChange={v => patchGit({ useWorktree: v })} />
          <GitCheck label={t('settings.autoPush')}
            desc={t('settings.autoPushHint')}
            checked={!!g.autoPush}
            onChange={v => patchGit({ autoPush: v })} />
          <GitCheck label={t('settings.autoPR')}
            desc={t(g.autoPush ? 'settings.autoPRHint' : 'settings.autoPRNeedsPush')}
            checked={!!g.autoPush && !!g.autoPR} disabled={!g.autoPush}
            onChange={v => patchGit({ autoPR: v })} />
          <GitCheck label={t('settings.autoPRDescription')}
            desc={t('settings.autoPRDescriptionHint')}
            checked={!!g.autoPRDescription} disabled={!g.autoPush || !g.autoPR}
            onChange={v => patchGit({ autoPRDescription: v })} />
        </div>
        <label className="flex items-start gap-3 rounded-[8px] border border-line p-3">
          <input type="checkbox" checked={!!project.skipPermissions}
            onChange={e => onPatch({ skipPermissions: e.target.checked })} className="mt-0.5 accent-[var(--color-accent)]" />
          <span>
            <span className="font-medium text-danger">{t('settings.skipPermissions')}</span>
            <span className="mt-1 block text-meta text-muted">{t('settings.skipPermissionsHint')}</span>
          </span>
        </label>
        <Btn onClick={() => api.rebootstrap(project.id).then(() => onPatch({}))}>{t('settings.rerunBootstrap')}</Btn>
        <div className="border-t border-line pt-4">
          {confirmRemove === 0 && (
            <div className="flex gap-3">
              <Btn onClick={() => onRemove(false)}>{t('settings.removeProject')}</Btn>
              <Btn variant="danger" onClick={() => setConfirmRemove(1)}>{t('settings.removeAndUninstall')}</Btn>
            </div>
          )}
          {confirmRemove === 1 && (
            <div className="space-y-2 rounded-[8px] border border-danger p-3">
              <div className="text-danger">{t('settings.removeWarning')}</div>
              <div className="flex gap-2">
                <Btn variant="danger" onClick={() => setConfirmRemove(2)}>{t('settings.removeContinue')}</Btn>
                <Btn variant="quiet" onClick={() => setConfirmRemove(0)}>{t('common.cancel')}</Btn>
              </div>
            </div>
          )}
          {confirmRemove === 2 && (
            <div className="space-y-2 rounded-[8px] border border-danger p-3">
              <div className="font-medium text-danger">{t('settings.removeFinal')}</div>
              <div className="flex gap-2">
                <button onClick={() => onRemove(true)}
                  className="rounded-[6px] bg-danger px-3 py-1.5 text-meta font-semibold text-white">{t('settings.uninstall')}</button>
                <Btn variant="quiet" onClick={() => setConfirmRemove(0)}>{t('common.cancel')}</Btn>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </>
  )
}

// Pausa global (todos os projetos), sempre em modo "drenar": as sessões ativas
// terminam, nada novo sai da fila. Com um limite do plano em situação crítica,
// o botão vira uma sugestão explícita de pausar.
function GlobalPauseButton({ queue, usage, onPause, onResume }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const paused = !!queue.paused
  const critical = criticalLimit(usage)

  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const pause = until => { setOpen(false); onPause(until) }

  if (paused) {
    return (
      <div className="flex shrink-0 items-center overflow-hidden rounded-[6px] border border-warning">
        <span className="px-2.5 py-1 text-meta text-warning" title={t('globalPause.pausedTip')}>
          {queue.pausedUntil ? t('globalPause.pausedUntil', { when: fmtWhen(queue.pausedUntil) }) : t('globalPause.paused')}
        </span>
        <button onClick={onResume} title={t('globalPause.resumeTip')}
          className="border-l border-warning px-2 py-1 text-meta text-warning hover:bg-hover">{t('globalPause.resume')}</button>
      </div>
    )
  }

  const presets = [
    { label: t('globalPause.untilResume'), at: () => null },
    { label: t('globalPause.1h'), at: () => inHours(1) },
    { label: t('globalPause.4h'), at: () => inHours(4) },
    { label: t('globalPause.tomorrow9'), at: () => nextAt(9) },
  ]

  return (
    <div className="relative shrink-0" ref={ref}>
      <button onClick={() => setOpen(v => !v)}
        title={critical
          ? t('globalPause.criticalTip', { name: usageName(critical), pct: usagePct(critical) })
          : t('globalPause.tip')}
        className={`rounded-[6px] border px-2.5 py-1 text-meta ${critical
          ? 'border-danger text-danger hover:bg-hover'
          : 'border-line text-ink-2 hover:bg-hover'}`}>
        {critical ? t('globalPause.buttonCritical', { pct: usagePct(critical) }) : t('globalPause.button')}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-[8px] border border-line bg-bg py-1">
          {presets.map(p => (
            <button key={p.label} onClick={() => pause(p.at())}
              className="block w-full px-3 py-1.5 text-left text-body text-ink-2 hover:bg-hover">{p.label}</button>
          ))}
          <p className="border-t border-line px-3 py-2 text-[10px] text-muted">
            {t('globalPause.drainNote')}
          </p>
        </div>
      )}
    </div>
  )
}

const settingsTabs = () => [
  { key: 'aparencia', label: t('globalSettings.tab.appearance') },
  { key: 'execucao', label: t('globalSettings.tab.execution') },
  { key: 'alertas', label: t('globalSettings.tab.alerts') },
]

const labelled = (options, prefix) => options.map(o => ({ key: o.key, label: t(`${prefix}.${o.key}`) }))

function GlobalSettingsModal({ onClose, queue, onConcurrency, notifyOn, onNotify, soundOn, onSound, soundMap, onSoundFor, theme, onTheme, lang, onLang }) {
  const maxConc = queue?.maxConcurrency || 1
  const [tab, setTab] = useState('aparencia')
  return (
    <Modal onClose={onClose} title={t('globalSettings.title')}>
      <div className="mb-4">
        <Segmented value={tab} onChange={setTab} options={settingsTabs()} />
      </div>
      <div className="space-y-4 text-body">
        {tab === 'aparencia' && (
          <>
          <div className="flex items-center gap-3">
            <span>{t('globalSettings.theme')}</span>
            <Segmented value={theme} onChange={onTheme} options={labelled(THEMES, 'theme')} />
            <span className="text-meta text-muted">
              {t(theme === 'system' ? 'globalSettings.themeSystemHint' : 'globalSettings.themeFixedHint')}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span>{t('globalSettings.language')}</span>
            <Segmented value={lang} onChange={onLang} options={LANGS} />
            <span className="text-meta text-muted">{t('globalSettings.languageHint')}</span>
          </div>
          </>
        )}
        {tab === 'execucao' && (
          <div className="flex items-center gap-3">
            <span>{t('globalSettings.concurrency')}</span>
            <div className="flex items-center gap-1 rounded-[6px] border border-line px-1.5 py-0.5 text-meta">
              <button onClick={() => onConcurrency(maxConc - 1)} disabled={maxConc <= 1}
                className="px-1 text-muted hover:text-ink disabled:opacity-30">−</button>
              <span className="font-mono text-ink">{maxConc}×</span>
              <button onClick={() => onConcurrency(maxConc + 1)} disabled={maxConc >= 8}
                className="px-1 text-muted hover:text-ink disabled:opacity-30">+</button>
            </div>
            <span className="text-meta text-muted">{t('globalSettings.concurrencyHint')}</span>
          </div>
        )}
        {tab === 'alertas' && (
          <>
            <NotificationsSetting notifyOn={notifyOn} onNotify={onNotify} />
            <SoundSetting soundOn={soundOn} onSound={onSound} soundMap={soundMap} onSoundFor={onSoundFor} />
          </>
        )}
      </div>
    </Modal>
  )
}

function NotificationsSetting({ notifyOn, onNotify }) {
  const [perm, setPerm] = useState(notifications.permission)
  const supported = notifications.supported()
  const toggle = async v => { await onNotify(v); setPerm(notifications.permission()) }
  return (
    <label className="flex items-start gap-3 rounded-[8px] border border-line p-3">
      <input type="checkbox" checked={!!notifyOn} disabled={!supported || perm === 'denied'}
        onChange={e => toggle(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
      <span>
        <span className="font-medium">{t('notifications.label')}</span>
        <span className="mt-1 block text-meta text-muted">
          {t(!supported ? 'notifications.unsupported' : perm === 'denied' ? 'notifications.denied' : 'notifications.hint')}
        </span>
      </span>
    </label>
  )
}

function SoundSetting({ soundOn, onSound, soundMap, onSoundFor }) {
  const supported = sounds.supported()
  return (
    <div className="rounded-[8px] border border-line p-3">
      <label className="flex items-start gap-3">
        <input type="checkbox" checked={!!soundOn} disabled={!supported}
          onChange={e => onSound(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
        <span>
          <span className="font-medium">{t('sounds.label')}</span>
          <span className="mt-1 block text-meta text-muted">
            {t(!supported ? 'sounds.unsupported' : 'sounds.hint')}
          </span>
        </span>
      </label>
      {supported && soundOn && (
        <div className="mt-3 space-y-2 pl-7">
          {sounds.CATEGORIES.map(cat => (
            <div key={cat.key} className="flex items-center gap-2">
              <span className="w-28 shrink-0">{t(`sound.category.${cat.key}`)}</span>
              <select value={soundMap[cat.key]} onChange={e => onSoundFor(cat.key, e.target.value)}
                className="rounded-[6px] border border-line bg-transparent px-1.5 py-0.5 text-meta">
                {sounds.VARIANTS.map(v => <option key={v.key} value={v.key}>{t(`sound.variant.${v.key}`)}</option>)}
              </select>
              <button onClick={() => sounds.playVariant(soundMap[cat.key])}
                className="px-1 text-muted hover:text-ink" title={t('sounds.preview')}>▶</button>
              <span className="text-meta text-muted">{t(`sound.category.${cat.key}.hint`)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function QueueBar({ queue, tasks, projects, usage, onOpen, onKill, onReorder, onDequeue, onPause, onResume }) {
// Preferência global (localStorage), não por projeto — por isso mora aqui e não
// no patch do projeto.
  const items = queue.queue
  const label = q => {
    const task = tasks.find(x => x.id === q.taskId)
    const p = projects.find(x => x.id === q.projectId)
    return `${p ? p.name + ' · ' : ''}${task ? task.title : q.taskId}`
  }
  const move = (i, dir) => {
    const ids = items.map(q => q.taskId)
    const j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    onReorder(ids)
  }
  return (
    <footer className="flex items-center gap-2 overflow-x-auto border-t border-line px-4 py-2 text-meta">
      <GlobalPauseButton queue={queue} usage={usage} onPause={onPause} onResume={onResume} />
      {(queue.actives || []).map(a => (
        <div key={a.taskId} className="flex shrink-0 items-center gap-2 rounded-[6px] bg-subtle px-3 py-1.5">
          <Dot className="animate-pulse bg-st-doing" />
          <button onClick={() => onOpen(a, true)} title={t('queueBar.liveLog')} className="text-ink-2 hover:text-ink hover:underline">{label(a)}</button>
          <button onClick={() => onKill(a.taskId)} className="text-danger hover:underline">{t('queueBar.kill')}</button>
        </div>
      ))}
      {items.map((q, i) => (
        <div key={q.taskId} className="flex shrink-0 items-center gap-1.5 rounded-[6px] bg-subtle px-3 py-1.5 text-ink-2">
          <span className="font-mono text-muted">#{i + 1}</span>
          <button onClick={() => onOpen(q, false)} title={t('queueBar.details')} className="hover:text-ink hover:underline">{label(q)}</button>
          <button onClick={() => move(i, -1)} className="px-0.5 text-muted hover:text-ink">◂</button>
          <button onClick={() => move(i, 1)} className="px-0.5 text-muted hover:text-ink">▸</button>
          <button onClick={() => onDequeue(q.taskId)} title={t('queueBar.dequeue')}
            className="px-0.5 text-muted hover:text-danger">✕</button>
        </div>
      ))}
    </footer>
  )
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/10 p-4"
      onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl rounded-[8px] border border-line bg-bg p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}
