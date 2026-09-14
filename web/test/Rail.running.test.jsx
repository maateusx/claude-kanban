import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }) => <div>{children}</div>,
  DragOverlay: () => null,
  PointerSensor: class {},
  KeyboardSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
  closestCorners: () => [],
}))

vi.mock('../src/api.js', () => ({
  api: {
    health: vi.fn(), usage: vi.fn(), projects: vi.fn(), queue: vi.fn(),
    tasks: vi.fn(), pending: vi.fn(), models: vi.fn(),
  },
  connectWS: vi.fn(() => () => {}),
}))

const { api } = await import('../src/api.js')
const { default: App } = await import('../src/App.jsx')

const P1 = { id: 'p1', name: 'Proj Um', bootstrap: 'ok', branch: 'main' }
const P2 = { id: 'p2', name: 'Proj Dois', bootstrap: 'ok', branch: 'main' }

beforeEach(() => {
  api.health.mockResolvedValue({ ok: true, claudeAvailable: true })
  api.usage.mockResolvedValue({ available: false })
  api.projects.mockResolvedValue({ projects: [P1, P2] })
  api.pending.mockResolvedValue({ actions: [] })
  api.tasks.mockResolvedValue({ tasks: [] })
  api.models.mockResolvedValue({ models: [] })
})

describe('indicador de execução no rail', () => {
  it('mostra o spinner no projeto ativo e no indicador da fila', async () => {
    api.queue.mockResolvedValue({ actives: [{ projectId: 'p2', taskId: 't1' }], queue: [], maxConcurrency: 1 })
    render(<App />)
    const rail = within(document.querySelector('aside'))
    const spinners = await rail.findAllByRole('img', { name: 'Rodando' })
    // 1 no avatar do projeto p2 + 1 no QueueIndicator
    expect(spinners).toHaveLength(2)
    expect(spinners.every(s => s.className.includes('animate-spin'))).toBe(true)
    expect(document.querySelector('aside .animate-pulse')).toBeNull()
  })

  it('não mostra nada quando não há execução', async () => {
    api.queue.mockResolvedValue({ actives: [], queue: [], maxConcurrency: 1 })
    render(<App />)
    await screen.findAllByText('Proj Um')
    expect(screen.queryByRole('img', { name: 'Rodando' })).toBeNull()
  })
})
