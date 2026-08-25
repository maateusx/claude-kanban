import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadTheme, saveTheme, resolveTheme, applyTheme, watchSystemTheme, THEME_KEY } from '../src/theme.js'

// matchMedia não existe no jsdom — cada teste instala o seu.
const mockMatchMedia = (matches, listeners = []) => {
  window.matchMedia = vi.fn(() => ({
    matches,
    addEventListener: (_, h) => listeners.push(h),
    removeEventListener: (_, h) => listeners.splice(listeners.indexOf(h), 1),
  }))
  return listeners
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('preferência', () => {
  it('default é system; valor inválido no storage cai para system', () => {
    expect(loadTheme()).toBe('system')
    localStorage.setItem(THEME_KEY, 'neon')
    expect(loadTheme()).toBe('system')
  })

  it('persiste e relê', () => {
    saveTheme('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(loadTheme()).toBe('dark')
  })
})

describe('resolveTheme', () => {
  it('light/dark são explícitos, system pergunta ao SO', () => {
    mockMatchMedia(true)
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('system')).toBe('dark')
    mockMatchMedia(false)
    expect(resolveTheme('system')).toBe('light')
  })

  it('sem matchMedia, system vira light em vez de quebrar', () => {
    window.matchMedia = undefined
    expect(resolveTheme('system')).toBe('light')
  })
})

describe('applyTheme', () => {
  it('escreve o tema resolvido em data-theme', () => {
    mockMatchMedia(true)
    applyTheme('system')
    expect(document.documentElement.dataset.theme).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('watchSystemTheme', () => {
  it('avisa na mudança do SO e o unsubscribe desliga', () => {
    const listeners = mockMatchMedia(false)
    const onChange = vi.fn()
    const off = watchSystemTheme(onChange)
    listeners.forEach(h => h())
    expect(onChange).toHaveBeenCalledTimes(1)
    off()
    expect(listeners).toHaveLength(0)
  })

  it('sem matchMedia devolve um unsubscribe no-op', () => {
    window.matchMedia = undefined
    expect(() => watchSystemTheme(() => {})()).not.toThrow()
  })
})
