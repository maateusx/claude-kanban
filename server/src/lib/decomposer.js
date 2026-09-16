import { spawn } from 'node:child_process'
import { auxModel } from './models.js'

const TIMEOUT_MS = 5 * 60 * 1000
const PRIORITIES = ['low', 'medium', 'high', 'urgent']
const MAX_SUBTASKS = 8

// Quantos níveis de desmembramento o autoDecompose pode encadear sozinho: a task
// original é nível 0, as subtasks dela nível 1, e por aí vai. Sem esse teto, um
// projeto com autoDecompose ligado quebra subtask de subtask até o modelo se
// cansar — e cada nível é uma sessão paga. O botão "Desmembrar" ignora o teto:
// pedido explícito do usuário sempre vale.
export const MAX_DECOMPOSE_LEVEL = 2

export const subtaskLevel = task =>
  Number((task.tags || []).find(t => t.startsWith('nivel:'))?.slice(6)) || 0

// mode 'forced': o usuário pediu para quebrar — sempre desmembra.
// mode 'auto': o modelo decide se vale a pena; task pequena/atômica fica como está.
export function buildPrompt(task, mode) {
  const decision = mode === 'auto'
    ? `Primeiro DECIDA se vale a pena desmembrar: só desmembre se a task claramente
envolve múltiplas frentes de trabalho independentes (ex.: backend + frontend + docs,
ou várias features distintas). Se ela for pequena, atômica ou já bem delimitada,
responda {"decompose":false} e nada mais.`
    : `O usuário pediu explicitamente para desmembrar esta task — sempre desmembre.`

  return `Você é o planejador do claude-kanban. Analise a task abaixo deste projeto
(leia os arquivos relevantes do repositório se precisar de contexto) e desmembre-a
em subtasks menores, independentes e acionáveis.

<task>
Título: ${task.title}

${task.body || ''}
</task>

${decision}

Regras para as subtasks:
- Entre 2 e ${MAX_SUBTASKS}, cada uma executável de forma independente por uma sessão do Claude.
- Ordene por dependência: o que precisa vir primeiro aparece primeiro.
- "description" em markdown: o que fazer, onde (cite arquivos/módulos), critérios de aceite
  e, se depender de outra subtask, diga qual.
- Títulos específicos deste projeto, nunca genéricos.

Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato:
{"decompose":true,"subtasks":[{"title":"...","description":"...","priority":"low|medium|high|urgent"}]}
ou {"decompose":false} quando não valer desmembrar.`
}

export function parseDecomposition(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('resposta do modelo não contém JSON')
  const parsed = JSON.parse(text.slice(start, end + 1))
  if (parsed.decompose === false) return { decompose: false, subtasks: [] }
  const list = Array.isArray(parsed.subtasks) ? parsed.subtasks : []
  const subtasks = list
    .filter(s => s && typeof s.title === 'string' && s.title.trim())
    .slice(0, MAX_SUBTASKS)
    .map(s => ({
      title: s.title.trim().slice(0, 200),
      description: typeof s.description === 'string' ? s.description.trim() : '',
      priority: PRIORITIES.includes(s.priority) ? s.priority : 'medium',
    }))
  if (!subtasks.length) throw new Error('o modelo não devolveu subtasks válidas')
  return { decompose: true, subtasks }
}

// Sessão headless somente leitura que devolve a decomposição da task.
// Retorna { child, promise } para o runner poder registrar/matar o processo.
export function decomposeTask(project, task, mode) {
  // Sessão de leitura que só devolve JSON: sempre no modelo auxiliar, mesmo que a
  // task tenha um modelo próprio (esse fica para a execução das subtasks).
  const args = [
    '-p', buildPrompt(task, mode),
    '--output-format', 'json',
    '--allowedTools', 'Read Glob Grep',
    '--model', auxModel(project),
  ]

  const child = spawn('claude', args, {
    cwd: project.path,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const promise = new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TIMEOUT_MS)

    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(new Error(`falha ao iniciar claude: ${e.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error('decomposição excedeu o tempo limite (5 min)'))
      if (code !== 0) return reject(new Error(`claude saiu com código ${code}: ${err.slice(-500)}`))
      try {
        const result = JSON.parse(out)
        if (result.is_error) return reject(new Error(`decomposição falhou: ${String(result.result).slice(0, 300)}`))
        resolve({ ...parseDecomposition(String(result.result || '')), costUsd: result.total_cost_usd ?? null })
      } catch (e) {
        reject(new Error(`não consegui interpretar a resposta da decomposição: ${e.message}`))
      }
    })
  })

  return { child, promise }
}
