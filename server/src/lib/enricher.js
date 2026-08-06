import { spawn } from 'node:child_process'
import { getSection } from './tasks.js'
import { auxModel } from './models.js'

const TIMEOUT_MS = 5 * 60 * 1000

// auto=true: o modelo decide se a descrição precisa de reescrita (modo em que o
// próprio claude-kanban julga a necessidade). auto=false: pedido explícito do
// usuário — reescreve sempre.
export function buildEnrichPrompt(task, { auto = false } = {}) {
  const desc = getSection(task.body, 'Descrição') || '(vazia)'
  return `Você é o assistente do claude-kanban. Uma task deste projeto será executada por
um agente de código, e a qualidade da descrição determina a qualidade do resultado.

Task atual:
Título: ${task.title}
Descrição:
<descricao>
${desc}
</descricao>

Explore o projeto (somente leitura: README, estrutura, arquivos citados) e reescreva a
descrição para ficar clara, objetiva e acionável:
- objetivo e escopo explícitos (o que fazer e o que NÃO fazer);
- contexto do código: arquivos/módulos relevantes deste projeto, citados pelo caminho;
- critérios de aceite verificáveis;
- preserve TODA a intenção original — enriqueça, não invente requisitos novos;
- escreva em português, markdown simples, sem cabeçalhos "##".
${auto ? `
Antes de reescrever, avalie: se a descrição JÁ está clara, específica e com contexto
suficiente, NÃO reescreva — responda com "enrich": false e explique em "reason".` : ''}
Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato:
{"enrich":true|false,"reason":"por que reescreveu (ou não)","title":"título melhorado ou o original","description":"nova descrição em markdown"}`
}

export function parseEnrichment(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('resposta do modelo não contém JSON')
  const parsed = JSON.parse(text.slice(start, end + 1))
  const enrich = !!parsed.enrich
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
  if (enrich && !description) throw new Error('enriquecimento sem descrição')
  return {
    enrich,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 200) : null,
    description,
  }
}

// Sessão headless somente leitura no diretório do projeto; devolve a proposta
// de reescrita (não aplica — quem aplica é o caller, via updateTask/setSection).
export function enrichTask(project, task, { auto = false } = {}) {
  const args = [
    '-p', buildEnrichPrompt(task, { auto }),
    '--output-format', 'json',
    '--allowedTools', 'Read Glob Grep',
    '--model', auxModel(project),
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: project.path,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
      if (timedOut) return reject(new Error('enriquecimento excedeu o tempo limite (5 min)'))
      if (code !== 0) return reject(new Error(`claude saiu com código ${code}: ${err.slice(-500)}`))
      try {
        const result = JSON.parse(out)
        if (result.is_error) return reject(new Error(`enriquecimento falhou: ${String(result.result).slice(0, 300)}`))
        resolve({ ...parseEnrichment(String(result.result || '')), costUsd: result.total_cost_usd ?? null })
      } catch (e) {
        reject(new Error(`não consegui interpretar a resposta do enriquecimento: ${e.message}`))
      }
    })
  })
}
