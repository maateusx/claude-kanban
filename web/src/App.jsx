import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, useDraggable, closestCorners } from '@dnd-kit/core'
import { api, connectWS } from './api.js'
import { DiffDrawer } from './Diff.jsx'

const COLUMNS = [
  { key: 'backlog', label: 'Backlog', dot: 'bg-zinc-500' },
  { key: 'todo', label: 'To Do', dot: 'bg-sky-400' },
  { key: 'doing', label: 'Doing', dot: 'bg-amber-400' },
  { key: 'done', label: 'Done', dot: 'bg-emerald-400' },
  { key: 'archived', label: 'Archived', dot: 'bg-zinc-600', collapsible: true },
]
const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const PRIORITY_STYLE = {
  low: 'bg-zinc-800 text-zinc-400 ring-1 ring-inset ring-zinc-700',
  medium: 'bg-sky-950 text-sky-300 ring-1 ring-inset ring-sky-800/60',
  high: 'bg-orange-950 text-orange-300 ring-1 ring-inset ring-orange-800/60',
  urgent: 'bg-red-950 text-red-300 ring-1 ring-inset ring-red-800/60',
}

export default function App() {
  const [projects, setProjects] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [tasks, setTasks] = useState([])
  const [pending, setPending] = useState([])
  const [queue, setQueue] = useState({ actives: [], queue: [], maxConcurrency: 1 })
  const [logs, setLogs] = useState({}) // taskId -> [events]
  const [logTask, setLogTask] = useState(null)
  const [diffTask, setDiffTask] = useState(null)
  const [editTask, setEditTask] = useState(null) // task ou 'new'
  const [showPending, setShowPending] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSuggest, setShowSuggest] = useState(false)
  const [showClaudeConfig, setShowClaudeConfig] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [health, setHealth] = useState({ ok: true, claudeAvailable: true })
  const [activeId, setActiveId] = useState(null)
  const selectedIdRef = useRef(null)
  selectedIdRef.current = selectedId

  const project = projects.find(p => p.id === selectedId) || null

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
    switch (evt.type) {
      case 'task.upserted':
        if (evt.projectId === cur) {
          setTasks(ts => {
            const i = ts.findIndex(t => t.id === evt.task.id)
            if (i === -1) return [...ts, evt.task]
            const next = [...ts]; next[i] = evt.task; return next
          })
        }
        break
      case 'task.removed':
        if (evt.projectId === cur) setTasks(ts => ts.filter(t => t.id !== evt.taskId))
        break
      case 'pending.updated':
        if (evt.projectId === cur) setPending(evt.actions)
        refreshProjects()
        break
      case 'run.queued':
      case 'run.queue':
      case 'run.started':
      case 'run.killed':
        api.queue().then(setQueue)
        break
      case 'run.finished':
        api.queue().then(setQueue)
        if (evt.projectId === cur) api.tasks(cur).then(d => setTasks(d.tasks))
        break
      case 'devserver.updated':
      case 'project.updated':
        refreshProjects()
        break
      case 'run.log':
        setLogs(l => ({ ...l, [evt.taskId]: [...(l[evt.taskId] || []).slice(-500), evt.event] }))
        break
      default: break
    }
  }), [refreshProjects])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const onDragEnd = ({ active, over }) => {
    setActiveId(null)
    if (!over || !project) return
    const status = over.id
    const task = tasks.find(t => t.id === active.id)
    if (!task || task.status === status) return
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status } : t)) // otimista
    api.patchTask(project.id, task.id, { status }).catch(() => api.tasks(project.id).then(d => setTasks(d.tasks)))
  }

  const runTask = tid => api.run(project.id, tid).then(setQueue).catch(e => alert(e.message))
  const pendingCount = pending.filter(a => a.status === 'pending').length

  return (
    <div className="flex h-full">
      <Sidebar
        projects={projects} selectedId={selectedId} onSelect={setSelectedId} queue={queue}
        onAdd={(name, path) => api.addProject(name, path).then(d => { refreshProjects(); setSelectedId(d.project.id) }).catch(e => alert(e.message))}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        {!health.claudeAvailable && (
          <div className="bg-red-900/60 px-4 py-2 text-sm text-red-200">CLI `claude` não encontrado no PATH — execução de tasks indisponível.</div>
        )}
        {project ? (
          <>
            <header className="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-950/40 px-4 py-3 backdrop-blur">
              <h1 className="text-lg font-semibold">{project.name}</h1>
              <BootstrapBadge project={project} onRerun={() => api.rebootstrap(project.id).then(refreshProjects)} />
              <BranchSelector project={project} onChanged={refreshProjects} />
              {project.skipPermissions && <span className="rounded bg-red-900/70 px-2 py-0.5 text-xs text-red-200">skip-permissions</span>}
              <div className="flex-1" />
              <button onClick={() => api.patchProject(project.id, { autoRun: !project.autoRun }).then(refreshProjects)}
                title="Com o auto ligado, toda task em To Do entra na fila sozinha (respeitando a concorrência configurada)."
                className={`rounded-md px-3 py-1.5 text-sm ${project.autoRun ? 'bg-emerald-500 font-medium text-emerald-950 shadow-sm shadow-emerald-900/50' : 'bg-zinc-800/80 text-zinc-400 ring-1 ring-inset ring-zinc-700/60 hover:text-zinc-200'}`}>
                ⚡ Auto {project.autoRun ? 'on' : 'off'}
              </button>
              <button onClick={() => setShowPending(true)}
                className={`rounded-md px-3 py-1.5 text-sm ${pendingCount ? 'bg-amber-500 font-medium text-amber-950 shadow-sm shadow-amber-900/50' : 'bg-zinc-800/80 text-zinc-400 ring-1 ring-inset ring-zinc-700/60 hover:text-zinc-200'}`}>
                Ações manuais{pendingCount ? ` (${pendingCount})` : ''}
              </button>
              <DevServerButton project={project} onChanged={refreshProjects} />
              <button onClick={() => setShowClaudeConfig(true)} title="Ver e editar settings.json, .mcp.json, hooks, skills, agents…"
                className="rounded-md bg-zinc-800/80 px-3 py-1.5 text-sm text-zinc-300 ring-1 ring-inset ring-zinc-700/60 hover:bg-zinc-700/80">.claude</button>
              <button onClick={() => setShowSettings(true)} className="rounded-md bg-zinc-800/80 px-3 py-1.5 text-sm text-zinc-300 ring-1 ring-inset ring-zinc-700/60 hover:bg-zinc-700/80">Config</button>
              <button onClick={() => setShowSuggest(true)} disabled={!health.claudeAvailable}
                title="Analisa o projeto com o Claude e sugere tasks para o backlog"
                className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium shadow-sm shadow-violet-950/60 hover:bg-violet-500 disabled:opacity-50">✨ Sugerir tasks</button>
              <button onClick={() => setEditTask('new')} className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-semibold text-sky-950 shadow-sm shadow-sky-950/60 hover:bg-sky-400">+ Task</button>
            </header>
            <DndContext sensors={sensors} collisionDetection={closestCorners}
              onDragStart={({ active }) => setActiveId(active.id)}
              onDragCancel={() => setActiveId(null)} onDragEnd={onDragEnd}>
              <div className="flex flex-1 gap-4 overflow-x-auto p-4">
                {COLUMNS.map(col => (
                  (col.key !== 'archived' || showArchived)
                    ? <Column key={col.key} col={col} tasks={tasks.filter(t => t.status === col.key)}
                        queue={queue} onRun={runTask} onEdit={setEditTask} onLog={setLogTask} onDiff={setDiffTask}
                        defaultModel={project.defaultModel}
                        onModel={(tid, model) => api.patchTask(project.id, tid, { model }).catch(e => alert(e.message))}
                        onArchive={tid => api.archiveTask(project.id, tid)}
                        onAddTask={col.key !== 'archived' ? () => setEditTask({ __new: true, status: col.key }) : null}
                        onCollapse={col.collapsible ? () => setShowArchived(false) : null} />
                    : <button key={col.key} onClick={() => setShowArchived(true)}
                        className="h-fit shrink-0 rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300">
                        Archived ({tasks.filter(t => t.status === 'archived').length}) ▸
                      </button>
                ))}
              </div>
              <DragOverlay>
                {activeId ? (
                  <CardBody task={tasks.find(t => t.id === activeId)} queue={queue}
                    defaultModel={project.defaultModel} dragging />
                ) : null}
              </DragOverlay>
            </DndContext>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-zinc-500">Cadastre um projeto na sidebar para começar.</div>
        )}
        <QueueBar queue={queue} tasks={tasks} projects={projects}
          onKill={tid => api.kill(tid).then(() => api.queue().then(setQueue))}
          onReorder={ids => api.reorderQueue(ids).then(setQueue)} />
      </main>

      {editTask && project && (
        <TaskModal task={(editTask === 'new' || editTask.__new) ? null : editTask}
          onClose={() => setEditTask(null)}
          onSave={data => {
            const p = editTask === 'new'
              ? api.addTask(project.id, data)
              : editTask.__new
                ? api.addTask(project.id, { ...data, status: editTask.status })
                : api.patchTask(project.id, editTask.id, data)
            p.then(() => { setEditTask(null); api.tasks(project.id).then(d => setTasks(d.tasks)) }).catch(e => alert(e.message))
          }} />
      )}
      {diffTask && project && (
        <DiffDrawer projectId={project.id} task={diffTask} onClose={() => setDiffTask(null)} />
      )}
      {logTask && project && (
        <LogDrawer projectId={project.id} taskId={logTask} events={logs[logTask] || []} onClose={() => setLogTask(null)}
          active={queue.actives?.some(a => a.taskId === logTask)} onKill={() => api.kill(logTask)} />
      )}
      {showSuggest && project && (
        <SuggestModal project={project} onClose={() => setShowSuggest(false)}
          onCreated={() => { setShowSuggest(false); api.tasks(project.id).then(d => setTasks(d.tasks)) }} />
      )}
      {showPending && project && (
        <PendingPanel actions={pending} onClose={() => setShowPending(false)}
          onResolve={aid => api.resolvePending(project.id, aid).then(d => setPending(d.actions))} />
      )}
      {showClaudeConfig && project && (
        <ClaudeConfigModal project={project} onClose={() => setShowClaudeConfig(false)} />
      )}
      {showSettings && project && (
        <SettingsModal project={project} onClose={() => setShowSettings(false)}
          queue={queue} onConcurrency={max => api.setConcurrency(max).then(setQueue)}
          onPatch={patch => api.patchProject(project.id, patch).then(refreshProjects)}
          onRemove={uninstall => {
            api.removeProject(project.id, uninstall).then(() => { setShowSettings(false); setSelectedId(null); refreshProjects() })
          }} />
      )}
    </div>
  )
}

