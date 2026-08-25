import React from 'react'
import { MODELS } from '../src/models.js'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mesmo stub de dnd-kit dos outros testes de App: o board precisa montar, mas
// nada aqui depende de drag.
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
    health: vi.fn(), usage: vi.fn(), projects: vi.fn(), queue: vi.fn(), models: vi.fn(),
    tasks: vi.fn(), pending: vi.fn(), stats: vi.fn(),
  },
  connectWS: vi.fn(handler => { onEvent = handler; return () => {} }),
}))

let onEvent
const { api } = await import('../src/api.js')
const { default: App } = await import('../src/App.jsx')

const PROJECT = { id: 'p1', name: 'Proj', bootstrap: 'ok', branch: 'main' }
const TASK = { id: 'task-1', title: 'Minha task', status: 'done', priority: 'medium', tags: [] }

const statsOf = costUsd => ({
  period: { days: 30, since: null },
  totals: { runs: 2, tasks: 3, costUsd, durationMs: 90_000, numTurns: 15, attempts: 4, successes: 3, avgCostUsd: costUsd / 2, successRate: 0.75 },
  byDay: [{ date: '2026-07-13', costUsd, runs: 2, durationMs: 90_000, numTurns: 15, attempts: 4, successes: 3 }],
  byModel: [{ model: 'claude-opus-4-8', costUsd, runs: 2, durationMs: 90_000, numTurns: 15, attempts: 4, successes: 3 }],
  byStatus: [{ status: 'done', costUsd, runs: 2 }],
  top: [{ id: 'task-1', title: 'Minha task', costUsd, durationMs: 60_000, numTurns: 10, attempts: 1, exitCode: 0, model: 'claude-opus-4-8' }],
})

beforeEach(() => {
  api.health.mockResolvedValue({ ok: true, claudeAvailable: true })
  api.usage.mockResolvedValue({ available: false })
  api.projects.mockResolvedValue({ projects: [PROJECT] })
  api.queue.mockResolvedValue({ actives: [], queue: [], maxConcurrency: 1 })
  api.models.mockResolvedValue({ models: MODELS, fetchedAt: null, source: 'fallback' })
  api.pending.mockResolvedValue({ actions: [] })
  api.tasks.mockResolvedValue({ tasks: [TASK] })
  api.stats.mockResolvedValue(statsOf(2.5))
})

// O mesmo valor aparece no tile, no por-modelo e no top — então lemos o número
// pelo rótulo do tile, e não pelo texto solto.
const stat = label => screen.getByText(label).nextSibling.textContent

const openCosts = async () => {
  render(<App />)
  await screen.findByText('Minha task')
  await userEvent.click(screen.getByRole('button', { name: 'Custos' }))
  await screen.findByText('Custo total')
}

describe('view de Custos', () => {
  it('mostra totais, média, taxa de sucesso e o top de tasks caras', async () => {
    await openCosts()

    expect(api.stats).toHaveBeenCalledWith('p1', '30')
    expect(stat('Custo total')).toBe('$2.50')
    expect(stat('Custo médio por task')).toBe('$1.25')
    expect(stat('Taxa de sucesso')).toBe('75%')               // 3 exit 0 / 4 tentativas
    expect(screen.getByText('claude-opus-4-8')).toBeInTheDocument()
    expect(screen.getByText('Top 5 mais caras')).toBeInTheDocument()
  })

  it('troca a janela do período e refaz o fetch', async () => {
    await openCosts()

    await userEvent.click(screen.getByRole('button', { name: '7 dias' }))

    await waitFor(() => expect(api.stats).toHaveBeenCalledWith('p1', '7'))
  })

  it('atualiza ao receber run.finished pelo WebSocket', async () => {
    await openCosts()
    api.stats.mockResolvedValue(statsOf(9))
    api.tasks.mockResolvedValue({ tasks: [{ ...TASK, run: { cost_usd: 9 } }] })

    onEvent({ type: 'run.finished', projectId: 'p1', taskId: 'task-1' })

    await waitFor(() => expect(stat('Custo total')).toBe('$9.00'))
  })

  it('board sem execução nenhuma não quebra a view', async () => {
    api.stats.mockResolvedValue({
      period: { days: 30, since: null },
      totals: { runs: 0, tasks: 1, costUsd: 0, durationMs: 0, numTurns: 0, attempts: 0, successes: 0, avgCostUsd: 0, successRate: null },
      byDay: [], byModel: [], byStatus: [], top: [],
    })
    await openCosts()

    expect(stat('Custo total')).toBe('$0.000')
    expect(stat('Taxa de sucesso')).toBe('—')                 // sem tentativas no período
    expect(screen.getAllByText('Nenhuma execução no período.')).toHaveLength(3)
  })
})
