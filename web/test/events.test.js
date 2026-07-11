import { describe, it, expect } from 'vitest'
import { applyEvent, effectsFor, reducer, initialState, LOG_LIMIT } from '../src/events.js'

const PID = 'p1'
const task = (id, over = {}) => ({ id, title: id, status: 'todo', ...over })
const state = over => ({ ...initialState, ...over })

describe('applyEvent — task.upserted', () => {
  it('insere task nova do projeto atual', () => {
    const next = applyEvent(state(), { type: 'task.upserted', projectId: PID, task: task('a') }, PID)
    expect(next.tasks).toEqual([task('a')])
  })

  it('atualiza task existente no lugar, sem duplicar', () => {
    const prev = state({ tasks: [task('a'), task('b')] })
    const updated = task('a', { status: 'done' })
    const next = applyEvent(prev, { type: 'task.upserted', projectId: PID, task: updated }, PID)
    expect(next.tasks).toEqual([updated, task('b')])
  })

  it('ignora evento de outro projeto', () => {
    const prev = state({ tasks: [task('a')] })
    const next = applyEvent(prev, { type: 'task.upserted', projectId: 'outro', task: task('z') }, PID)
    expect(next).toBe(prev)
  })

  it('não muta o estado anterior', () => {
    const prev = state({ tasks: [task('a')] })
    applyEvent(prev, { type: 'task.upserted', projectId: PID, task: task('b') }, PID)
    expect(prev.tasks).toHaveLength(1)
  })
})

describe('applyEvent — task.removed', () => {
  it('remove a task do projeto atual', () => {
    const prev = state({ tasks: [task('a'), task('b')] })
    const next = applyEvent(prev, { type: 'task.removed', projectId: PID, taskId: 'a' }, PID)
    expect(next.tasks).toEqual([task('b')])
  })

  it('ignora evento de outro projeto', () => {
    const prev = state({ tasks: [task('a')] })
    const next = applyEvent(prev, { type: 'task.removed', projectId: 'outro', taskId: 'a' }, PID)
    expect(next).toBe(prev)
  })
})

describe('applyEvent — pending.updated', () => {
  it('substitui a lista de ações do projeto atual', () => {
    const actions = [{ id: 'pa-1', status: 'pending' }]
    const next = applyEvent(state(), { type: 'pending.updated', projectId: PID, actions }, PID)
    expect(next.pending).toBe(actions)
  })

  it('ignora ações de outro projeto', () => {
    const prev = state({ pending: [{ id: 'pa-1' }] })
    const next = applyEvent(prev, { type: 'pending.updated', projectId: 'outro', actions: [] }, PID)
    expect(next).toBe(prev)
  })
})

describe('applyEvent — run.log', () => {
  it('acumula eventos por taskId', () => {
    let s = state()
    s = applyEvent(s, { type: 'run.log', taskId: 't1', event: { n: 1 } }, PID)
    s = applyEvent(s, { type: 'run.log', taskId: 't1', event: { n: 2 } }, PID)
    s = applyEvent(s, { type: 'run.log', taskId: 't2', event: { n: 3 } }, PID)
    expect(s.logs.t1).toEqual([{ n: 1 }, { n: 2 }])
    expect(s.logs.t2).toEqual([{ n: 3 }])
  })

  it(`trunca o buffer em ${LOG_LIMIT} eventos, mantendo os mais recentes`, () => {
    let s = state()
    for (let n = 0; n < LOG_LIMIT + 50; n++) {
      s = applyEvent(s, { type: 'run.log', taskId: 't1', event: { n } }, PID)
    }
    expect(s.logs.t1).toHaveLength(LOG_LIMIT)
    expect(s.logs.t1[0]).toEqual({ n: 50 })
    expect(s.logs.t1.at(-1)).toEqual({ n: LOG_LIMIT + 49 })
  })

  it('não filtra por projeto — o log é endereçado por taskId', () => {
    const next = applyEvent(state(), { type: 'run.log', projectId: 'outro', taskId: 't1', event: { n: 1 } }, PID)
    expect(next.logs.t1).toHaveLength(1)
  })
})

describe('applyEvent — eventos sem estado', () => {
  it('devolve o mesmo objeto para tipos desconhecidos ou só-efeito', () => {
    const prev = state({ tasks: [task('a')] })
    for (const type of ['run.started', 'project.updated', 'nope']) {
      expect(applyEvent(prev, { type, projectId: PID }, PID)).toBe(prev)
    }
  })
})

describe('effectsFor', () => {
  it('refetch da fila nos eventos de run', () => {
    for (const type of ['run.queued', 'run.queue', 'run.started', 'run.killed']) {
      expect(effectsFor({ type, projectId: PID }, PID)).toEqual(['queue'])
    }
  })

  it('run.finished do projeto atual recarrega fila e tasks', () => {
    expect(effectsFor({ type: 'run.finished', projectId: PID }, PID)).toEqual(['queue', 'tasks'])
  })

  it('run.finished de outro projeto recarrega só a fila', () => {
    expect(effectsFor({ type: 'run.finished', projectId: 'outro' }, PID)).toEqual(['queue'])
  })

  it('pending/project/devserver recarregam projetos, mesmo de outro projeto (badge da sidebar)', () => {
    expect(effectsFor({ type: 'pending.updated', projectId: 'outro' }, PID)).toEqual(['projects'])
    expect(effectsFor({ type: 'project.updated', projectId: 'outro' }, PID)).toEqual(['projects'])
    expect(effectsFor({ type: 'devserver.updated', projectId: PID }, PID)).toEqual(['projects'])
  })

  it('eventos de task não disparam refetch', () => {
    expect(effectsFor({ type: 'task.upserted', projectId: PID }, PID)).toEqual([])
    expect(effectsFor({ type: 'run.log', taskId: 't1' }, PID)).toEqual([])
  })
})

describe('reducer', () => {
  it('setTasks/setPending sobrescrevem a lista', () => {
    const s = reducer(reducer(initialState, { type: 'setTasks', tasks: [task('a')] }), { type: 'setPending', pending: [{ id: 'pa-1' }] })
    expect(s.tasks).toEqual([task('a')])
    expect(s.pending).toEqual([{ id: 'pa-1' }])
  })

  it('delega o tipo ws para applyEvent', () => {
    const s = reducer(initialState, { type: 'ws', projectId: PID, evt: { type: 'task.upserted', projectId: PID, task: task('a') } })
    expect(s.tasks).toEqual([task('a')])
  })
})
