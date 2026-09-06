// Idioma da UI. Um arquivo por língua em languages/<key>.json, com o texto em
// português como chave — uma língua nova é copiar o pt-BR.json e traduzir os
// valores, e chave faltando cai no próprio texto (pt-BR).
//
// Trocar de idioma recarrega a página: boa parte das strings é resolvida na
// importação dos módulos (constantes de topo de arquivo), então recarregar sai
// mais barato que espalhar um contexto de idioma pela árvore inteira. Como o
// tema, é preferência de cliente (localStorage), não do projeto.
import ptBR from './languages/pt-BR.json'
import en from './languages/en.json'

export const LANG_KEY = 'ck.lang'

const DICTS = { 'pt-BR': ptBR, en }
const DEFAULT_LANG = 'pt-BR'

export const LANGUAGES = [
  { key: 'pt-BR', label: 'Português (BR)' },
  { key: 'en', label: 'English' },
]

function load() {
  try {
    const v = localStorage.getItem(LANG_KEY)
    return DICTS[v] ? v : DEFAULT_LANG
  } catch { return DEFAULT_LANG }
}

let current = load()

export const getLang = () => current

// A chave do idioma já é uma tag BCP-47 válida, então serve direto de locale
// para Intl (datas, ordenação alfabética).
export const locale = () => current

export function setLang(lang) {
  if (!DICTS[lang] || lang === current) return
  try { localStorage.setItem(LANG_KEY, lang) } catch { /* storage indisponível */ }
  current = lang
  try { document.documentElement.lang = lang } catch { /* fora do browser */ }
  try { location.reload() } catch { /* fora do browser */ }
}

// t('Salvar') · t('{n} tasks', { n: 3 }). Sem tradução, devolve a própria chave
// — que já é o texto em português.
export function t(key, vars) {
  const s = DICTS[current]?.[key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s
}

try { document.documentElement.lang = current } catch { /* fora do browser */ }
