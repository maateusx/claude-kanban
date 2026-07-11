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
