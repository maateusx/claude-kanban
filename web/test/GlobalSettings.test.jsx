import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { THEME_KEY } from '../src/theme.js'
import { LANG_KEY } from '../src/i18n.js'

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
    tasks: vi.fn(), pending: vi.fn(), models: vi.fn(), refreshModels: vi.fn(),
  },
  connectWS: vi.fn(() => () => {}),
}))

const { api } = await import('../src/api.js')
const { default: App } = await import('../src/App.jsx')

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  api.health.mockResolvedValue({ ok: true, claudeAvailable: true })
  api.usage.mockResolvedValue({ available: false })
  api.projects.mockResolvedValue({ projects: [{ id: 'p1', name: 'Proj', bootstrap: 'ok', branch: 'main' }] })
  api.queue.mockResolvedValue({ actives: [], queue: [], maxConcurrency: 1 })
  api.pending.mockResolvedValue({ actions: [] })
  api.tasks.mockResolvedValue({ tasks: [] })
  api.models.mockResolvedValue({ models: [], fetchedAt: null, source: 'fallback' })
})

const open = async () => {
  render(<App />)
  await waitFor(() => expect(api.models).toHaveBeenCalled())
  await userEvent.click(screen.getByTitle('Configurações globais (valem para todos os projetos)'))
}

describe('configurações globais em abas', () => {
  it('abre em Execução e as outras abas ficam escondidas até o clique', async () => {
    await open()
    expect(screen.getByText('Tasks simultâneas')).toBeInTheDocument()
    expect(screen.queryByText('Tema')).not.toBeInTheDocument()
    expect(screen.queryByText('Notificações')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Alertas' }))
    expect(screen.getByText('Notificações')).toBeInTheDocument()
    expect(screen.queryByText('Tasks simultâneas')).not.toBeInTheDocument()
  })

  it('a aba Aparência troca o tema e persiste a escolha', async () => {
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Aparência' }))
    expect(screen.getByText('Tema')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Escuro' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')

    await userEvent.click(screen.getByRole('button', { name: 'Claro' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
  })

  it('a aba Aparência oferece o idioma e persiste a escolha', async () => {
    const reload = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ reload })
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Aparência' }))
    expect(screen.getByText('Idioma')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(localStorage.getItem(LANG_KEY)).toBe('en')
    expect(reload).toHaveBeenCalled()   // as strings são resolvidas na importação
    vi.restoreAllMocks()
  })
})
