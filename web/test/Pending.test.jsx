import React from 'react'
import { MODELS } from '../src/models.js'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
    health: vi.fn(), usage: vi.fn(), projects: vi.fn(), queue: vi.fn(), models: vi.fn(),
    tasks: vi.fn(), pending: vi.fn(), patchTask: vi.fn(), runPending: vi.fn(), resolvePending: vi.fn(),
  },
  connectWS: vi.fn(() => () => {}),
}))

const { api } = await import('../src/api.js')
const { default: App } = await import('../src/App.jsx')

const PROJECT = { id: 'p1', name: 'Proj', bootstrap: 'ok', branch: 'main' }
const ACTION = {
  id: 'pa-abc123', timestamp: '2026-07-10T16:02:11Z', label: 'comando bloqueado',
  command: 'echo ola', taskId: null, status: 'pending',
}

beforeEach(() => {
  api.health.mockResolvedValue({ ok: true, claudeAvailable: true })
  api.usage.mockResolvedValue({ available: false })
  api.projects.mockResolvedValue({ projects: [PROJECT] })
  api.queue.mockResolvedValue({ actives: [], queue: [], maxConcurrency: 1 })
  api.models.mockResolvedValue({ models: MODELS, fetchedAt: null, source: 'fallback' })
  api.pending.mockResolvedValue({ actions: [ACTION] })
  api.tasks.mockResolvedValue({ tasks: [] })
})

const openPanel = async () => {
  render(<App />)
  await userEvent.click(await screen.findByText(/Ações manuais \(1\)/))
}

describe('modal de ações manuais', () => {
  it('executa o comando e mostra a saída no item', async () => {
    api.runPending.mockResolvedValue({ ...ACTION, output: 'ola\n', exitCode: 0, error: null })
    await openPanel()
    await userEvent.click(screen.getByText('Executar comando'))
    expect(api.runPending).toHaveBeenCalledWith('p1', 'pa-abc123')
    expect(await screen.findByText('ola')).toBeTruthy()
    expect(screen.getByText('exit 0')).toBeTruthy()
  })

  it('mostra o exit code quando o comando falha', async () => {
    api.runPending.mockResolvedValue({ ...ACTION, output: 'boom', exitCode: 3, error: null })
    await openPanel()
    await userEvent.click(screen.getByText('Executar comando'))
    expect(await screen.findByText('exit 3')).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
  })

  it('não oferece executar quando a ação não tem comando', async () => {
    api.pending.mockResolvedValue({ actions: [{ ...ACTION, command: null }] })
    await openPanel()
    expect(screen.queryByText('Executar comando')).toBeNull()
    expect(screen.getByText('Marcar como resolvido')).toBeTruthy()
  })
})
