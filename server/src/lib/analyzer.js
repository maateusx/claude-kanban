import { spawn } from 'node:child_process'
import { auxModel } from './models.js'
import { getSection } from './tasks.js'
import { SPEC_REL } from './spec.js'

// Tipos de sugestão que o usuário pode pedir. A chave vira tag na task criada.
export const SUGGESTION_TYPES = {
  melhoria: 'melhorias em código, UX ou arquitetura existente',
  correcao: 'bugs, comportamentos incorretos ou edge cases mal tratados',
  feature: 'novas funcionalidades que agregariam valor ao projeto',
  refatoracao: 'refatorações e redução de dívida técnica',
  teste: 'testes ausentes, frágeis ou incompletos',
  documentacao: 'documentação ausente ou desatualizada',
}

const TIMEOUT_MS = 10 * 60 * 1000
const PRIORITIES = ['low', 'medium', 'high', 'urgent']

// `free`: o usuário não escolheu tipos — o Claude decide o foco, mas o `type`
// ainda precisa ser uma das chaves (vira tag). `question`: pergunta livre do usuário.
// `report`: pede também um parecer geral do projeto em markdown.
export function buildPrompt(types, { question = '', free = false, report = false } = {}) {
  const lines = types.map(t => `- "${t}": ${SUGGESTION_TYPES[t]}`).join('\n')
  const scope = free
    ? `e decida você o que mais vale a pena fazer agora. Classifique cada task em um dos tipos abaixo:`
    : `e sugira tasks concretas e acionáveis, APENAS dos tipos abaixo:`
  const ask = question ? `\nO usuário pediu especificamente:\n"""\n${question}\n"""\nAs sugestões devem responder a esse pedido.\n` : ''
  const rep = report ? `
Além das tasks, escreva em "report" (markdown) um parecer franco sobre o projeto, com as seções:
## Visão geral (o que o projeto é e em que estado está)
## Pontos fortes
## O que eu refaria (e por quê)
## Próximos passos (em ordem de prioridade)
## Ideias e feedback de produto
Seja específico deste projeto; cite arquivos quando fizer sentido.
` : ''
  return `Analise este projeto (leia README, estrutura de pastas e os arquivos principais)
${scope}

${lines}
${ask}${rep}
Regras:
- No máximo 12 sugestões no total, as mais relevantes primeiro.
- Cada sugestão deve ser específica deste projeto (cite arquivos/módulos quando fizer sentido),
  nunca genérica ("adicionar testes" não vale; "testar reconciliação de status em X" vale).
- "description" em markdown: o que fazer, onde, e critérios de aceite (3-8 linhas).
- Não sugira nada que já exista no projeto.

Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato:
{${report ? '"report":"...",' : ''}"suggestions":[{"title":"...","description":"...","type":"<um dos tipos acima>","priority":"low|medium|high|urgent"}]}`
}

function extractJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('resposta do modelo não contém JSON')
  return JSON.parse(text.slice(start, end + 1))
}

export function parseSuggestions(text, wanted) {
  return suggestionsFrom(extractJson(text), wanted)
}

export function parseAnalysis(text, wanted) {
  const parsed = extractJson(text)
  const report = typeof parsed.report === 'string' ? parsed.report.trim() : ''
  return { report, suggestions: suggestionsFrom(parsed, wanted) }
}

function suggestionsFrom(parsed, wanted) {
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
export function analyzeProject(project, types, question, report = false) {
  const free = !Array.isArray(types) || !types.length
  const wanted = (free ? Object.keys(SUGGESTION_TYPES) : types).filter(t => SUGGESTION_TYPES[t])
  if (!wanted.length) return Promise.reject(new Error('nenhum tipo de sugestão válido'))
  const q = typeof question === 'string' ? question.trim().slice(0, 2000) : ''

  return runReadOnly(project, buildPrompt(wanted, { question: q, free, report: !!report }), project.path,
    text => parseAnalysis(text, wanted))
}

// Sessão headless somente leitura em `cwd`; `parse` recebe o texto final.
function runReadOnly(project, prompt, cwd, parse) {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--allowedTools', 'Read Glob Grep',
    '--model', auxModel(project),
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
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
      if (timedOut) return reject(new Error('análise excedeu o tempo limite (10 min)'))
      if (code !== 0) return reject(new Error(`claude saiu com código ${code}: ${err.slice(-500)}`))
      try {
        const result = JSON.parse(out)
        if (result.is_error) return reject(new Error(`análise falhou: ${String(result.result).slice(0, 300)}`))
        resolve({ ...parse(String(result.result || '')), costUsd: result.total_cost_usd ?? null })
      } catch (e) {
        reject(new Error(`não consegui interpretar a resposta da análise: ${e.message}`))
      }
    })
  })
}

// Loop de objetivo: depois da integração de uma task desmembrada, compara a spec
// e os critérios de aceite com o código e os testes do `cwd` (a branch do
// objetivo). Mesmo formato de resposta das sugestões; lista vazia = cumprido.
export function buildGapPrompt(goal, known = []) {
  const types = Object.entries(SUGGESTION_TYPES).map(([k, v]) => `- "${k}": ${v}`).join('\n')
  const seen = known.length
    ? `\nTasks já criadas para este objetivo (não repita as que já resolvem a lacuna):\n${known.map(t => `- ${t.title} (${t.status})`).join('\n')}\n`
    : ''
  return `Você é o auditor do claude-kanban. O objetivo abaixo foi desmembrado, executado e
integrado neste repositório (o diretório atual). Leia a especificação do sistema
(${SPEC_REL}/SPEC.md e os ADRs em ${SPEC_REL}/adr/, se existirem), a descrição e os
critérios de aceite do objetivo, e confira no código e nos testes o que ainda NÃO
está entregue.

<objetivo>
Título: ${goal.title}

${getSection(goal.body, 'Descrição') || ''}
</objetivo>
${seen}
Regras:
- Só aponte lacunas reais e verificáveis (requisito ausente, critério de aceite sem
  implementação ou sem teste, contrato da spec descumprido). Nada de estilo ou "seria legal".
- No máximo 8 lacunas, as mais importantes primeiro. Se está tudo entregue, lista vazia.
- "description" em markdown: o que falta, onde, e critérios de aceite (3-8 linhas).
- "type" é um destes:
${types}

Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato:
{"suggestions":[{"title":"...","description":"...","type":"<um dos tipos acima>","priority":"low|medium|high|urgent"}]}`
}

export function findGaps(project, goal, cwd, known = []) {
  return runReadOnly(project, buildGapPrompt(goal, known), cwd,
    text => ({ gaps: parseSuggestions(text, Object.keys(SUGGESTION_TYPES)) }))
}
