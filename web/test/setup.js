import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Os testes que renderizam o App mockam @dnd-kit/core (jsdom não simula pointer
// events). O sortable depende de internals do core, então o stub dele mora aqui.
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }) => children,
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, setActivatorNodeRef: () => {}, transform: null, transition: null, isDragging: false }),
  arrayMove: (arr, from, to) => { const a = arr.slice(); a.splice(to, 0, a.splice(from, 1)[0]); return a },
  verticalListSortingStrategy: () => null,
  sortableKeyboardCoordinates: () => null,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
