import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// dnd-kit depende de PointerEvent/coordenadas que o jsdom não simula de forma
// confiável. Trocamos o DndContext por um stub que expõe o onDragEnd como
// botões "soltar em <coluna>" — o que testamos aqui é o handler do App
// (update otimista + rollback), não a biblioteca de drag.
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }) => (
    <div>
      {['todo', 'doing', 'done'].map(col => (
        <button key={col} onClick={() => onDragEnd({ active: { id: 'task-1' }, over: { id: col } })}>
          soltar em {col}
        </button>
      ))}
      {children}
    </div>
  ),
  DragOverlay: () => null,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
  closestCorners: () => [],
}))

vi.mock('../src/api.js', () => ({
  api: {
    health: vi.fn(),
    usage: vi.fn(),
    projects: vi.fn(),
    queue: vi.fn(),
    tasks: vi.fn(),
    pending: vi.fn(),
    patchTask: vi.fn(),
  },
  connectWS: vi.fn(() => () => {}),
}))

const { api } = await import('../src/api.js')
const { default: App } = await import('../src/App.jsx')

const PROJECT = { id: 'p1', name: 'Proj', bootstrap: 'ok', branch: 'main' }
const TASK = { id: 'task-1', title: 'Minha task', status: 'todo', priority: 'medium', tags: [] }
const EMPTY_QUEUE = { actives: [], queue: [], maxConcurrency: 1 }

// Um card vive em exatamente uma coluna: subimos do card até a raiz da coluna
// ([data-column]) e lemos o cabeçalho dela.
const columnOfCard = () => screen.getByText('Minha task').closest('[data-column]').textContent

beforeEach(() => {
  api.health.mockResolvedValue({ ok: true, claudeAvailable: true })
  api.usage.mockResolvedValue({ available: false })
  api.projects.mockResolvedValue({ projects: [PROJECT] })
  api.queue.mockResolvedValue(EMPTY_QUEUE)
  api.pending.mockResolvedValue({ actions: [] })
  api.tasks.mockResolvedValue({ tasks: [TASK] })
})

const renderBoard = async () => {
  render(<App />)
  await screen.findByText('Minha task')
  await waitFor(() => expect(columnOfCard()).toContain('To Do'))
}

describe('onDragEnd', () => {
  it('move a task otimistamente e persiste o novo status', async () => {
    // promise pendente: o card já precisa ter mudado de coluna antes da resposta
    let resolvePatch
    api.patchTask.mockReturnValue(new Promise(res => { resolvePatch = res }))
    await renderBoard()

    await userEvent.click(screen.getByRole('button', { name: 'soltar em doing' }))

    await waitFor(() => expect(columnOfCard()).toContain('Doing'))
    expect(api.patchTask).toHaveBeenCalledWith('p1', 'task-1', { status: 'doing' })
    resolvePatch({ task: { ...TASK, status: 'doing' } })
  })

  it('restaura o status anterior quando o PATCH falha', async () => {
    api.patchTask.mockRejectedValue(new Error('boom'))
    await renderBoard()

    await userEvent.click(screen.getByRole('button', { name: 'soltar em doing' }))

    // o rollback refaz o GET de tasks (2ª chamada), que ainda devolve status 'todo'
    await waitFor(() => expect(api.tasks).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(columnOfCard()).toContain('To Do'))
  })

  it('não faz nada ao soltar na mesma coluna', async () => {
    await renderBoard()

    await userEvent.click(screen.getByRole('button', { name: 'soltar em todo' }))

    expect(api.patchTask).not.toHaveBeenCalled()
    expect(columnOfCard()).toContain('To Do')
  })
})
