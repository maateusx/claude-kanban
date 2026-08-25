// Preferência de tema. Só existe no cliente (localStorage), como notificações e
// sons — nada disso é por projeto. O CSS inteiro é feito de tokens, então trocar
// de tema é só escrever data-theme no <html>: nenhum componente precisa saber.

import { t } from './i18n.js'

export const THEME_KEY = 'ck.theme'

export const THEMES = [
  { key: 'system', label: t('Sistema'), hint: t('segue o tema do sistema operacional') },
  { key: 'light', label: t('Claro'), hint: '' },
  { key: 'dark', label: t('Escuro'), hint: '' },
]

export function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return THEMES.some(t => t.key === v) ? v : 'system'
  } catch { return 'system' }
}

export function saveTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref) } catch { /* storage indisponível */ }
}

function systemDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

// 'system' vira o tema real do SO; o resto passa direto.
export function resolve(pref) {
  return pref === 'dark' || pref === 'light' ? pref : (systemDark() ? 'dark' : 'light')
}

export function apply(pref) {
  document.documentElement.dataset.theme = resolve(pref)
}

// Chamado uma vez no boot: aplica o tema salvo e reaplica quando o SO troca
// (só muda alguma coisa se a preferência for 'system').
export function start() {
  apply(loadTheme())
  try {
    window.matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => { if (loadTheme() === 'system') apply('system') })
  } catch { /* navegador sem matchMedia: fica no tema salvo */ }
}