function Sidebar({ projects, selectedId, onSelect, onAdd, queue }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/50">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-sky-500 to-violet-600 text-xs font-bold text-white shadow">K</span>
        <span className="flex-1 text-sm font-bold tracking-wide text-zinc-200">claude-kanban</span>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {projects.map(p => (
          <button key={p.id} onClick={() => onSelect(p.id)}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${p.id === selectedId ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}>
            <span className="flex-1 truncate">{p.name}</span>
            {!p.available && <span title="diretório indisponível" className="text-red-400">!</span>}
            {queue.actives?.some(a => a.projectId === p.id) && <span className="size-2 animate-pulse rounded-full bg-emerald-400" title="executando" />}
            {p.pendingCount > 0 && <span className="rounded bg-amber-500 px-1.5 text-xs font-semibold text-black">{p.pendingCount}</span>}
          </button>
        ))}
      </div>
      <UsagePanel />
      <form className="space-y-2 border-t border-zinc-800 p-3"
        onSubmit={e => { e.preventDefault(); if (name && path) { onAdd(name, path); setName(''); setPath('') } }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome do projeto"
          className="w-full rounded-md bg-zinc-800/80 px-2 py-1.5 text-sm outline-none ring-1 ring-inset ring-zinc-700/60 placeholder:text-zinc-600 focus:ring-sky-600" />
        <div className="flex gap-2">
          <input value={path} onChange={e => setPath(e.target.value)} placeholder="/caminho/do/projeto"
            className="w-full rounded-md bg-zinc-800/80 px-2 py-1.5 text-sm outline-none ring-1 ring-inset ring-zinc-700/60 placeholder:text-zinc-600 focus:ring-sky-600" />
          <button type="button" title="Buscar pasta"
            onClick={() => api.pickFolder().then(d => { if (d.path) setPath(d.path) }).catch(e => alert(e.message))}
            className="shrink-0 rounded bg-zinc-700 px-2 py-1.5 text-sm hover:bg-zinc-600">📁</button>
        </div>
        <button className="w-full rounded-md bg-zinc-800 py-1.5 text-sm text-zinc-300 ring-1 ring-inset ring-zinc-700 hover:bg-zinc-700 hover:text-white">Cadastrar projeto</button>
      </form>
    </aside>
  )
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

const USAGE_LABEL = {
  session: 'Sessão (5h)',
  weekly_all: 'Semanal',
  weekly_scoped: 'Semanal', // recebe o nome do modelo via scope
}

function usageResetLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `reseta ${time}`
  return `reseta ${d.toLocaleDateString('pt-BR', { weekday: 'short' })} ${time}`
}

