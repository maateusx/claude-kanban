import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MODELS, setModels, modelLabel } from '../src/models.js'

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
    tasks: vi.fn(), pending: vi.fn(), models: vi.fn(), refreshModels: vi.fn(),
  },
  connectWS: vi.fn(() => () => {}),
}))

const { api } = await import('../src/api.js')
const { default: App } = await import('../src/App.jsx')

const PROJECT = { id: 'p1', name: 'Proj', bootstrap: 'ok', branch: 'main' }
const BUILTIN = MODELS.map(m => ({ ...m }))

beforeEach(() => {
  setModels(BUILTIN) // outros testes podem ter mutado o array compartilhado
  api.health.mockResolvedValue({ ok: true, claudeAvailable: true })
  api.usage.mockResolvedValue({ available: false })
  api.projects.mockResolvedValue({ projects: [PROJECT] })
  api.queue.mockResolvedValue({ actives: [], queue: [], maxConcurrency: 1 })
  api.pending.mockResolvedValue({ actions: [] })
  api.tasks.mockResolvedValue({ tasks: [] })
  api.models.mockResolvedValue({ models: BUILTIN, fetchedAt: null, source: 'fallback' })
})

const openGlobalSettings = async () => {
  render(<App />)
  await waitFor(() => expect(api.models).toHaveBeenCalled())
  await userEvent.click(screen.getByTitle('Configurações globais (valem para todos os projetos)'))
  await screen.findByText('Modelos')
}

describe('catálogo de modelos', () => {
  it('setModels troca o catálogo mutando o array compartilhado', () => {
    const ref = MODELS
    setModels([{ id: 'claude-omega-9', label: 'Omega 9' }])
    expect(MODELS).toBe(ref)                              // mesma referência: os selects veem a troca
    expect(MODELS.map(m => m.id)).toEqual(['claude-omega-9'])
    expect(modelLabel('claude-omega-9')).toBe('claude-omega-9 (Omega 9)')
    expect(modelLabel('claude-sumiu')).toBe('claude-sumiu') // id desconhecido aparece cru
  })

  it('ignora lista vazia/inválida em vez de zerar o catálogo', () => {
    setModels([])
    setModels(null)
    expect(MODELS.length).toBe(BUILTIN.length)
  })

  it('carrega o catálogo do servidor no boot', async () => {
    api.models.mockResolvedValue({
      models: [{ id: 'claude-omega-9', label: 'Omega 9' }], fetchedAt: '2026-08-25T10:00:00Z', source: 'api',
    })
    await openGlobalSettings()
    expect(screen.getByText('claude-omega-9')).toBeInTheDocument()
  })

  it('o botão atualizar busca na Anthropic e aplica o catálogo novo', async () => {
    await openGlobalSettings()
    expect(screen.getByText('claude-opus-5')).toBeInTheDocument()

    api.refreshModels.mockResolvedValue({
      models: [{ id: 'claude-omega-9', label: 'Omega 9' }], fetchedAt: '2026-08-25T10:00:00Z', source: 'api',
    })
    await userEvent.click(screen.getByRole('button', { name: 'atualizar modelos' }))

    await waitFor(() => expect(screen.getByText('claude-omega-9')).toBeInTheDocument())
    expect(screen.queryByText('claude-opus-5')).not.toBeInTheDocument()
    expect(MODELS.map(m => m.id)).toEqual(['claude-omega-9'])
  })

  it('mostra o erro do servidor e mantém o catálogo anterior', async () => {
    await openGlobalSettings()

    api.refreshModels.mockRejectedValue(new Error('sem credencial do Claude Code'))
    await userEvent.click(screen.getByRole('button', { name: 'atualizar modelos' }))

    await screen.findByText('sem credencial do Claude Code')
    expect(screen.getByText('claude-opus-5')).toBeInTheDocument()
  })
})
