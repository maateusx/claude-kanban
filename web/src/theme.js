// Tema da UI. É preferência de UI pura (não vira patch de projeto), então mora
// no localStorage como o rail e o sort das colunas.
//
// Três modos: 'light', 'dark' e 'system' (segue o SO). O modo escolhido é
// escrito em data-theme no <html>; 'system' não escreve nada e deixa o
// @media (prefers-color-scheme) do index.css decidir.

export const THEME_KEY = 'ck.theme'
export const MODES = ['light', 'dark', 'system']

export function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return MODES.includes(v) ? v : 'system'
  } catch { return 'system' }
}

export function saveTheme(mode) {
  try { localStorage.setItem(THEME_KEY, mode) } catch { /* storage indisponível */ }
}

// Aplica no documento. Chamado no boot (antes do render, para não piscar branco)
// e a cada troca.
export function applyTheme(mode) {
  const el = document.documentElement
  if (mode === 'system') el.removeAttribute('data-theme')
  else el.setAttribute('data-theme', mode)
}

// Tema efetivo — resolve 'system' pelo que o SO diz agora.
export function resolvedTheme(mode = loadTheme()) {
  if (mode !== 'system') return mode
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch { return 'light' }
}

export function initTheme() {
  applyTheme(loadTheme())
}