function UsagePanel() {
  const [usage, setUsage] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => api.usage().then(d => { if (alive) setUsage(d) }).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (!usage?.available || !usage.limits?.length) return null
  return (
    <div className="space-y-2.5 border-t border-zinc-800 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Uso do Claude</div>
      {usage.limits.map((l, i) => {
        const pct = Math.min(100, Math.max(0, l.percent ?? 0))
        const bar = l.severity !== 'normal' || pct >= 90 ? 'bg-red-500'
          : pct >= 70 ? 'bg-amber-400'
          : 'bg-emerald-500'
        return (
          <div key={i} title={usageResetLabel(l.resetsAt)}>
            <div className="mb-1 flex items-baseline justify-between text-[11px]">
              <span className="text-zinc-400">
                {USAGE_LABEL[l.kind] || l.kind}{l.model ? ` · ${l.model}` : ''}
              </span>
              <span className="font-mono text-zinc-500">{pct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-0.5 text-[10px] text-zinc-600">{usageResetLabel(l.resetsAt)}</div>
          </div>
        )
      })}
    </div>
  )
}

function DevServerButton({ project, onChanged }) {
  const [busy, setBusy] = useState(false)
  const running = !!project.devServerRunning
  const configured = !!project.devServer?.command
  const launch = () => {
    if (!configured) { alert('Configure o comando do dev server em Config.'); return }
    setBusy(true)
    api.launchDevServer(project.id).then(onChanged).catch(e => alert(e.message)).finally(() => setBusy(false))
  }
  const stop = () => {
    setBusy(true)
    api.stopDevServer(project.id).then(onChanged).catch(e => alert(e.message)).finally(() => setBusy(false))
  }
  return (
    <div className="flex items-center overflow-hidden rounded">
      <button onClick={launch} disabled={busy}
        title={configured ? project.devServer.command : 'Configure o comando do dev server em Config'}
        className={`px-3 py-1.5 text-sm ${running ? 'bg-emerald-700 text-emerald-100' : 'bg-zinc-800 text-zinc-300'} disabled:opacity-50`}>
        {running && <span className="mr-1 inline-block size-2 animate-pulse rounded-full bg-emerald-300 align-middle" />}
        Abrir dev server no Chrome
      </button>
      {running && (
        <button onClick={stop} disabled={busy} title="Parar dev server"
          className="border-l border-zinc-900/40 bg-emerald-800 px-2 py-1.5 text-sm text-emerald-100 hover:bg-red-800 disabled:opacity-50">✕</button>
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

  if (!project.branch && project.bootstrap === 'unknown') return null
  if (!project.branch) return null // não é repo git

  const load = doFetch => {
    setBranches(b => doFetch ? b : null)
    api.branches(project.id, doFetch)
      .then(d => { setBranches(d.branches); if (d.fetchError) alert(`fetch falhou: ${d.fetchError}`) })
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
      .then(res => { setOpen(false); if (res.stashed) alert('Mudanças guardadas no stash (git stash) antes de trocar.'); onChanged() })
      .catch(e => {
        if (e.canStash && confirm('Há mudanças não commitadas que impedem a troca.\nGuardar no stash e trocar mesmo assim?')) {
          switchTo(name, true); return
        }
        alert(e.message)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="relative" ref={ref}>
      <button title="Branch atual — clique para trocar" onClick={toggle} disabled={busy}
        className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
        <span className="text-zinc-500">⑃</span>
        <span className="max-w-[16rem] truncate font-mono">{project.branch}</span>
        <span className="text-zinc-500">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-64 rounded border border-zinc-700 bg-zinc-900 shadow-lg">
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
            <span className="text-xs text-zinc-500">branches</span>
            <button onClick={() => load(true)} disabled={busy}
              title="Buscar branches remotas (git fetch)"
              className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50">↻ fetch</button>
          </div>
          <div className="max-h-72 overflow-auto py-1">
            {branches === null && <div className="px-3 py-1.5 text-xs text-zinc-500">carregando…</div>}
            {branches?.length === 0 && <div className="px-3 py-1.5 text-xs text-zinc-500">nenhuma branch</div>}
            {branches?.map(b => (
              <button key={b.name} onClick={() => switchTo(b.name)} disabled={busy}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-800 disabled:opacity-50 ${b.current ? 'text-emerald-300' : 'text-zinc-300'}`}>
                <span className="w-3">{b.current ? '✓' : ''}</span>
                <span className="flex-1 truncate font-mono">{b.name}</span>
                {b.remote && <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">remote</span>}
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
    ok: ['bg-emerald-900/60 text-emerald-300', 'bootstrap ok'],
    outdated: ['bg-amber-900/60 text-amber-300', 'bootstrap desatualizado — clique para atualizar'],
    failed: ['bg-red-900/60 text-red-300', project.bootstrapError || 'bootstrap falhou — clique para tentar de novo'],
    missing: ['bg-zinc-800 text-zinc-400', 'sem bootstrap — clique para rodar'],
    unknown: ['bg-zinc-800 text-zinc-500', 'diretório indisponível'],
  }
  const [cls, title] = map[project.bootstrap] || map.unknown
  return (
    <button title={title} onClick={project.bootstrap !== 'ok' ? onRerun : undefined}
      className={`rounded px-2 py-0.5 text-xs ${cls}`}>
      {project.bootstrap === 'ok' ? 'guardrails ✓' : `bootstrap: ${project.bootstrap}`}
    </button>
  )
}

function Column({ col, tasks, queue, onRun, onEdit, onLog, onDiff, onArchive, onAddTask, onCollapse, defaultModel, onModel }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.key })
  return (
    <div ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-xl border transition-colors ${isOver ? 'border-sky-500/70 bg-sky-950/25 ring-1 ring-sky-500/30' : 'border-zinc-800/80 bg-zinc-900/50'}`}>
      <div className="flex items-center justify-between px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
        <span className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${col.dot}`} />
          {col.label}
          <span className="rounded-full bg-zinc-800 px-1.5 py-px text-[10px] font-medium text-zinc-500">{tasks.length}</span>
        </span>
        {onCollapse && <button onClick={onCollapse} className="text-zinc-600 hover:text-zinc-300">◂</button>}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2 pt-0">
        {tasks.map(t => (
          <Card key={t.id} task={t} queue={queue} onRun={onRun} onEdit={onEdit} onLog={onLog} onDiff={onDiff} onArchive={onArchive}
            defaultModel={defaultModel} onModel={onModel} />
        ))}
        {onAddTask && (
          <button onClick={onAddTask}
            className="w-full rounded-lg border border-dashed border-zinc-800 px-3 py-2 text-left text-xs text-zinc-600 hover:border-zinc-600 hover:bg-zinc-800/30 hover:text-zinc-300">
            + Adicionar task
          </button>
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

function CardBody({ task, queue, onRun, onEdit, onLog, onDiff, onArchive, defaultModel, onModel,
  innerRef, handleProps, hidden, dragging }) {
  const running = queue.actives?.some(a => a.taskId === task.id)
  const queued = queue.queue.some(q => q.taskId === task.id)
  return (
    <div ref={innerRef} {...handleProps}
      className={`group rounded-lg border border-zinc-800 bg-zinc-900/90 p-3 text-sm shadow-md shadow-black/20 transition-colors hover:border-zinc-700 ${hidden ? 'opacity-0' : ''} ${dragging ? 'cursor-grabbing shadow-2xl ring-1 ring-sky-500' : 'cursor-grab'}`}>
      <div className="flex items-start justify-between gap-2">
        <button onClick={() => onEdit(task)} className="text-left font-medium leading-snug hover:text-sky-300">{task.title}</button>
        {running && <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" title="executando" />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${PRIORITY_STYLE[task.priority] || PRIORITY_STYLE.medium}`}>{task.priority}</span>
        {(task.tags || []).map(tag => (
          <span key={tag} className={`rounded px-1.5 py-0.5 text-[10px] ${tag === 'blocked' ? 'bg-red-900 text-red-300' : 'bg-zinc-800 text-zinc-400'}`}>{tag}</span>
        ))}
        {queued && <span className="rounded bg-violet-900 px-1.5 py-0.5 text-[10px] text-violet-300">na fila</span>}
        <select value={task.model || ''} disabled={running || queued}
          onPointerDown={e => e.stopPropagation()}
          onChange={e => onModel(task.id, e.target.value || null)}
          title="Modelo desta task (vazio: default do projeto → default do claude-code)"
          className={`ml-auto rounded bg-zinc-800 px-1 py-0.5 text-[10px] outline-none disabled:opacity-50 ${task.model ? 'text-teal-300' : 'text-zinc-500'}`}>
          <option value="">{defaultModel ? `↳ ${defaultModel}` : '↳ auto'}</option>
          {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {(task.run?.cost_usd != null || task.run?.duration_ms != null) && (
        <div className="mt-1.5 text-[11px] text-zinc-500">
          {task.run.cost_usd != null && <>${Number(task.run.cost_usd).toFixed(3)} · </>}
          {task.run.duration_ms != null && <>{(task.run.duration_ms / 1000).toFixed(0)}s · </>}
          {task.run.num_turns != null && <>{task.run.num_turns} turnos</>}
        </div>
      )}
      <div className="mt-2 flex gap-2 opacity-0 transition group-hover:opacity-100">
        {['backlog', 'todo'].includes(task.status) && !queued && !running && (
          <ActionBtn onClick={() => onRun(task.id)} label="▶ Executar" cls="text-emerald-400" />
        )}
        {(running || task.run?.session_id || (task.run?.attempts ?? 0) > 0) && (
          <ActionBtn onClick={() => onLog(task.id)} label="Ver log" cls="text-sky-400" />
        )}
        {task.run?.has_diff && !running && (
          <ActionBtn onClick={() => onDiff(task)} label="Ver diff" cls="text-violet-400" />
        )}
        {running && <ActionBtn onClick={() => api.kill(task.id)} label="Matar" cls="text-red-400" />}
        {task.status !== 'archived' && !running && <ActionBtn onClick={() => onArchive(task.id)} label="Arquivar" cls="text-zinc-500" />}
      </div>
    </div>
  )
}
const ActionBtn = ({ onClick, label, cls }) => (
  <button onPointerDown={e => e.stopPropagation()} onClick={onClick} className={`text-xs hover:underline ${cls}`}>{label}</button>
)

function TaskModal({ task, onClose, onSave }) {
  const [title, setTitle] = useState(task?.title || '')
  const [priority, setPriority] = useState(task?.priority || 'medium')
  const [tags, setTags] = useState((task?.tags || []).join(', '))
  const [model, setModel] = useState(task?.model || '')
  const [body, setBody] = useState(task?.body ?? '')
  const [preview, setPreview] = useState(false)
  return (
    <Modal onClose={onClose} title={task ? `Editar task — ${task.id}` : 'Nova task'}>
      <div className="space-y-3">
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Título"
          className="w-full rounded-md bg-zinc-800/80 px-3 py-2 outline-none ring-1 ring-inset ring-zinc-700/60 placeholder:text-zinc-600 focus:ring-sky-600" />
        <div className="flex gap-3">
          <select value={priority} onChange={e => setPriority(e.target.value)} className="rounded bg-zinc-800 px-2 py-2 text-sm">
            {['low', 'medium', 'high', 'urgent'].map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={model} onChange={e => setModel(e.target.value)} title="Modelo (vazio: default do projeto)"
            className="rounded bg-zinc-800 px-2 py-2 text-sm">
            <option value="">modelo: default</option>
            {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="tags, separadas, por vírgula"
            className="flex-1 rounded bg-zinc-800 px-3 py-2 text-sm outline-none" />
          <button onClick={() => setPreview(v => !v)} className="rounded bg-zinc-800 px-3 text-sm text-zinc-400">{preview ? 'Editar' : 'Preview'}</button>
        </div>
        {preview ? (
          <pre className="h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 text-sm text-zinc-300">{task ? body : (body || '(descrição)')}</pre>
        ) : (
          <textarea value={body} onChange={e => setBody(e.target.value)}
            placeholder={task ? '' : 'Descrição (markdown)'} spellCheck={false}
            className="h-64 w-full resize-none rounded bg-zinc-950 p-3 font-mono text-sm outline-none" />
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancelar</button>
          <button disabled={!title.trim()}
            onClick={() => onSave(task
              ? { title, priority, tags: splitTags(tags), model: model || null, body }
              : { title, priority, tags: splitTags(tags), model: model || null, description: body })}
            className="rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-sky-950 hover:bg-sky-400 disabled:opacity-40">Salvar</button>
        </div>
      </div>
    </Modal>
  )
}
const splitTags = s => s.split(',').map(t => t.trim()).filter(Boolean)

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
    <Modal onClose={phase === 'loading' ? () => {} : onClose} title={`Sugerir tasks — ${project.name}`}>
      {error && <div className="mb-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</div>}

      {phase === 'pick' && (
        <div className="space-y-3">
          <div className="text-sm text-zinc-400">
            O Claude vai ler o projeto (somente leitura) e sugerir tasks dos tipos selecionados.
            As criadas entram no Backlog com as tags <Tag>{SUGGEST_TAG}</Tag> + tipo.
          </div>
          {types === null ? (
            <div className="text-sm text-zinc-500">carregando…</div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(types).map(([key, label]) => (
                <label key={key} className={`flex cursor-pointer items-start gap-2 rounded border p-2.5 text-sm ${picked[key] ? 'border-violet-700 bg-violet-950/30' : 'border-zinc-800'}`}>
                  <input type="checkbox" checked={!!picked[key]} className="mt-0.5"
                    onChange={e => setPicked(p => ({ ...p, [key]: e.target.checked }))} />
                  <span>
                    <span className="font-medium text-zinc-200">{key}</span>
                    <span className="mt-0.5 block text-xs text-zinc-500">{label}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded px-4 py-2 text-sm text-zinc-400">Cancelar</button>
            <button onClick={analyze} disabled={!pickedKeys.length}
              className="rounded bg-violet-700 px-4 py-2 text-sm font-medium disabled:opacity-40">Analisar projeto</button>
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="flex flex-col items-center gap-3 py-10 text-sm text-zinc-400">
          <span className="size-6 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
          Analisando o projeto… isso pode levar alguns minutos.
        </div>
      )}

      {(phase === 'results' || phase === 'creating') && (
        <div className="space-y-3">
          <div className="flex items-center text-sm text-zinc-400">
            <span>{suggestions.length} sugestão(ões){costUsd != null ? ` · $${Number(costUsd).toFixed(3)}` : ''}</span>
            <div className="flex-1" />
            <button onClick={() => setSelected(Object.fromEntries(suggestions.map((_, i) => [i, selectedCount < suggestions.length])))}
              className="text-xs text-violet-400 hover:underline">
              {selectedCount < suggestions.length ? 'selecionar todas' : 'desmarcar todas'}
            </button>
          </div>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {suggestions.length === 0 && <div className="text-sm text-zinc-500">Nenhuma sugestão retornada.</div>}
            {suggestions.map((s, i) => (
              <label key={i} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${selected[i] ? 'border-violet-800 bg-violet-950/20' : 'border-zinc-800 opacity-60'}`}>
                <input type="checkbox" checked={!!selected[i]} className="mt-1"
                  onChange={e => setSelected(sel => ({ ...sel, [i]: e.target.checked }))} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-zinc-200">{s.title}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${PRIORITY_STYLE[s.priority] || PRIORITY_STYLE.medium}`}>{s.priority}</span>
                    <Tag>{s.type}</Tag>
                  </span>
                  {s.description && <span className="mt-1 block whitespace-pre-wrap text-xs text-zinc-500">{s.description}</span>}
                </span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setPhase('pick')} disabled={phase === 'creating'}
              className="rounded px-4 py-2 text-sm text-zinc-400 disabled:opacity-40">← Refazer</button>
            <button onClick={create} disabled={!selectedCount || phase === 'creating'}
              className="rounded bg-violet-700 px-4 py-2 text-sm font-medium disabled:opacity-40">
              {phase === 'creating' ? 'criando…' : `Criar ${selectedCount} no Backlog`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
const Tag = ({ children }) => (
  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{children}</span>
)

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
    <div className="fixed inset-y-0 right-0 z-40 flex w-[560px] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <span className="text-sm font-semibold">Log — {taskId}</span>
        {active && <span className="size-2 animate-pulse rounded-full bg-emerald-400" />}
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-zinc-500">
          <input type="checkbox" checked={debug} onChange={e => setDebug(e.target.checked)} /> JSON bruto
        </label>
        {active && <button onClick={onKill} className="rounded bg-red-900 px-2 py-1 text-xs text-red-200">Matar sessão</button>}
        <button onClick={onClose} className="text-zinc-500 hover:text-white">✕</button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-4 font-mono text-xs">
        {history === null && all.length === 0 && <div className="text-zinc-600">Carregando log…</div>}
        {history !== null && all.length === 0 && <div className="text-zinc-600">Sem eventos ainda…</div>}
        {all.map((e, i) => <LogEvent key={i} event={e} debug={debug} />)}
        <div ref={endRef} />
      </div>
    </div>
  )
}

function LogEvent({ event, debug }) {
  if (debug) return <pre className="whitespace-pre-wrap break-all text-zinc-500">{JSON.stringify(event)}</pre>
  const deny = JSON.stringify(event).includes('"deny"')
  if (event.type === 'assistant' || event.type === 'user') {
    const content = event.message?.content || []
    return content.map((c, i) => {
      if (c.type === 'text') return <div key={i} className="whitespace-pre-wrap text-zinc-300">{c.text}</div>
      if (c.type === 'tool_use') return <div key={i} className="text-violet-400">⚙ {c.name} {summarize(c.input)}</div>
      if (c.type === 'tool_result') {
        const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
        const isDeny = /permissionDecision.{1,4}deny|blocked|bloquead/i.test(txt)
        return <div key={i} className={`whitespace-pre-wrap ${isDeny ? 'rounded bg-red-950/60 p-1.5 text-red-300' : 'text-zinc-600'}`}>{txt.slice(0, 400)}</div>
      }
      return null
    })
  }
  if (event.type === 'result') {
    return <div className="rounded bg-zinc-900 p-2 text-emerald-400">✓ fim — ${event.total_cost_usd?.toFixed?.(3)} · {(event.duration_ms / 1000).toFixed(0)}s · {event.num_turns} turnos</div>
  }
  if (event.type === 'system') return <div className="text-zinc-600">[{event.subtype}] sessão {event.session_id?.slice(0, 8)}</div>
  return <div className={deny ? 'text-red-400' : 'text-zinc-600'}>{JSON.stringify(event).slice(0, 200)}</div>
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
    <Modal onClose={onClose} title="Ações manuais pendentes">
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        {pend.length === 0 && <div className="text-sm text-zinc-500">Nenhuma ação pendente. 🎉</div>}
        {pend.map(a => (
          <div key={a.id} className="rounded-md border border-amber-800/60 bg-amber-950/30 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium text-amber-300">{a.label}</span>
              <button onClick={() => onResolve(a.id)} className="rounded bg-amber-600 px-2 py-1 text-xs font-medium text-black">Marcar como resolvido</button>
            </div>
            {a.command && <code className="mt-2 block overflow-x-auto rounded bg-zinc-950 p-2 text-xs text-zinc-300">{a.command}</code>}
            <div className="mt-1.5 text-xs text-zinc-500">{a.timestamp}{a.taskId ? ` · task ${a.taskId}` : ''} · {a.id}</div>
          </div>
        ))}
        {done.length > 0 && <div className="pt-2 text-xs text-zinc-600">{done.length} resolvida(s)</div>}
      </div>
    </Modal>
  )
}

function GitCheck({ label, desc, checked, disabled, onChange }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={e => onChange(e.target.checked)} className="mt-0.5" />
      <span>
        <span className="text-zinc-200">{label}</span>
        {desc && <span className="mt-0.5 block text-xs text-zinc-500">{desc}</span>}
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
    <div className="space-y-3 rounded-md border border-zinc-800 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Dev server</div>
      <label className="block">
        <span className="text-zinc-200">Comando</span>
        <input value={command} onChange={e => setCommand(e.target.value)} onBlur={save}
          placeholder="npm run dev"
          className="mt-1 w-full rounded bg-zinc-800 px-2 py-1.5 font-mono text-sm outline-none placeholder:text-zinc-600" />
        <span className="mt-1 block text-xs text-zinc-500">roda no diretório do projeto ({project.path})</span>
      </label>
      <label className="block">
        <span className="text-zinc-200">URL</span>
        <input value={url} onChange={e => setUrl(e.target.value)} onBlur={save}
          placeholder="http://localhost:3000"
          className="mt-1 w-full rounded bg-zinc-800 px-2 py-1.5 font-mono text-sm outline-none placeholder:text-zinc-600" />
        <span className="mt-1 block text-xs text-zinc-500">aberta no Chrome ~2,5s após iniciar o comando</span>
      </label>
    </div>
  )
}

const CONFIG_GROUPS = [
  { key: 'settings', label: 'Settings' },
  { key: 'mcp', label: 'MCP' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'skills', label: 'Skills' },
  { key: 'agents', label: 'Agents' },
  { key: 'commands', label: 'Commands' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'outros', label: 'Outros' },
]

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
    if (dirty && !confirm('Descartar alterações não salvas neste arquivo?')) return
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
    .map(g => ({ ...g, items: (files || []).filter(f => f.category === g.key) }))
    .filter(g => g.items.length)

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onMouseDown={onClose} />
      <div className="fixed inset-y-0 right-0 z-40 flex w-[900px] max-w-full flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <h2 className="font-semibold">Config do Claude — {project.name}</h2>
          <span className="text-xs text-zinc-500">settings · mcp · hooks · skills · agents · commands</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-zinc-500 hover:text-white">✕</button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 overflow-y-auto border-r border-zinc-800 py-2">
            {files === null && <div className="px-4 py-2 text-xs text-zinc-500">carregando…</div>}
            {files?.length === 0 && <div className="px-4 py-2 text-xs text-zinc-500">Nenhum arquivo de config encontrado. Rode o bootstrap para criar .claude/settings.json.</div>}
            {grouped.map(g => (
              <div key={g.key} className="mb-1">
                <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">{g.label}</div>
                {g.items.map(f => (
                  <button key={f.path} onClick={() => open(f.path)}
                    className={`block w-full truncate px-4 py-1.5 text-left font-mono text-xs ${selected === f.path ? 'bg-zinc-800 text-sky-300' : 'text-zinc-400 hover:bg-zinc-800/50'}`}
                    title={f.path}>
                    {f.path.replace(/^\.claude\//, '')}
                    {selected === f.path && dirty && <span className="ml-1 text-amber-400">•</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">Selecione um arquivo para ver/editar.</div>
            ) : (
              <>
                <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
                  <span className="truncate font-mono text-xs text-zinc-400">{selected}</span>
                  <div className="flex-1" />
                  {savedAt > 0 && !dirty && <span className="text-xs text-emerald-400">salvo ✓</span>}
                  <button onClick={save} disabled={!dirty || saving}
                    className="rounded bg-sky-600 px-3 py-1 text-sm font-medium disabled:opacity-40">{saving ? 'salvando…' : 'Salvar'}</button>
                </div>
                {error && <div className="border-b border-red-900 bg-red-950/40 px-4 py-2 text-xs text-red-300">{error}</div>}
                {loading ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">carregando…</div>
                ) : (
                  <textarea value={content} onChange={e => setContent(e.target.value)} spellCheck={false}
                    className="flex-1 resize-none bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-200 outline-none" />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function SettingsModal({ project, onClose, onPatch, onRemove, queue, onConcurrency }) {
  const [confirmRemove, setConfirmRemove] = useState(0)
  const g = project.git || {}
  const [baseBranch, setBaseBranch] = useState(g.baseBranch ?? 'main')
  const [timeoutMin, setTimeoutMin] = useState(String(Math.round((project.timeoutMs || DEFAULT_TIMEOUT_MS) / 60000)))
  const maxConc = queue?.maxConcurrency || 1
  const patchGit = patch => onPatch({ git: patch })

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
      <div className="fixed inset-0 z-40 bg-black/60" onMouseDown={onClose} />
      <div className="fixed inset-y-0 right-0 z-40 flex w-[560px] max-w-full flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <h2 className="font-semibold">Configurações — {project.name}</h2>
          <div className="flex-1" />
          <button onClick={onClose} className="text-zinc-500 hover:text-white">✕</button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
        <div className="text-xs text-zinc-500">{project.path}</div>

        <label className="flex items-center gap-3">
          <span className="text-zinc-200">Modelo default</span>
          <select value={project.defaultModel || ''} onChange={e => onPatch({ defaultModel: e.target.value || null })}
            className="rounded bg-zinc-800 px-2 py-1 text-sm outline-none">
            <option value="">default do claude-code</option>
            {['fable', 'opus', 'sonnet', 'haiku'].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="text-xs text-zinc-500">tasks sem modelo próprio usam este</span>
        </label>

        <div className="flex items-center gap-3">
          <span className="text-zinc-200">Tasks simultâneas</span>
          <div className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
            <button onClick={() => onConcurrency(maxConc - 1)} disabled={maxConc <= 1}
              className="px-1 text-zinc-500 hover:text-white disabled:opacity-30">−</button>
            <span className="font-mono text-zinc-200">{maxConc}×</span>
            <button onClick={() => onConcurrency(maxConc + 1)} disabled={maxConc >= 8}
              className="px-1 text-zinc-500 hover:text-white disabled:opacity-30">+</button>
          </div>
          <span className="text-xs text-zinc-500">execuções em paralelo (global). Projetos sem worktree isolado ficam limitados a 1 por vez.</span>
        </div>

        <label className="flex items-center gap-3">
          <span className="text-zinc-200">Timeout da execução (minutos)</span>
          <input type="number" min={1} max={240} value={timeoutMin}
            onChange={e => setTimeoutMin(e.target.value)}
            onBlur={commitTimeout}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            className="w-20 rounded bg-zinc-800 px-2 py-1 text-sm outline-none ring-1 ring-inset ring-zinc-700/60 focus:ring-sky-600" />
          <span className="text-xs text-zinc-500">entre 1 e 240 min. Vale a partir do próximo run.</span>
        </label>

        <DevServerSettings project={project} onPatch={onPatch} />

        <div className="space-y-3 rounded-md border border-zinc-800 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Git</div>
          <label className={`flex items-center gap-3 ${g.useCurrentBranch ? 'opacity-40' : ''}`}>
            <span className="text-zinc-200">Branch principal</span>
            <input value={baseBranch} disabled={!!g.useCurrentBranch}
              onChange={e => setBaseBranch(e.target.value)}
              onBlur={() => patchGit({ baseBranch: baseBranch.trim() || 'main' })}
              placeholder="main"
              className="w-40 rounded bg-zinc-800 px-2 py-1 text-sm outline-none" />
            <span className="text-xs text-zinc-500">o desenvolvimento parte dela</span>
          </label>
          <GitCheck label="Dar pull na branch principal antes de iniciar cada task"
            checked={!!g.pullBeforeStart} disabled={!!g.useCurrentBranch}
            onChange={v => patchGit({ pullBeforeStart: v })} />
          <GitCheck label="Usar a branch atual (não trocar para a principal)"
            desc="Ignora a branch principal e o pull: a task parte do estado atual do repositório."
            checked={!!g.useCurrentBranch}
            onChange={v => patchGit({ useCurrentBranch: v })} />
          <GitCheck label="Commitar/push em branch nova (kanban/<task-id>)"
            desc={g.useWorktree
              ? 'Com worktree ativo a branch nova é obrigatória (exigência do git).'
              : 'Desmarcado: commita na branch de partida. Atenção: os guardrails bloqueiam commit em main/master.'}
            checked={!!g.useWorktree || !!g.commitToNewBranch} disabled={!!g.useWorktree}
            onChange={v => patchGit({ commitToNewBranch: v })} />
          <GitCheck label="Usar worktree isolado por task"
            desc="Cada task roda em um worktree próprio (~/.claude-kanban/worktrees), sem mexer no seu checkout."
            checked={!!g.useWorktree}
            onChange={v => patchGit({ useWorktree: v })} />
          <GitCheck label="Push automático ao concluir"
            desc="Desmarcado: a task só commita local; você faz o push manualmente."
            checked={!!g.autoPush}
            onChange={v => patchGit({ autoPush: v })} />
          <GitCheck label="Abrir PR automaticamente (gh pr create)"
            desc={g.autoPush ? 'Requer o GitHub CLI (gh) autenticado no repositório.' : 'Requer push automático ativo.'}
            checked={!!g.autoPush && !!g.autoPR} disabled={!g.autoPush}
            onChange={v => patchGit({ autoPR: v })} />
          <GitCheck label="Gerar descrição da PR automaticamente"
            desc="Desmarcado: a PR sai com descrição mínima, para você escrever depois."
            checked={!!g.autoPRDescription} disabled={!g.autoPush || !g.autoPR}
            onChange={v => patchGit({ autoPRDescription: v })} />
        </div>
        <label className="flex items-start gap-3 rounded-md border border-red-900/50 bg-red-950/20 p-3">
          <input type="checkbox" checked={!!project.skipPermissions}
            onChange={e => onPatch({ skipPermissions: e.target.checked })} className="mt-0.5" />
          <span>
            <span className="font-medium text-red-300">Skip permissions (--dangerously-skip-permissions)</span>
            <span className="mt-1 block text-xs text-zinc-400">
              Suprime os prompts de permissão nas próximas sessões deste projeto. Os guardrails determinísticos
              (não ler .env, não commitar em main, não deletar branches/arquivos externos) continuam ativos.
              Sessões já em execução não são afetadas.
            </span>
          </span>
        </label>
        <button onClick={() => api.rebootstrap(project.id).then(() => onPatch({}))}
          className="rounded bg-zinc-800 px-3 py-2 text-zinc-300">Re-rodar bootstrap (atualizar guardrails/skill)</button>
        <div className="border-t border-zinc-800 pt-4">
          {confirmRemove === 0 && (
            <div className="flex gap-3">
              <button onClick={() => onRemove(false)} className="rounded bg-zinc-800 px-3 py-2 text-zinc-300">Remover projeto do app</button>
              <button onClick={() => setConfirmRemove(1)} className="rounded bg-red-950 px-3 py-2 text-red-300">Remover + desinstalar guardrails</button>
            </div>
          )}
          {confirmRemove === 1 && (
            <div className="space-y-2 rounded border border-red-900 bg-red-950/30 p-3">
              <div className="text-red-300">Isso reverte o merge no settings.json e apaga .claude/claude-kanban/ (incluindo as tasks). Confirma?</div>
              <div className="flex gap-2">
                <button onClick={() => setConfirmRemove(2)} className="rounded bg-red-800 px-3 py-1.5 text-xs">Sim, continuar</button>
                <button onClick={() => setConfirmRemove(0)} className="rounded bg-zinc-800 px-3 py-1.5 text-xs">Cancelar</button>
              </div>
            </div>
          )}
          {confirmRemove === 2 && (
            <div className="space-y-2 rounded border border-red-700 bg-red-950/50 p-3">
              <div className="font-medium text-red-200">Última confirmação: desinstalar guardrails e remover o projeto?</div>
              <div className="flex gap-2">
                <button onClick={() => onRemove(true)} className="rounded bg-red-600 px-3 py-1.5 text-xs font-semibold">DESINSTALAR</button>
                <button onClick={() => setConfirmRemove(0)} className="rounded bg-zinc-800 px-3 py-1.5 text-xs">Cancelar</button>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </>
  )
}

function QueueBar({ queue, tasks, projects, onKill, onReorder }) {
  const items = queue.queue
  if (!(queue.actives || []).length && items.length === 0) return null
  const label = q => {
    const t = tasks.find(x => x.id === q.taskId)
    const p = projects.find(x => x.id === q.projectId)
    return `${p ? p.name + ' · ' : ''}${t ? t.title : q.taskId}`
  }
  const move = (i, dir) => {
    const ids = items.map(q => q.taskId)
    const j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    onReorder(ids)
  }
  return (
    <footer className="flex items-center gap-3 overflow-x-auto border-t border-zinc-800/80 bg-zinc-950/70 px-4 py-2 text-sm backdrop-blur">
      {(queue.actives || []).map(a => (
        <div key={a.taskId} className="flex shrink-0 items-center gap-2 rounded bg-emerald-950/60 px-3 py-1.5">
          <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-emerald-300">{label(a)}</span>
          <button onClick={() => onKill(a.taskId)} className="ml-1 text-xs text-red-400 hover:underline">matar</button>
        </div>
      ))}
      {items.map((q, i) => (
        <div key={q.taskId} className="flex shrink-0 items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-zinc-400">
          <span className="text-xs text-zinc-600">#{i + 1}</span> {label(q)}
          <button onClick={() => move(i, -1)} className="px-0.5 text-zinc-600 hover:text-white">◂</button>
          <button onClick={() => move(i, 1)} className="px-0.5 text-zinc-600 hover:text-white">▸</button>
        </div>
      ))}
    </footer>
  )
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl rounded-xl border border-zinc-700/60 bg-zinc-900 p-5 shadow-2xl shadow-black/50">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}
