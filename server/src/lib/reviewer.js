import { spawn } from 'node:child_process'
import { auxModel } from './models.js'
import { getSection } from './tasks.js'

const TIMEOUT_MS = 5 * 60 * 1000
const MAX_DIFF_CHARS = 120_000

// Gate de revisão (`reviewGate` no projeto): depois do verifyCommand, uma sessão
// barata e somente leitura julga se o diff entrega o que a task pede. Testes só
// pegam o que cobrem; isto pega "fez outra coisa" e "fez pela metade".
export function buildReviewPrompt(task, diff) {
  const d = diff || '(a sessão não produziu diff)'
  return `Você é o revisor do claude-kanban. Uma sessão do Claude executou a task abaixo
neste repositório (o diretório atual é o worktree com o resultado). Julgue se o
trabalho ENTREGA o que a task pede — critérios de aceite, escopo, nada quebrado
pela metade. Leia arquivos do repositório se precisar de contexto.

Não reprove por estilo ou preferência pessoal: só por requisito não atendido,
bug evidente ou trabalho incompleto.

<task>
Título: ${task.title}

${getSection(task.body, 'Descrição') || ''}
</task>

<resultado-declarado>
${getSection(task.body, 'Resultado') || '(vazio)'}
</resultado-declarado>

<diff>
${d.length > MAX_DIFF_CHARS ? d.slice(0, MAX_DIFF_CHARS) + '\n[diff truncado]' : d}
</diff>

Responda SOMENTE com um JSON válido, sem texto antes ou depois:
{"approved":true|false,"feedback":"o que falta ou está errado, objetivo e acionável (vazio se aprovado)"}`
}

export function parseReview(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('resposta do revisor não contém JSON')
  const parsed = JSON.parse(text.slice(start, end + 1))
  if (typeof parsed.approved !== 'boolean') throw new Error('resposta do revisor sem "approved"')
  return { approved: parsed.approved, feedback: String(parsed.feedback || '').trim() }
}

// Resolve { approved, feedback, costUsd }. Nunca rejeita: revisor fora do ar não
// pode reprovar trabalho que passou nos testes — vira aprovado com a nota do erro.
export function reviewTask(project, task, diff, cwd) {
  return new Promise(resolve => {
    const pass = why => resolve({ approved: true, feedback: `(revisão não rodou: ${why})`, costUsd: null, skipped: true })
    let child
    try {
      child = spawn('claude', [
        '-p', buildReviewPrompt(task, diff),
        '--output-format', 'json',
        '--allowedTools', 'Read Glob Grep',
        '--model', auxModel(project),
      ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { return pass(e.message) }
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.stdout.on('data', d => { out += d })
    child.on('error', e => { clearTimeout(timer); pass(e.message) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return pass(`claude saiu com código ${code}`)
      try {
        const result = JSON.parse(out)
        if (result.is_error) return pass(String(result.result).slice(0, 200))
        resolve({ ...parseReview(String(result.result || '')), costUsd: result.total_cost_usd ?? null })
      } catch (e) { pass(e.message) }
    })
  })
}
