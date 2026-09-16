import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
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

const shotNote = shot => shot ? `
Um screenshot da aplicação rodando com esta mudança está em ${shot}. Abra com
Read e confira se a parte visual está coerente com o que a task pede.
` : ''

// Resolve { approved, feedback, costUsd }. Nunca rejeita: revisor fora do ar não
// pode reprovar trabalho que passou nos testes — vira aprovado com a nota do erro.
export function reviewTask(project, task, diff, cwd, shot = null) {
  return new Promise(resolve => {
    const pass = why => resolve({ approved: true, feedback: `(revisão não rodou: ${why})`, costUsd: null, skipped: true })
    let child
    try {
      child = spawn('claude', [
        '-p', buildReviewPrompt(task, diff) + shotNote(shot),
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

const APP_BOOT_MS = 90_000
const SHOT_TIMEOUT_MS = 90_000

// Checagem visual (project.visualCheck = { command, url }): sobe a app a partir
// do worktree da task, espera a URL responder e tira um screenshot com o CLI do
// Playwright. Resolve { path } ou { error } — nunca rejeita.
// ponytail: exige `npx playwright install chromium` feito uma vez na máquina, e
// a porta do comando é fixa (com concorrência > 1, duas revisões disputam a porta).
export async function screenshotApp({ command, url }, cwd) {
  const child = spawn(command, { cwd, shell: true, stdio: 'ignore', detached: process.platform !== 'win32' })
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} } }
  try {
    const deadline = Date.now() + APP_BOOT_MS
    let up = false
    while (!up && Date.now() < deadline && child.exitCode === null) {
      try { up = (await fetch(url, { signal: AbortSignal.timeout(3000) })).status < 500 } catch {}
      if (!up) await new Promise(r => setTimeout(r, 1500))
    }
    if (!up) return { error: `a aplicação não respondeu em ${url}` }
    const file = path.join(cwd, '.claude', 'claude-kanban', 'review-shot.png')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    await new Promise((resolve, reject) => execFile('npx',
      ['--yes', 'playwright', 'screenshot', '--full-page', url, file],
      { cwd, timeout: SHOT_TIMEOUT_MS }, err => (err ? reject(err) : resolve())))
    return fs.existsSync(file) ? { path: file } : { error: 'playwright não gerou a imagem' }
  } catch (e) {
    return { error: String(e.message || e).slice(0, 300) }
  } finally {
    stop()
  }
}
