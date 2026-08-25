// Tema da UI. A preferência ('system' | 'light' | 'dark') é de UI, então vive no
// localStorage (mesma política do sort das colunas). O CSS só conhece 'light' e
// 'dark': aqui resolvemos 'system' pelo prefers-color-scheme e escrevemos o
// resultado em data-theme no <html>. Tudo defensivo — storage ou matchMedia
// indisponíveis nunca podem quebrar o board.

export const THEME_KEY = 'ck.theme'

// Só as chaves: o label sai de i18n (`theme.<key>`) na hora do render.
export const THEMES = [
  { key: 'system' },
  { key: 'light' },
  { key: 'dark' },
]

const darkQuery = () => {
  try { return window.matchMedia('(prefers-color-scheme: dark)') } catch { return null }
}

export function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return THEMES.some(t => t.key === v) ? v : 'system'
  } catch { return 'system' }
}

export function saveTheme(v) {
  try { localStorage.setItem(THEME_KEY, v) } catch { /* storage indisponível */ }
}

export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref
  return darkQuery()?.matches ? 'dark' : 'light'
}

export function applyTheme(pref) {
  document.documentElement.dataset.theme = resolveTheme(pref)
}

// Enquanto a preferência for 'system', o tema segue o SO em tempo real.
// Devolve o unsubscribe.
export function watchSystemTheme(onChange) {
  const q = darkQuery()
  if (!q?.addEventListener) return () => {}
  const h = () => onChange()
  q.addEventListener('change', h)
  return () => q.removeEventListener('change', h)
}
