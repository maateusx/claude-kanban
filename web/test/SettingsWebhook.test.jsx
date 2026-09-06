import React from 'react'
import { describe, it, expect, vi } from 'vitest'
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
}))

vi.mock('../src/api.js', () => ({
  // PluginSettings monta junto com o modal e busca a lista no efeito.
  api: { pickFolder: vi.fn(), plugins: vi.fn(async () => ({ scope: 'local', plugins: [] })) },
  connectWS: vi.fn(() => () => {}),
}))

const { SettingsModal } = await import('../src/App.jsx')

const project = extra => ({ id: 'p1', name: 'Proj', path: '/tmp/p', ...extra })

describe('webhookStatuses', () => {
  it('marca um status e manda o array no PATCH', async () => {
    const onPatch = vi.fn()
    render(<SettingsModal project={project()} onClose={() => {}} onPatch={onPatch} onRemove={() => {}} />)
    await userEvent.click(screen.getByLabelText('Done'))
    expect(onPatch).toHaveBeenCalledWith({ webhookStatuses: ['done'] })
  })

  it('desmarca removendo só aquele status', async () => {
    const onPatch = vi.fn()
    render(<SettingsModal project={project({ webhookStatuses: ['todo', 'done'] })} onClose={() => {}} onPatch={onPatch} onRemove={() => {}} />)
    expect(screen.getByLabelText('Done')).toBeChecked()
    await userEvent.click(screen.getByLabelText('Done'))
    expect(onPatch).toHaveBeenCalledWith({ webhookStatuses: ['todo'] })
  })
})
