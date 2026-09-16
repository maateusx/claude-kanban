import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
}))

vi.mock('../src/api.js', () => ({
  api: { pickFolder: vi.fn(), plugins: vi.fn(async () => ({ scope: 'local', plugins: [] })) },
  connectWS: vi.fn(() => () => {}),
}))

const { SettingsModal } = await import('../src/App.jsx')

const project = extra => ({ id: 'p1', name: 'Proj', path: '/tmp/p', ...extra })
const open = (p, onPatch) => render(<SettingsModal project={p} onClose={() => {}} onPatch={onPatch} onRemove={() => {}} />)

describe('configurações de autonomia', () => {
  it('liga auto-merge e sandbox', async () => {
    const onPatch = vi.fn()
    open(project(), onPatch)
    await userEvent.click(screen.getByLabelText('Mergear sozinho quando a política deixa', { exact: false }))
    expect(onPatch).toHaveBeenCalledWith({ autopilot: { autoMerge: { enabled: true } } })
    await userEvent.click(screen.getByLabelText('Sandbox do Claude Code', { exact: false }))
    expect(onPatch).toHaveBeenCalledWith({ sandbox: true })
  })

  it('campo numérico só vira PATCH válido no blur', () => {
    const onPatch = vi.fn()
    open(project({ autopilot: { digestHour: null } }), onPatch)
    const hour = screen.getByLabelText('Hora do resumo diário')
    fireEvent.change(hour, { target: { value: '25' } })
    fireEvent.blur(hour)
    expect(onPatch).not.toHaveBeenCalled()
    expect(hour).toHaveValue('')
    fireEvent.change(hour, { target: { value: '18' } })
    fireEvent.blur(hour)
    expect(onPatch).toHaveBeenCalledWith({ autopilot: { digestHour: 18 } })
  })

  it('lista de modelos de retentativa vai como array', () => {
    const onPatch = vi.fn()
    open(project(), onPatch)
    const input = screen.getByText('Modelos nas retentativas').parentElement.querySelector('input')
    fireEvent.change(input, { target: { value: 'claude-sonnet-5, claude-opus-5' } })
    fireEvent.blur(input)
    expect(onPatch).toHaveBeenCalledWith({ retry: { escalateModels: ['claude-sonnet-5', 'claude-opus-5'] } })
  })
})
