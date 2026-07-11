import { spawn } from 'node:child_process'
import { normalizeModel } from './models.js'

// Tipos de sugestão que o usuário pode pedir. A chave vira tag na task criada.
export const SUGGESTION_TYPES = {
  melhoria: 'melhorias em código, UX ou arquitetura existente',
  correcao: 'bugs, comportamentos incorretos ou edge cases mal tratados',
  feature: 'novas funcionalidades que agregariam valor ao projeto',
  refatoracao: 'refatorações e redução de dívida técnica',
  teste: 'testes ausentes, frágeis ou incompletos',
  documentacao: 'documentação ausente ou desatualizada',
}

const TIMEOUT_MS = 5 * 60 * 1000
const PRIORITIES = ['low', 'medium', 'high', 'urgent']

export function buildPrompt(types) {
  const lines = types.map(t => `- "${t}": ${SUGGESTION_TYPES[t]}`).join('\n')
  return `Analise este projeto (leia README, estrutura de pastas e os arquivos principais)
e sugira tasks concretas e acionáveis, APENAS dos tipos abaixo:

${lines}

Regras:
- No máximo 12 sugestões no total, as mais relevantes primeiro.
- Cada sugestão deve ser específica deste projeto (cite arquivos/módulos quando fizer sentido),
  nunca genérica ("adicionar testes" não vale; "testar reconciliação de status em X" vale).
- "description" em markdown: o que fazer, onde, e critérios de aceite (3-8 linhas).
- Não sugira nada que já exista no projeto.

Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato:
{"suggestions":[{"title":"...","description":"...","type":"<um dos tipos acima>","priority":"low|medium|high|urgent"}]}`
}

export function parseSuggestions(text, wanted) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('resposta do modelo não contém JSON')
  const parsed = JSON.parse(text.slice(start, end + 1))
  const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
  return list
    .filter(s => s && typeof s.title === 'string' && s.title.trim())
    .map(s => ({
      title: s.title.trim().slice(0, 200),
      description: typeof s.description === 'string' ? s.description.trim() : '',
      type: wanted.includes(s.type) ? s.type : wanted[0],
      priority: PRIORITIES.includes(s.priority) ? s.priority : 'medium',
    }))
}

// Roda uma sessão headless somente leitura no diretório do projeto e devolve
// as sugestões de tasks. Síncrono do ponto de vista do caller (Promise).
export function analyzeProject(project, types) {
  const wanted = (Array.isArray(types) && types.length ? types : Object.keys(SUGGESTION_TYPES))
    .filter(t => SUGGESTION_TYPES[t])
  if (!wanted.length) return Promise.reject(new Error('nenhum tipo de sugestão válido'))

  const model = normalizeModel(project.defaultModel)
  const args = [
    '-p', buildPrompt(wanted),
    '--output-format', 'json',
    '--allowedTools', 'Read Glob Grep',
    ...(model ? ['--model', model] : []),
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: project.path,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    let timedOut = false

    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(new Error(`falha ao iniciar claude: ${e.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error('análise excedeu o tempo limite (5 min)'))
      if (code !== 0) return reject(new Error(`claude saiu com código ${code}: ${err.slice(-500)}`))
      try {
        const result = JSON.parse(out)
        if (result.is_error) return reject(new Error(`análise falhou: ${String(result.result).slice(0, 300)}`))
        resolve({ suggestions: parseSuggestions(String(result.result || ''), wanted), costUsd: result.total_cost_usd ?? null })
      } catch (e) {
        reject(new Error(`não consegui interpretar a resposta da análise: ${e.message}`))
      }
    })
  })
}
