import { spawn } from 'node:child_process'
import { auxModel } from './models.js'
import { getSection } from './tasks.js'

// Diagnóstico de falha: esgotadas as tentativas, uma sessão somente leitura no
// auxModel classifica a causa e o runner age conforme ela, em vez de deixar a
// task blocked esperando gente. Só `externo` continua precisando de humano.
export const CAUSES = ['ambiente', 'flaky', 'spec_ambigua', 'grande_demais', 'falta_dependencia', 'externo']
export const DIAGNOSED_PREFIX = 'diagnosticada:'
const TIMEOUT_MS = 5 * 60 * 1000
const tail = (s, n) => (s.length > n ? '[…]\n' + s.slice(-n) : s)

// others: tasks abertas do projeto ({ id, title, status }) — candidatas a dependência.
export function buildDiagnosePrompt(task, diff, others = []) {
  return `Você é o diagnosticador do claude-kanban. A task abaixo esgotou as tentativas
automáticas. Leia o log de erros, o resultado e o diff (e os arquivos do repositório,
se precisar) e classifique a CAUSA RAIZ da falha em exatamente uma destas:

- ambiente: falta algo no ambiente/repo que outra task pode preparar (dependência não
  instalada, script de build/teste quebrado, configuração ausente).
- flaky: teste ou comando instável — falha intermitente, não causada pela mudança.
- spec_ambigua: o pedido é ambíguo e a sessão travou sem saber o que fazer.
- grande_demais: a task é grande demais para uma sessão (teto de turnos, timeout, trabalho pela metade).
- falta_dependencia: depende de algo que outra task entrega e ainda não está pronto.
- externo: precisa de credencial, conta, pagamento, aprovação ou acesso que só um humano dá.

<task>
Título: ${task.title}
exit_reason: ${task.run?.exit_reason || '(nenhum)'}

## Descrição
${tail((getSection(task.body, 'Descrição') || '').trim(), 4000)}

## Resultado
${tail((getSection(task.body, 'Resultado') || '').trim(), 2000)}

## Log de erros
${tail((getSection(task.body, 'Log de erros') || '').trim(), 8000)}
</task>

<diff>
${diff ? tail(diff, 8000) : '(sem diff)'}
</diff>

<tasks-abertas>
${others.map(t => `- ${t.id} [${t.status}] ${t.title}`).join('\n') || '(nenhuma)'}
</tasks-abertas>

Responda SOMENTE com um JSON válido, sem texto antes ou depois:
{"cause":"<causa>","summary":"<uma ou duas frases com a evidência>",
 "dependsOn":"<id de uma task aberta acima que entrega o que falta — só em falta_dependencia>",
 "task":{"title":"...","description":"..."}}
"task" é a task a criar: em ambiente (o pré-requisito a preparar), em flaky (a correção
ou quarentena do teste instável) e em falta_dependencia quando nenhuma task aberta entrega
o que falta. Omita os campos que não se aplicam.`
}

export function parseDiagnosis(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('resposta do diagnóstico não contém JSON')
  const p = JSON.parse(text.slice(start, end + 1))
  if (!CAUSES.includes(p.cause)) throw new Error(`causa desconhecida: ${p.cause}`)
  const task = p.task && typeof p.task.title === 'string' && p.task.title.trim()
    ? { title: p.task.title.trim().slice(0, 200), description: String(p.task.description || '').trim() }
    : null
  return {
    cause: p.cause,
    summary: String(p.summary || '').trim(),
    dependsOn: typeof p.dependsOn === 'string' && p.dependsOn.trim() ? p.dependsOn.trim() : null,
    task,
  }
}

// Resolve { cause, summary, dependsOn, task, costUsd } ou rejeita.
export function diagnoseTask(project, task, diff, others) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', buildDiagnosePrompt(task, diff, others),
      '--output-format', 'json',
      '--allowedTools', 'Read Glob Grep',
      '--model', auxModel(project),
    ], { cwd: project.path, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`claude saiu com código ${code}: ${err.slice(-300)}`))
      try {
        const r = JSON.parse(out)
        if (r.is_error) throw new Error(String(r.result).slice(0, 300))
        resolve({ ...parseDiagnosis(String(r.result || '')), costUsd: r.total_cost_usd ?? 0 })
      } catch (e) { reject(e) }
    })
  })
}
