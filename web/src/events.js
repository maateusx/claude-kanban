// Reducer puro dos eventos do WebSocket. Fica fora do App.jsx para ser testável
// sem DOM: applyEvent só transforma estado; os efeitos colaterais (refetch de
// projetos/fila/tasks) saem como uma lista de nomes que o App executa.

export const LOG_LIMIT = 500

export const initialState = { tasks: [], pending: [], logs: {} }

// Efeitos possíveis: 'projects' | 'queue' | 'tasks'
export function effectsFor(evt, currentProjectId) {
  switch (evt.type) {
    case 'pending.updated':
      return ['projects']
    case 'run.queued':
    case 'run.dequeued':
    case 'run.queue':
    case 'run.started':
    case 'run.killed':
      return ['queue']
    case 'run.finished':
      return evt.projectId === currentProjectId ? ['queue', 'tasks'] : ['queue']
    case 'devserver.updated':
    case 'project.updated':
      return ['projects']
    default:
      return []
  }
}

export function applyEvent(state, evt, currentProjectId) {
  const mine = evt.projectId === currentProjectId

  switch (evt.type) {
    case 'task.upserted': {
      if (!mine) return state
      const i = state.tasks.findIndex(t => t.id === evt.task.id)
      if (i === -1) return { ...state, tasks: [...state.tasks, evt.task] }
      const tasks = [...state.tasks]
      tasks[i] = evt.task
      return { ...state, tasks }
    }
    case 'task.removed':
      if (!mine) return state
      return { ...state, tasks: state.tasks.filter(t => t.id !== evt.taskId) }
    case 'pending.updated':
      if (!mine) return state
      return { ...state, pending: evt.actions }
    case 'run.log': {
      const prev = state.logs[evt.taskId] || []
      // slice(-LIMIT) antes de concatenar mantém no máximo LIMIT+1... por isso o corte é depois.
      const next = [...prev, evt.event].slice(-LOG_LIMIT)
      return { ...state, logs: { ...state.logs, [evt.taskId]: next } }
    }
    default:
      return state
  }
}

// Traduz um evento do WS em notificações do sistema. Puro: o disparo em si mora
// em notify.js. `ctx.tasks` só tem as tasks do projeto selecionado — para runs de
// outros projetos o título da task não está carregado e caímos no id.
// `ctx.seenPendingIds` são as pending-actions já notificadas; o App atualiza esse
// conjunto depois de cada pending.updated.
export function notificationsFor(evt, ctx) {
  const { projects = [], tasks = [], seenPendingIds = new Set() } = ctx || {}
  const projectName = projects.find(p => p.id === evt.projectId)?.name || 'claude-kanban'
  const taskLabel = id => tasks.find(t => t.id === id)?.title || id

  switch (evt.type) {
    case 'run.finished': {
      const body = evt.humanRequest
        ? `⏸ Precisa de decisão humana: ${taskLabel(evt.taskId)}`
        : evt.exitCode === 0
          ? `✓ Concluída: ${taskLabel(evt.taskId)}`
          : `✕ Falhou: ${taskLabel(evt.taskId)}`
      return [{ key: `run.finished:${evt.taskId}`, title: projectName, body, projectId: evt.projectId, taskId: evt.taskId }]
    }
    case 'pending.updated':
      return (evt.actions || [])
        .filter(a => a.status === 'pending' && !seenPendingIds.has(a.id))
        .map(a => ({
          key: `pending:${a.id}`,
          title: projectName,
          body: `🔒 Ação bloqueada pelos guardrails: ${a.label}`,
          projectId: evt.projectId,
          taskId: a.taskId || null,
        }))
    default:
      return []
  }
}

// Ids das pending-actions de um evento pending.updated — o App usa para não
// notificar duas vezes a mesma ação (o watcher reemite a lista inteira).
export function pendingIds(evt) {
  return (evt.actions || []).map(a => a.id)
}

// Reducer do App: envolve applyEvent e as escritas vindas das chamadas REST.
export function reducer(state, action) {
  switch (action.type) {
    case 'setTasks':
      return { ...state, tasks: action.tasks }
    case 'setPending':
      return { ...state, pending: action.pending }
    case 'ws':
      return applyEvent(state, action.evt, action.projectId)
    default:
      return state
  }
}
