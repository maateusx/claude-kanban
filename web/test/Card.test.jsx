import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
    tasks: vi.fn(), pending: vi.fn(), patchTask: vi.fn(),
  },
  connectWS: vi.fn(() => () => {}),
}))

const { api } = await import('../src/api.js')
const { default: App, section } = await import('../src/App.jsx')

const PROJECT = { id: 'p1', name: 'Proj', bootstrap: 'ok', branch: 'main' }
const BODY = `
## Descrição

Refatorar o pipeline de RAG.

## Resultado

Feito: reduziu latência.

## Log de erros
`
const TASK = {
  id: 'k7x2m9', title: 'Refatorar pipeline', status: 'doing', priority: 'high',
  tags: ['rag'], body: BODY,
  run: { started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:02:00Z', exit_code: 0, cost_usd: 0.42, duration_ms: 120000, num_turns: 12 },
}

beforeEach(() => {
  api.health.mockResolvedValue({ ok: true, claudeAvailable: true })
  api.usage.mockResolvedValue({ available: false })
  api.projects.mockResolvedValue({ projects: [PROJECT] })
  api.queue.mockResolvedValue({ actives: [], queue: [], maxConcurrency: 1 })
  api.pending.mockResolvedValue({ actions: [] })
  api.tasks.mockResolvedValue({ tasks: [TASK] })
})

describe('section()', () => {
  it('extrai uma seção do corpo do .md sem vazar a seguinte', () => {
    expect(section(BODY, 'Descrição')).toBe('Refatorar o pipeline de RAG.')
    expect(section(BODY, 'Resultado')).toBe('Feito: reduziu latência.')
    expect(section(BODY, 'Log de erros')).toBe('') // só comentário → vazio
    expect(section(BODY, 'Inexistente')).toBe('')
  })
})

describe('card', () => {
  it('mostra key, descrição e o run strip do último run', async () => {
    render(<App />)
    await screen.findByText('Refatorar pipeline')
    expect(screen.getByText('k7x2m9')).toBeTruthy()
    expect(screen.getByText('Refatorar o pipeline de RAG.')).toBeTruthy()
    expect(screen.getByText('concluído')).toBeTruthy()
    expect(screen.getByText('· $0.42')).toBeTruthy()
    expect(screen.getByText('· 12 turns')).toBeTruthy()
  })

  it('clique no card abre o drawer de detalhe com Resultado e Execuções', async () => {
    render(<App />)
    const card = await screen.findByText('Refatorar pipeline')
    await userEvent.click(card)
    expect(screen.getByText('Execuções')).toBeTruthy()
    expect(screen.getByText('Feito: reduziu latência.')).toBeTruthy()
    expect(screen.getByText('Concluída')).toBeTruthy()
  })
})
