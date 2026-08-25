import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }) => <div>{children}</div>,
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
    health: vi.fn(), usage: vi.fn(), projects: vi.fn(), queue: vi.fn(),
    tasks: vi.fn(), pending: vi.fn(), removeProject: vi.fn(),
  },
  connectWS: vi.fn(() => () => {}),
}))

const { api } = await import('../src/api.js')
const { default: App } = await import('../src/App.jsx')

const P1 = { id: 'p1', name: 'Proj Um', bootstrap: 'ok', branch: 'main' }
const P2 = { id: 'p2', name: 'Proj Dois', bootstrap: 'ok', branch: 'main' }

beforeEach(() => {
  localStorage.setItem('ck.rail.expanded', '1') // o botão de remover só aparece com o rail aberto
  api.health.mockResolvedValue({ ok: true, claudeAvailable: true })
  api.usage.mockResolvedValue({ available: false })
  api.projects.mockResolvedValue({ projects: [P1, P2] })
  api.queue.mockResolvedValue({ actives: [], queue: [], maxConcurrency: 1 })
  api.pending.mockResolvedValue({ actions: [] })
  api.tasks.mockResolvedValue({ tasks: [] })
  api.removeProject.mockResolvedValue({ ok: true })
})

const removeBtn = async name => {
  const btns = await screen.findAllByRole('button', { name: /Remover projeto do quadro|Remove project from the board/ })
  return btns[[P1, P2].findIndex(p => p.name === name)]
}

describe('remover projeto pelo rail', () => {
  it('pede confirmação e chama a API sem desinstalar guardrails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await userEvent.click(await removeBtn('Proj Dois'))
    expect(window.confirm).toHaveBeenCalled()
    await waitFor(() => expect(api.removeProject).toHaveBeenCalledWith('p2', false))
  })

  it('não chama a API quando a confirmação é cancelada', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<App />)
    await userEvent.click(await removeBtn('Proj Um'))
    expect(api.removeProject).not.toHaveBeenCalled()
  })
})
