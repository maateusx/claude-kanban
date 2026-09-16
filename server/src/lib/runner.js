import { spawn, spawnSync, exec } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { loadState, saveState, diffFile, logFile, kanbanDir } from './paths.js'
import { findTask, updateTask, appendToSection, listTasks, createTask, getSection, removeSection, replaceSection } from './tasks.js'
import { decomposeTask, subtaskLevel, designSubtask, MAX_DECOMPOSE_LEVEL } from './decomposer.js'
import { specBlock, needsDesign, SPEC_REL, DESIGN_TAG } from './spec.js'
import { diagnoseTask, DIAGNOSED_PREFIX } from './diagnoser.js'
import {
  prepareWorkspace, cleanupWorkspace, captureDiff, capturePR, gitSettings, isGitRepo, mergeIntoBranch, taskBranch,
  mergeTaskBranch, withDetachedWorktree, diffStats, diffBase, mergeResult, resolveRef,
} from './git.js'
import { reviewTask, screenshotApp } from './reviewer.js'
import { wasSucceeded, markSucceeded, clearExecuted } from './ledger.js'
import { PRIORITY_RANK } from './sort.js'
import { normalizeModel } from './models.js'
import { isFuture } from './scheduler.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

// Teto de turnos da sessão de execução. Sem ele, o único limite era o timeout —
// e como cada turno reenvia todo o histórico, uma task que se perde consome muito
// mais que uma que trabalha o dobro do tempo em poucos turnos. 0 = sem limite.
export const DEFAULT_MAX_TURNS = 40
export const MAX_MAX_TURNS = 500

export function turnLimit(project) {
  const n = Number(project?.maxTurns)
  if (project?.maxTurns === 0) return null // desligado explicitamente
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_TURNS
  return Math.min(Math.round(n), MAX_MAX_TURNS)
}

// Política de retentativa. Uma tentativa extra vale a pena para falha transitória
// (rede, lock de git); da terceira em diante é quase sempre a mesma falha
// determinística sendo paga de novo por uma sessão inteira. O backoff evita que o
// auto-run repesque a task no mesmo tick, sem nenhuma chance de o mundo mudar.
export const DEFAULT_RETRY = { maxAttempts: 2, backoffMinutes: 10, escalateModels: [] }

export function retrySettings(project) {
  const r = project?.retry || {}
  const maxAttempts = Number(r.maxAttempts)
  const backoffMinutes = Number(r.backoffMinutes)
  return {
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts >= 1 ? Math.round(maxAttempts) : DEFAULT_RETRY.maxAttempts,
    backoffMinutes: Number.isFinite(backoffMinutes) && backoffMinutes >= 0 ? backoffMinutes : DEFAULT_RETRY.backoffMinutes,
    escalateModels: (Array.isArray(r.escalateModels) ? r.escalateModels : []).map(normalizeModel).filter(Boolean),
  }
}

// Escalação de modelo: a 2ª tentativa usa escalateModels[0], a 3ª o [1] (ou o
// último da lista). A 1ª segue task > projeto. Só vale em retentativa — a
// maioria das tasks passa de primeira no modelo barato.
export function escalatedModel(project, attempt) {
  const list = retrySettings(project).escalateModels
  if (!(attempt >= 2) || !list.length) return null
  return list[Math.min(attempt - 2, list.length - 1)]
}

// Detecção de sessão travada, olhando o stream: a mesma tool com o mesmo input
// N vezes seguidas, ou muitas chamadas de tool sem nenhuma edição de arquivo.
// Mata cedo em vez de esperar o timeout de 30 min ou o teto de turnos.
export const STUCK_REPEATS = 3
// ponytail: só Edit/Write/MultiEdit/NotebookEdit contam como progresso — quem
// edita por heredoc no Bash conta como parado. Vira configuração se incomodar.
export const STUCK_IDLE_TOOLS = 40
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// w: estado mutável { lastKey, repeats, idle }. Devolve o motivo, ou null.
export function stuckCheck(w, event) {
  if (event?.type !== 'assistant') return null
  for (const c of event.message?.content || []) {
    if (c.type !== 'tool_use') continue
    const key = c.name + JSON.stringify(c.input ?? null)
    w.repeats = key === w.lastKey ? w.repeats + 1 : 1
    w.lastKey = key
    w.idle = EDIT_TOOLS.has(c.name) ? 0 : (w.idle || 0) + 1
    if (w.repeats >= STUCK_REPEATS) return `${c.name} chamada ${w.repeats}x seguidas com o mesmo input`
    if (w.idle >= STUCK_IDLE_TOOLS) return `${w.idle} chamadas de tool seguidas sem editar nenhum arquivo`
  }
  return null
}

// Verify de referência: linhas que parecem falha, normalizadas (sem durações)
// para comparar a saída da task com a da base.
// ponytail: heurística por palavra-chave; um reporter que não escreve
// fail/error cai na comparação da saída inteira.
const FAIL_RE = /\b(fail|failed|failing|failure|error|errors)\b|✖|✗|\bnot ok\b/i
const normLine = l => l.replace(/\(?\d+(\.\d+)?\s?m?s\)?/g, '').replace(/\s+/g, ' ').trim()
const failLines = out => new Set(String(out).split('\n').filter(l => FAIL_RE.test(l)).map(normLine))

const BASE_DIR_MARK = '\0base-dir\0'

// Falhas da task que a base não tinha. [] = tudo que falhou já falhava antes.
export function newFailures(taskOut, baseOut) {
  const mine = failLines(taskOut)
  if (!mine.size) {
    const norm = s => String(s).split('\n').map(normLine).join('\n').trim()
    return norm(taskOut) === norm(baseOut) ? [] : ['(a saída difere da base e não tem linhas de falha reconhecíveis)']
  }
  const base = failLines(baseOut)
  return [...mine].filter(l => !base.has(l))
}

// Política de auto-merge (project.autopilot.autoMerge). Devolve null quando pode
// mergear sozinho, ou o motivo de não poder.
export const DEFAULT_AUTO_MERGE = { enabled: false, maxLines: 300, protectedPaths: ['.github/**'] }
export const autoMergeSettings = project => ({ ...DEFAULT_AUTO_MERGE, ...(project?.autopilot?.autoMerge || {}) })

const globMatch = (file, pattern) => {
  try { return path.matchesGlob(file, pattern) } catch { return file.startsWith(pattern.replace(/\*.*$/, '')) }
}

export function autoMergeBlocker(project, { reviewApproved, diff }) {
  const s = autoMergeSettings(project)
  if (!s.enabled) return 'auto-merge desligado'
  if (reviewApproved !== true) return 'sem revisão automática aprovada'
  const { files, lines } = diffStats(diff)
  if (!files.length) return 'diff vazio'
  if (lines > s.maxLines) return `diff com ${lines} linhas (teto ${s.maxLines})`
  const hit = files.find(f => s.protectedPaths.some(p => globMatch(f, p)))
  if (hit) return `toca caminho protegido (${hit})`
  return null
}

// Conflito de merge: em vez de blocked direto, uma sessão tenta resolver
// mergeando `merge_from` na branch da task. Até MAX_CONFLICT_ROUNDS por task.
export const CONFLICT_TAG = 'conflito'
function conflictBlock(mergeFrom) {
  if (!mergeFrom) return ''
  const fetch = mergeFrom.startsWith('origin/') ? 'git fetch origin && ' : ''
  return `
ATENÇÃO — esta execução é para RESOLVER UM CONFLITO DE MERGE. O trabalho da task já
está feito nesta branch, mas ela conflita com "${mergeFrom}". Faça:
  1. \`${fetch}git merge ${mergeFrom}\`
  2. resolva os conflitos preservando a intenção dos dois lados;
  3. rode build/testes e corrija o que o merge quebrou;
  4. commite o merge. Não reimplemente a task.
`
}
// Tag aplicada quando o agente termina sinalizando que depende de decisão humana.
// Cards com ela ficam fora do auto-pilot até o humano responder e re-executar.
export const HUMAN_REQUEST_TAG = 'human-request'

const HISTORY_SECTION = 'Histórico de Human Requests'

// Auto-decisão: com `autoDecide` ligado no projeto, um "## Human Request" não
// para o card esperando gente — o próprio Claude responde por si, assumindo a
// opção que ele mesmo recomendou, e a task volta para a fila. O teto existe
// porque perguntar/responder sozinho é um loop que gasta uma sessão por volta:
// passou disso, o card espera um humano de verdade.
export const MAX_AUTO_DECISIONS = 3
// Marca o card decidido sem humano — só rastro na UI, não muda o fluxo (ao
// contrário de human-request, não tira a task do auto-pilot).
export const AUTO_DECIDED_TAG = 'auto-decided'
const AUTO_DECIDE_MARK = '[auto-decisão]'
export const AUTO_DECIDE_RESPONSE = `${AUTO_DECIDE_MARK} Nenhum humano foi consultado: o projeto está com auto-decisão ligada. Decida com base na spec e nos ADRs existentes (${SPEC_REL}/); se eles não cobrirem, assuma a opção que você mesmo recomendou (na falta de recomendação explícita, a mais simples e reversível). Registre a decisão como novo ADR (${SPEC_REL}/adr/NNNN-titulo.md) e em "## Resultado", e siga em frente.`

// Quantas vezes esta task já foi decidida sozinha (o par pergunta/resposta fica
// arquivado no histórico a cada retomada).
export const autoDecideCount = body =>
  (getSection(body, HISTORY_SECTION) || '').split(AUTO_DECIDE_MARK).length - 1

// O agente sinaliza bloqueio por decisão humana escrevendo uma seção
// "## Human Request" com conteúdo no arquivo da task.
export function hasHumanRequest(body) {
  return !!getSection(body, 'Human Request')
}

// O humano responde pela UI: a resposta entra no corpo da task como uma seção
// "## Human Response". Ela é consumida no início do run seguinte.
export function hasHumanResponse(body) {
  return !!getSection(body, 'Human Response')
}

// Tira a pergunta/resposta do corpo e arquiva o par no histórico, para que o run
// seguinte não tente responder de novo à mesma pergunta (e o agente possa abrir
// uma nova "## Human Request" limpa). Devolve o par consumido, ou null.
export function consumeHumanAnswer(projectPath, taskId) {
  const task = findTask(projectPath, taskId)
  const response = getSection(task?.body, 'Human Response')
  if (!response) return null
  const request = getSection(task.body, 'Human Request')

  let body = removeSection(task.body, 'Human Response')
  body = removeSection(body, 'Human Request')
  updateTask(projectPath, taskId, { body })
  appendToSection(projectPath, taskId, HISTORY_SECTION,
    `**[${new Date().toISOString()}] Pergunta:**\n\n${request || '(sem seção "## Human Request")'}\n\n**Resposta do humano:**\n\n${response}`)
  return { request, response }
}
const MAX_CONCURRENCY = 8
// Diagnósticos automáticos por task (autopilot.diagnose); passou disso, fica blocked.
export const MAX_DIAGNOSES = 2

// Árvore de tasks: a decomposição marca as filhas com `pai:<id>` e o pai com
// `decomposta`. O pai fica em todo dependendo de todas as filhas (o gate de
// depends_on segura) e, quando elas concluem, roda de novo como integração.
export const DECOMPOSED_TAG = 'decomposta'
// Task que travou e foi desmembrada no lugar de ficar blocked — só uma vez.
export const REPLANNED_TAG = 'replanejada'
// Subtask cuja branch já foi mergeada na branch de integração do pai.
export const INTEGRATED_TAG = 'integrada'

export const parentIdOf = task => (task?.tags || []).find(t => t.startsWith('pai:'))?.slice(4) || null
// Objetivo: task raiz que foi desmembrada — a que o loop de lacunas audita.
export const isGoal = task => !!task?.tags?.includes(DECOMPOSED_TAG) && !parentIdOf(task)
const withTag = (tags, tag) => (tags || []).includes(tag) ? (tags || []) : [...(tags || []), tag]
const taskCost = t => t.run?.total_cost_usd ?? t.run?.cost_usd ?? 0

// Raiz da árvore de uma task (ela mesma, se não é subtask). O `seen` protege de
// um pai: editado à mão formando ciclo.
export function rootIdOf(tasks, task) {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const seen = new Set()
  let cur = task
  while (parentIdOf(cur) && byId.has(parentIdOf(cur)) && !seen.has(cur.id)) {
    seen.add(cur.id)
    cur = byId.get(parentIdOf(cur))
  }
  return cur.id
}

// Custo acumulado (todas as tentativas, decomposição e revisão) da árvore inteira.
export function treeCost(tasks, rootId) {
  return tasks.filter(t => rootIdOf(tasks, t) === rootId).reduce((sum, t) => sum + taskCost(t), 0)
}

// Teto de custo por objetivo (`goalBudgetUsd`): null/0 = desligado.
export const goalBudget = project => {
  const n = Number(project?.goalBudgetUsd)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Memória entre tasks: cada run bem-sucedido pode deixar "## Aprendizados" no
// arquivo da task; o orquestrador junta em notes.md e injeta nos prompts
// seguintes. Quem escreve é só o servidor — worktrees concorrentes não brigam.
const MAX_NOTES_IN_PROMPT = 6000
export const notesFile = projectPath => path.join(kanbanDir(projectPath), 'notes.md')

export function harvestNotes(projectPath, task) {
  const learned = getSection(task?.body, 'Aprendizados').replace(/<!--[\s\S]*?-->/g, '').trim()
  if (!learned) return false
  fs.appendFileSync(notesFile(projectPath), `\n### ${task.title} (${task.id})\n\n${learned}\n`)
  return true
}

function notesBlock(projectPath) {
  let notes = ''
  try { notes = fs.readFileSync(notesFile(projectPath), 'utf8').trim() } catch {}
  if (!notes) return ''
  // As notas mais recentes são as que valem manter quando passa do teto.
  if (notes.length > MAX_NOTES_IN_PROMPT) notes = '[…]\n' + notes.slice(-MAX_NOTES_IN_PROMPT)
  return `
Aprendizados registrados por tasks anteriores deste projeto (convenções,
armadilhas, comandos). Leve em conta:

<notas-do-projeto>
${notes}
</notas-do-projeto>
`
}

const MAX_CHILD_RESULT = 1500

// Critérios de aceite como teste: a subtask de desenho escreve os testes (em
// skip) e registra o comando em "## Comando de aceite"; o servidor copia para o
// `acceptance_command` do objetivo, que só conclui com ele passando.
export const ACCEPTANCE_SECTION = 'Comando de aceite'
// Task com tag bug: a sessão escreve antes um teste que reproduz e registra o
// comando aqui; o servidor confere que ele falha na base e passa na branch.
export const BUG_TAG = 'bug'
export const REPRO_SECTION = 'Teste de reprodução'

// Comando registrado numa seção: o primeiro bloco ``` ou o texto da seção.
export function sectionCommand(body, name) {
  const s = getSection(body, name)
  const m = s.match(/```[^\n]*\n([\s\S]*?)```/)
  return (m ? m[1] : s).trim().replace(/^`+|`+$/g, '').trim()
}

// Comando de aceite que vale para a task: o dela, ou o do projeto se ela é objetivo.
export const acceptanceCommandOf = (project, task) =>
  String(task?.acceptance_command || (isGoal(task) ? project?.acceptanceCommand : '') || '').trim()

// Arquivos de teste de um diff — os que vão para a base na checagem do bug.
// ponytail: heurística por caminho; lista explícita na seção se errar muito.
const TEST_FILE_RE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|[._-](test|spec)\.[^/]+$/
export const testFiles = files => files.filter(f => !f.startsWith('.claude/') && TEST_FILE_RE.test(f))

function bugBlock(task) {
  if (!task.tags?.includes(BUG_TAG)) return ''
  return `
Esta task é um BUG. Antes de corrigir, escreva um teste automatizado que
reproduz o problema (ele deve FALHAR sem a correção) e registre no arquivo da
task uma seção "## ${REPRO_SECTION}" com o comando que roda só esse teste, num
bloco \`\`\`. O servidor roda esse comando na base (com seus arquivos de teste
copiados) e na sua branch: se ele não falhar na base, a task volta para você.
`
}

// Contexto do run de integração de uma task desmembrada: o que cada filha fez.
function integrationBlock(tasks, parentId, acceptance = '') {
  const children = tasks.filter(t => parentIdOf(t) === parentId)
  if (!children.length) return ''
  const list = children.map(c => {
    const res = (getSection(c.body, 'Resultado') || '').replace(/<!--[\s\S]*?-->/g, '').trim()
    return `### ${c.title} (${c.id}) — ${c.status}\n\n${res.slice(0, MAX_CHILD_RESULT) || '(sem resultado registrado)'}`
  }).join('\n\n')
  return `
Esta task foi desmembrada em subtasks, que JÁ foram executadas e mergeadas na
branch em que você está. Este é o run de INTEGRAÇÃO: confira se o conjunto
entrega o que a descrição original pede — rode build e testes, corrija as
costuras entre as partes e complete o que ficou faltando. Não refaça o que já
está pronto. Confira também se o código segue a spec (${SPEC_REL}/) e atualize
nela o que mudou durante a execução.${acceptance ? `
O objetivo só conclui se o comando de aceite passar: \`${acceptance}\`. Tire
o skip/pendente dos testes de aceite que ainda estiverem marcados e faça-os passar.` : ''}

<subtasks>
${list}
</subtasks>
`
}

// Modo "cru": a task vai para o `claude -p` só com título + descrição, sem o
// prompt do kanban (skill, Resultado, human request, git) — como se alguém
// abrisse o Claude Code no terminal e colasse a task. 'plan' roda em
// --permission-mode plan e guarda o plano em "## Plano"; 'plan-execute' faz
// isso e depois retoma a mesma sessão para executar o plano.
export const RAW_MODES = ['execute', 'plan', 'plan-execute']
export const rawModeOf = project => RAW_MODES.includes(project?.rawMode) ? project.rawMode : null

// Gate de verificação pós-run: comando do projeto (testes/lint) executado no
// worktree da task antes de ela poder virar `done`.
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000
const MAX_VERIFY_OUTPUT = 8000

// Roda o verifyCommand no cwd do run. Shell porque o comando é livre
// ("npm test && npm run lint"). Timeout/erro de spawn contam como falha.
export function runVerify(command, cwd) {
  const res = spawnSync(command, {
    cwd, shell: true, encoding: 'utf8',
    timeout: VERIFY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
  })
  return verifyResult(command, res.stdout, res.stderr, res.error ? -1 : res.status, res.error?.message)
}

// Mesmo verify sem travar o event loop — a fila de merge roda enquanto a UI acompanha.
export function runVerifyAsync(command, cwd) {
  return new Promise(resolve => exec(command, {
    cwd, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
  }, (err, stdout, stderr) => {
    const code = !err ? 0 : typeof err.code === 'number' ? err.code : -1
    resolve(verifyResult(command, stdout, stderr, code, code === -1 ? err.message : null))
  }))
}

function verifyResult(command, stdout, stderr, exitCode, error) {
  const out = [stdout, stderr].filter(Boolean).join('\n').trim()
  const output = (error ? `${out}\n${error}`.trim() : out).slice(-MAX_VERIFY_OUTPUT)
  return { command, ok: exitCode === 0, exitCode, output: output || '(sem saída)' }
}

// Teto do log persistido por task. Um run longo com tool_results grandes passa
// fácil de dezenas de MB; acima do teto paramos de gravar e registramos um
// evento marcando o truncamento (o WS continua entregando tudo ao vivo).
const MAX_LOG_BYTES = 8 * 1024 * 1024
// Teto do que o replay devolve ao cliente — o drawer só renderiza os últimos.
const MAX_LOG_EVENTS = 2000

// Fila global FIFO. Concorrência configurável (default 1); projetos sem
// worktree isolado nunca rodam mais de uma task ao mesmo tempo.
export class Runner {
  constructor(getProject, emit) {
    this.getProject = getProject   // projectId -> project
    this.emit = emit
    const state = loadState()
    this.queue = state.queue || []  // [{ projectId, taskId }]
    this.maxConcurrency = Math.min(Math.max(state.maxConcurrency || 1, 1), MAX_CONCURRENCY)
    // Pausa global (todos os projetos). Sempre "drenar": nada novo sai da fila,
    // mas os runs já ativos seguem até o fim — pausar nunca mata sessão.
    // paused=true com pausedUntil=null é pausa indefinida (até resume manual).
    this.paused = !!state.paused
    this.pausedUntil = state.pausedUntil || null
    this.actives = new Map()        // taskId -> { projectId, taskId, child, timer, ... }
    this.baselines = new Map()      // `${projectId}:${sha}:${cmd}` -> resultado do verify na base
    this.diagnosing = new Map()     // taskId -> promise do diagnóstico em andamento
    // Fila de merge (estilo bors): branches concluídas entram na base/no pai uma
    // de cada vez. [{ projectId, taskId, branch, into, kind: 'base'|'parent', stage }]
    this.mergeQueue = (state.mergeQueue || []).map(m => ({ ...m, stage: null }))
    this.mergeDrain = null          // promise do processamento em andamento
  }

  persist() {
    saveState({
      queue: this.queue,
      maxConcurrency: this.maxConcurrency,
      paused: this.paused,
      pausedUntil: this.pausedUntil,
      mergeQueue: this.mergeQueue,
    })
  }

  // until=null → pausa indefinida; until=ISO futuro → pausa que expira sozinha.
  pause(until = null) {
    this.paused = true
    this.pausedUntil = until
    this.persist()
    this.emit('run.queue', this.getQueueView())
    return this.getQueueView()
  }

  resume() {
    this.paused = false
    this.pausedUntil = null
    this.persist()
    this.emit('run.queue', this.getQueueView())
    this.tick()
    return this.getQueueView()
  }

  // Expira a pausa com prazo vencido no próprio check — assim a fila destrava no
  // primeiro tick depois da hora, sem depender do ticker do scheduler.
  isPaused(now = Date.now()) {
    if (!this.paused) return false
    if (this.pausedUntil && !isFuture(this.pausedUntil, now)) {
      this.paused = false
      this.pausedUntil = null
      this.persist()
      this.emit('run.queue', this.getQueueView())
      return false
    }
    return true
  }

  setConcurrency(n) {
    this.maxConcurrency = Math.min(Math.max(Number(n) || 1, 1), MAX_CONCURRENCY)
    this.persist()
    this.tick()
    return this.maxConcurrency
  }

  // Posição de entrada na fila: antes do primeiro item de prioridade estritamente
  // menor. Empate mantém FIFO, e itens já enfileirados nunca trocam de posição
  // entre si — um reorder manual só é ultrapassado por algo de prioridade maior.
  insertAt(priority) {
    const p = PRIORITY_RANK[priority] ?? PRIORITY_RANK.medium
    const idx = this.queue.findIndex(q => (PRIORITY_RANK[q.priority] ?? PRIORITY_RANK.medium) < p)
    return idx === -1 ? this.queue.length : idx
  }

  // auto=true: caminhos automáticos (autoRun/recover). auto=false: pedido explícito
  // do usuário via API — nesse caso limpamos o ledger para permitir re-execução.
  enqueue(projectId, taskId, { auto = false } = {}) {
    if (this.queue.some(q => q.taskId === taskId) || this.actives.has(taskId)) return false
    const project = this.getProject(projectId)
    if (!project) return false
    const task = findTask(project.path, taskId)
    if (!task) return false

    // Já executado com sucesso: nunca re-executa por caminho automático. Em vez
    // disso, reconcilia o status para done (corrige status perdido no filesystem).
    if (wasSucceeded(taskId)) {
      if (auto) {
        if (task.status !== 'done' && task.status !== 'archived') {
          const fixed = updateTask(project.path, taskId, { status: 'done' })
          this.emit('task.upserted', { projectId, task: fixed })
        }
        return false
      }
      clearExecuted(taskId) // usuário pediu explicitamente: libera novo run
    }

    // Re-execução de um card que voltou aguardando decisão humana: o pedido de
    // run (manual ou drag para todo) significa que o humano respondeu — limpa a tag.
    if (!auto && task.tags?.includes(HUMAN_REQUEST_TAG)) {
      updateTask(project.path, taskId, { tags: task.tags.filter(t => t !== HUMAN_REQUEST_TAG) })
    }

    if (task.status === 'backlog') updateTask(project.path, taskId, { status: 'todo' })
    const at = this.insertAt(task.priority)
    this.queue.splice(at, 0, { projectId, taskId, priority: task.priority || 'medium' })
    this.persist()
    this.emit('run.queued', { projectId, taskId, position: at })
    this.tick()
    return true
  }

  // Projeto removido: a fila persistida em state.json não pode continuar
  // referenciando um projeto que não existe mais (start() descartaria os itens
  // silenciosamente, sem evento algum).
  dropProject(projectId) {
    const dropped = this.queue.filter(q => q.projectId === projectId)
    this.queue = this.queue.filter(q => q.projectId !== projectId)
    this.mergeQueue = this.mergeQueue.filter(m => m.projectId !== projectId || m.stage)
    for (const a of [...this.actives.values()]) {
      if (a.projectId === projectId) this.kill(a.taskId)
    }
    this.persist()
    this.emit('run.queue', this.getQueueView())
    this.tick()
    return dropped.length
  }

  // Cancela uma task que ainda não começou: tira da fila sem tocar no status.
  // Quem cuida do "não voltar sozinha para a fila" é o chamador (index.js), que
  // conhece o autoRun do projeto. Task já rodando não sai por aqui — é kill().
  dequeue(taskId) {
    const idx = this.queue.findIndex(q => q.taskId === taskId)
    if (idx === -1) return null
    const [removed] = this.queue.splice(idx, 1)
    this.persist()
    this.emit('run.dequeued', { projectId: removed.projectId, taskId })
    this.emit('run.queue', this.getQueueView())
    return removed
  }

  reorder(taskIds) {
    const byId = new Map(this.queue.map(q => [q.taskId, q]))
    const next = taskIds.map(id => byId.get(id)).filter(Boolean)
    for (const q of this.queue) if (!taskIds.includes(q.taskId)) next.push(q)
    this.queue = next
    this.persist()
  }

  getQueueView() {
    return {
      actives: [...this.actives.values()].map(a => ({ projectId: a.projectId, taskId: a.taskId })),
      queue: this.queue,
      maxConcurrency: this.maxConcurrency,
      paused: this.paused,
      pausedUntil: this.pausedUntil,
      merges: this.mergeQueue,
    }
  }

  kill(taskId) {
    const a = taskId ? this.actives.get(taskId)
      : (this.actives.size === 1 ? this.actives.values().next().value : null)
    if (!a) return false
    a.killed = true
    a.child.kill('SIGTERM')
    setTimeout(() => { try { a.child.kill('SIGKILL') } catch {} }, 10_000)
    return true
  }

  // Sem worktree isolado (ou sem git), duas tasks no mesmo checkout se atropelam.
  canRunConcurrently(project) {
    return gitSettings(project).useWorktree && isGitRepo(project.path)
  }

  // Dependências (depends_on) ainda não satisfeitas de uma task. Uma dependência
  // conta como satisfeita quando está done/archived ou já rodou com sucesso
  // (ledger — o status vive na pasta e pode se perder). Dependência apontando para
  // task inexistente é ignorada: um id morto travaria a fila para sempre.
  pendingDeps(project, taskId) {
    let tasks
    try { tasks = listTasks(project.path) } catch { return [] }
    const task = tasks.find(t => t.id === taskId)
    if (!task?.depends_on?.length) return []
    const byId = new Map(tasks.map(t => [t.id, t]))
    return task.depends_on.filter(id => {
      const dep = byId.get(id)
      if (!dep) return false
      // Concluída mas ainda na fila de merge: o pai não parte sem o código dela.
      if (this.mergeQueue.some(m => m.taskId === id)) return true
      return dep.status !== 'done' && dep.status !== 'archived' && !wasSucceeded(id)
    })
  }

  eligible(projectId, taskId) {
    const project = this.getProject(projectId)
    if (!project) return true // start() descarta e segue
    // Fila adiada: os itens ficam na fila, na ordem, mas nada sai dela até a hora.
    if (isFuture(project.queuePausedUntil)) return false
    // Dependência pendente: o item continua na fila (na mesma posição) e só sai
    // num tick posterior, quando a task de que depende concluir.
    if (taskId && this.pendingDeps(project, taskId).length) return false
    const busy = [...this.actives.values()].some(a => a.projectId === projectId)
    return !busy || this.canRunConcurrently(project)
  }

  tick() {
    if (this.isPaused()) return
    while (this.actives.size < this.maxConcurrency && this.queue.length > 0) {
      const idx = this.queue.findIndex(q => this.eligible(q.projectId, q.taskId))
      if (idx === -1) return
      const [next] = this.queue.splice(idx, 1)
      this.persist()
      this.start(next.projectId, next.taskId)
    }
  }

  // human: par { request, response } já consumido do corpo — só vem preenchido no
  // retry sem resume (o corpo já não tem mais as seções). noResume: força o run
  // normal, com o prompt completo, mesmo havendo sessão anterior.
  // rawExec: { plan, sessionId } — 2ª fase do modo cru 'plan-execute'.
  start(projectId, taskId, { skipDecompose = false, noResume = false, human = null, rawExec = null } = {}) {
    const project = this.getProject(projectId)
    if (!project) return
    let task = findTask(project.path, taskId)
    if (!task) return

    // Desmembrar em vez de executar: forçado pela task (decompose: true) ou,
    // com o autoDecompose do projeto ligado, o próprio modelo decide.
    // Pai já desmembrado roda como integração — a não ser que o replanejamento
    // tenha pedido explicitamente para quebrar de novo (decompose: true).
    const decomposeMode = skipDecompose || rawExec ? null
      : task.decompose === true ? 'forced'
      : (task.decompose == null && project.autoDecompose && !task.tags?.includes(DECOMPOSED_TAG)) ? 'auto'
      : null

    // Teto de custo do objetivo: nada da árvore roda depois de estourar.
    const budget = goalBudget(project)
    if (budget) {
      let tasks = []
      try { tasks = listTasks(project.path) } catch {}
      const rootId = rootIdOf(tasks, task)
      const spent = treeCost(tasks, rootId)
      if (spent >= budget) {
        // status todo: o bloqueio pode cair num restart interno (plan-execute,
        // fallback de resume), com a task ainda em doing.
        task = updateTask(project.path, taskId, {
          status: 'todo', tags: withTag(task.tags, 'blocked'), run: { exit_reason: 'goal_budget' },
        })
        appendToSection(project.path, taskId, 'Log de erros',
          `[${new Date().toISOString()}] Teto de custo do objetivo atingido: US$ ${spent.toFixed(2)} gastos ` +
          `de US$ ${budget.toFixed(2)} na árvore de ${rootId}. Aumente o teto do projeto e remova a tag blocked para continuar.`)
        this.emit('task.upserted', { projectId, task })
        this.emit('run.finished', { projectId, taskId, exitCode: -1, exitReason: 'goal_budget' })
        return
      }
    }

    if (decomposeMode) return this.startDecompose(project, taskId, decomposeMode)

    // Resposta humana pendente: sai do corpo (vai para o histórico) antes de
    // preparar o workspace — o worktree copia o .claude/ do projeto, então o
    // arquivo que o agente vai ler precisa já estar limpo.
    const answer = human || consumeHumanAnswer(project.path, taskId)
    const sessionId = task.run?.session_id || null
    // Continuar a sessão anterior só faz sentido quando há resposta humana para
    // entregar: sem ela, o run é uma re-execução do zero.
    const raw = rawModeOf(project)
    const rawPhase = !raw ? null : rawExec || raw === 'execute' ? 'execute' : 'plan'
    const resumeFrom = rawExec
      ? (!noResume && rawExec.plan && rawExec.sessionId) || null
      : !noResume && answer && sessionId ? sessionId : null

    // O card vai para doing/ ANTES de preparar o workspace. updateTask move o
    // arquivo de pasta, e o worktree copia o .claude/ do projeto: preparando
    // antes, o worktree recebia a task em todo/ enquanto o prompt mandava editar
    // doing/ — o agente não achava o arquivo e o reescrevia do zero, pagando uma
    // busca inútil pelo repositório em toda execução.
    task = updateTask(project.path, taskId, {
      status: 'doing',
      run: {
        started_at: new Date().toISOString(),
        // A fase de execução do plan-execute é o mesmo run, não nova tentativa.
        attempts: (task.run?.attempts || 0) + (rawExec ? 0 : 1),
      },
    })

    let workspace
    try {
      workspace = prepareWorkspace(project, taskId, { parentId: parentIdOf(task) })
    } catch (e) {
      updateTask(project.path, taskId, { status: 'todo' })
      appendToSection(project.path, taskId, 'Log de erros',
        `[${new Date().toISOString()}] Falha ao preparar workspace git: ${e.message}`)
      this.emit('run.finished', { projectId, taskId, exitCode: -1 })
      return
    }

    // Modelo: task > default do projeto > default do claude-code (sem --model).
    // normalizeModel converte apelidos legados ("opus") no slug oficial, que é o
    // que de fato vai para `claude --model` — a sessão roda no modelo escolhido.
    // Retentativa com escalateModels configurado sobe de modelo.
    const model = escalatedModel(project, task.run?.attempts)
      || normalizeModel(task.model) || normalizeModel(project.defaultModel) || null

    if (workspace.branch || model) {
      task = updateTask(project.path, taskId, {
        run: {
          ...(workspace.branch ? { branch: workspace.branch } : {}),
          ...(model ? { model } : {}),
        },
      })
    }

    const taskRelPath = path.relative(project.path, task.filePath)
    const md = fs.readFileSync(task.filePath, 'utf8')
    // Enriquecimento na hora do run: override da task > configuração do projeto.
    const enrichMode = task.enrich === true ? 'always'
      : task.enrich === false ? 'off'
      : (project.enrichMode || 'off')
    const prompt = rawPhase
      ? buildRawPrompt(task, rawPhase, rawExec?.plan, !!resumeFrom)
      : resumeFrom
      ? buildResumePrompt(taskRelPath, answer, workspace.branch, promptGit(project, task), !!project.autoDecide)
      : buildPrompt(taskRelPath, md, workspace.branch, promptGit(project, task), enrichMode, answer, !!project.autoDecide,
        notesBlock(project.path) + specBlock(workspace.cwd || project.path, task) + conflictBlock(task.run?.merge_from)
        + (task.tags?.includes(DECOMPOSED_TAG) ? integrationBlock(listTasks(project.path), taskId, acceptanceCommandOf(project, task)) : '')
        + bugBlock(task))

    // O Claude Code não auto-aprova edits em .claude/ mesmo com acceptEdits.
    // Como as tasks vivem em .claude/claude-kanban/tasks/, liberamos Edit/Write
    // desse caminho explicitamente para o modelo poder preencher o ## Resultado.
    const allowRules = ['.claude/claude-kanban/tasks/**', `${SPEC_REL}/**`]
      .flatMap(glob => [`Edit(${glob})`, `Write(${glob})`])
    const allowedTools = [project.allowedTools, ...allowRules].filter(Boolean).join(' ')

    const turns = turnLimit(project)
    const args = [
      ...(resumeFrom ? ['--resume', resumeFrom] : []),
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      ...(turns ? ['--max-turns', String(turns)] : []),
      ...(model ? ['--model', model] : []),
      ...sandboxArgs(project),
      ...(rawPhase === 'plan'
        ? ['--permission-mode', 'plan']
        : project.skipPermissions
        ? ['--dangerously-skip-permissions']
        : ['--permission-mode', 'acceptEdits', '--allowedTools', allowedTools]),
    ]

    const child = spawn('claude', args, {
      cwd: workspace.cwd,
      env: { ...process.env, CLAUDE_KANBAN_TASK_ID: task.id },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timeoutMs = project.timeoutMs || DEFAULT_TIMEOUT_MS
    const a = {
      projectId, taskId, child, timer: null, result: null, stderr: '', workspace, taskRelPath, timeoutMs,
      logStream: null, logBytes: 0, logEvents: [], resumeFrom, answer, rawPhase, rawExec, plan: null,
      // Plan mode não edita arquivo por definição: a ociosidade o mataria.
      watch: project.stuckDetection === false || rawPhase === 'plan' ? null : { lastKey: null, repeats: 0, idle: 0 },
      stuck: null,
    }

    // Log persistido: cada run recomeça o arquivo do zero (o drawer mostra a
    // última execução da task, não o acumulado de todas as tentativas).
    try {
      const logPath = logFile(project.path, taskId)
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      a.logStream = fs.createWriteStream(logPath, { flags: 'w' })
      a.logStream.on('error', () => { a.logStream = null })
    } catch { /* log é best-effort: nunca derruba o run */ }

    a.timer = setTimeout(() => {
      a.timedOut = true
      this.kill(taskId)
    }, timeoutMs)

    this.actives.set(taskId, a)
    if (resumeFrom) {
      const note = { type: 'raw', text: rawExec
        ? `[plan-execute] executando o plano na sessão ${resumeFrom}`
        : `[resume] continuando a sessão ${resumeFrom} com a resposta humana` }
      this.recordLog(a, note)
      this.emit('run.log', { projectId, taskId, event: note })
    }
    this.emit('run.started', { projectId, taskId, pid: child.pid, resumedFrom: resumeFrom })

    let buf = ''
    child.stdout.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let event
        try { event = JSON.parse(line) } catch { event = { type: 'raw', text: line } }
        if (event.type === 'result') a.result = event
        if (rawPhase === 'plan') a.plan = exitPlanText(event) ?? a.plan
        this.recordLog(a, event)
        this.emit('run.log', { projectId, taskId, event })
        const stuck = a.watch && !a.stuck && stuckCheck(a.watch, event)
        if (stuck) {
          a.stuck = stuck
          this.logEvent(a, { type: 'raw', text: `[travada] ${stuck} — encerrando a sessão` })
          this.kill(taskId)
        }
      }
    })
    child.stderr.on('data', d => { a.stderr += d })

    child.on('close', code => this.settle(a, code))
    child.on('error', err => {
      a.stderr += `\nspawn error: ${err.message}`
      this.finish(a, -1)
    })
  }

  // Decomposição imediata pedida pelo usuário via API (não passa pela fila:
  // é uma sessão somente leitura e barata, como a análise do projeto).
  decomposeNow(projectId, taskId) {
    if (this.queue.some(q => q.taskId === taskId) || this.actives.has(taskId)) return false
    const project = this.getProject(projectId)
    if (!project) return false
    if (!findTask(project.path, taskId)) return false
    clearExecuted(taskId) // pedido explícito: libera mesmo se já executada
    this.startDecompose(project, taskId, 'forced')
    return true
  }

  // Roda a sessão de decomposição no lugar da execução normal. Registrada em
  // actives para o kill/queue view funcionarem como num run comum.
  startDecompose(project, taskId, mode) {
    const projectId = project.id
    let task = findTask(project.path, taskId)
    if (!task) return
    task = updateTask(project.path, taskId, {
      status: 'doing',
      run: { started_at: new Date().toISOString(), attempts: (task.run?.attempts || 0) + 1 },
    })
    this.emit('task.upserted', { projectId, task })

    const { child, promise } = decomposeTask(project, task, mode)
    const a = { projectId, taskId, child, decompose: true }
    this.actives.set(taskId, a)
    this.emit('run.started', { projectId, taskId, pid: child.pid })
    promise.then(res => this.finishDecompose(a, res), err => this.finishDecompose(a, null, err))
  }

  finishDecompose(a, res, err) {
    if (!this.actives.delete(a.taskId)) return
    const project = this.getProject(a.projectId)
    if (!project) return this.tick()
    const completedAt = new Date().toISOString()

    if (a.killed) {
      const task = updateTask(project.path, a.taskId, { status: 'todo', run: { completed_at: completedAt } })
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${completedAt}] Decomposição cancelada manualmente pelo usuário.`)
      this.emit('task.upserted', { projectId: a.projectId, task })
      this.emit('run.killed', { projectId: a.projectId, taskId: a.taskId })
      return this.tick()
    }

    if (err) {
      const task = updateTask(project.path, a.taskId, { status: 'todo', run: { completed_at: completedAt, exit_code: -1 } })
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${completedAt}] Falha na decomposição: ${err.message}`)
      this.emit('task.upserted', { projectId: a.projectId, task })
      this.emit('run.finished', { projectId: a.projectId, taskId: a.taskId, exitCode: -1 })
      return this.tick()
    }

    // Modo auto e o modelo decidiu que não vale desmembrar: executa normalmente.
    if (!res.decompose) {
      this.start(a.projectId, a.taskId, { skipDecompose: true })
      return
    }

    const parent = findTask(project.path, a.taskId)
    const level = subtaskLevel(parent) + 1
    const created = []
    // deps: índices (na lista final) de que cada subtask depende. Com desenho, ele
    // vem primeiro e as subtasks sem dependência passam a esperar por ele.
    const design = needsDesign(parent, level - 1)
    const subtasks = design
      ? [{ ...designSubtask(parent), deps: [] },
        ...res.subtasks.map(s => ({ ...s, deps: s.deps?.length ? s.deps.map(d => d + 1) : [0] }))]
      : res.subtasks
    for (const [i, s] of subtasks.entries()) {
      const t = createTask(project.path, {
        title: s.title,
        description: `${s.description}\n\n_Subtask desmembrada de "${parent.title}" (${parent.id})._`,
        priority: s.priority,
        tags: ['subtask', `pai:${parent.id}`, `nivel:${level}`, ...(s.tags || [])],
        status: 'todo',
        model: parent.model || null,
        // null = deixa o autoDecompose do projeto decidir se essa subtask ainda
        // vale quebrar; no último nível fecha a porta para não descer infinito.
        decompose: s.decompose ?? (level >= MAX_DECOMPOSE_LEVEL ? false : null),
        // Grafo validado pelo decomposer (sem ciclo); sem ele, série na ordem da
        // lista. Subtasks sem dependência entre si rodam em paralelo (worktrees),
        // todas partindo de kanban/<pai> — que já tem o que as dependências
        // integraram.
        depends_on: (s.deps || (i ? [i - 1] : [])).map(d => created[d].id),
      })
      created.push(t)
      this.emit('task.upserted', { projectId: a.projectId, task: t })
    }

    appendToSection(project.path, a.taskId, 'Resultado',
      `Task desmembrada em ${created.length} subtasks:\n${created.map(t => `- ${t.id} — ${t.title}`).join('\n')}\n\n` +
      `Ela volta a rodar, como integração, quando todas concluírem.`)
    // O pai não está pronto: volta para todo dependendo de todas as filhas e,
    // quando elas concluírem, roda como integração (sem desmembrar de novo).
    // Tentativas zeradas — as que ele gastou antes do replanejamento não contam.
    const task = updateTask(project.path, a.taskId, {
      status: 'todo',
      tags: withTag(parent.tags, DECOMPOSED_TAG).filter(t => t !== 'blocked'),
      decompose: false,
      depends_on: created.map(t => t.id),
      run: {
        completed_at: completedAt, exit_code: 0, cost_usd: res.costUsd, attempts: 0,
        total_cost_usd: taskCost(parent) + (res.costUsd || 0),
      },
    })
    this.emit('task.upserted', { projectId: a.projectId, task })
    this.emit('run.finished', {
      projectId: a.projectId, taskId: a.taskId, exitCode: 0,
      costUsd: res.costUsd, decomposed: created.map(t => t.id),
    })
    this.tick()
  }

  // Guarda o evento no buffer em memória (fonte do replay enquanto o run está
  // ativo) e no .jsonl. O buffer é sempre superconjunto do que já foi ao WS —
  // o push acontece antes do emit — então o cliente pode substituir o que tem
  // pelo histórico sem perder eventos nem duplicar.
  recordLog(a, event) {
    a.logEvents.push(event)
    if (a.logEvents.length > MAX_LOG_EVENTS) a.logEvents.shift()
    if (!a.logStream || a.logTruncated) return
    const line = JSON.stringify(event) + '\n'
    a.logBytes += Buffer.byteLength(line)
    if (a.logBytes > MAX_LOG_BYTES) {
      a.logTruncated = true
      a.logStream.write(JSON.stringify({ type: 'raw', text: `[log truncado: passou de ${MAX_LOG_BYTES} bytes]` }) + '\n')
      return
    }
    a.logStream.write(line)
  }

  // Replay do log de uma task: buffer em memória se ela está rodando agora,
  // senão o .jsonl da última execução.
  readLog(projectPath, taskId) {
    const active = this.actives.get(taskId)
    if (active) return active.logEvents

    let raw
    try { raw = fs.readFileSync(logFile(projectPath, taskId), 'utf8') } catch { return null }
    const events = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { events.push({ type: 'raw', text: line }) }
    }
    return events.slice(-MAX_LOG_EVENTS)
  }

  // Gate de verificação: `exit 0` do claude não basta para virar done. Roda,
  // no worktree da task e antes do cleanup, o verifyCommand do projeto, o
  // comando de aceite (objetivo) e a checagem do teste de reprodução (bug);
  // para no primeiro que reprova. Cada um vai para o log do run como `verify`.
  verifyGate(a, project, exitCode) {
    a.verify = null
    a.evidence = []
    if (exitCode !== 0 || a.killed || a.timedOut) return null
    const task = findTask(project.path, a.taskId)
    const checks = [
      () => {
        const cmd = String(project.verifyCommand || '').trim()
        if (!cmd) return null
        const v = runVerify(cmd, a.workspace.cwd)
        return v.ok ? v : this.compareWithBaseline(project, a.workspace, v)
      },
      () => {
        const cmd = acceptanceCommandOf(project, task)
        if (!cmd) return null
        const v = { ...runVerify(cmd, a.workspace.cwd), acceptance: true }
        a.evidence.push(`Testes de aceite (\`${cmd}\`): ${v.ok ? 'passaram' : 'FALHARAM'}.\n${v.output.slice(-2000)}`)
        return v
      },
      () => task?.tags?.includes(BUG_TAG) && !a.rawPhase ? this.reproCheck(a, project) : null,
    ]
    for (const check of checks) {
      const v = check()
      if (!v) continue
      a.verify = v
      this.logEvent(a, {
        type: 'verify', command: v.command, ok: v.ok, exitCode: v.exitCode,
        text: v.preexisting ? `[as falhas abaixo já existiam na base — não contam contra a task]\n\n${v.output}` : v.output,
      })
      if (!v.ok) break
    }
    return a.verify
  }

  // Bug: o teste registrado em "## Teste de reprodução" tem de passar na branch
  // e falhar na base — rodado no worktree destacado do verify de referência,
  // com os arquivos de teste da branch copiados (senão "arquivo não existe"
  // contaria como reprodução).
  reproCheck(a, project) {
    const ws = a.workspace
    let md = ''
    try { md = fs.readFileSync(path.join(ws.cwd, a.taskRelPath), 'utf8') } catch {}
    const command = sectionCommand(md || findTask(project.path, a.taskId)?.body, REPRO_SECTION)
    const fail = (output, exitCode = 1) => ({ command: command || 'teste de reprodução', ok: false, exitCode, output })
    if (!command) {
      return fail(`Task com tag \`${BUG_TAG}\` sem teste que reproduz o bug. Escreva primeiro um teste que falha sem a ` +
        `correção e registre o comando que o roda na seção "## ${REPRO_SECTION}" do arquivo da task.`)
    }
    const mine = runVerify(command, ws.cwd)
    if (!mine.ok) return fail(`O teste de reprodução não passa na branch:\n\n${mine.output}`, mine.exitCode)
    const sha = ws.baseSha
    if (!sha || !isGitRepo(project.path)) return { ...mine, output: `(sem base git para conferir a reprodução)\n\n${mine.output}` }
    let files = []
    try { files = testFiles(diffStats(captureDiff(ws.cwd, diffBase(ws))).files) } catch {}
    let base
    try {
      base = withDetachedWorktree(project.path, sha, dir => {
        for (const f of files) {
          const src = path.join(ws.cwd, f)
          if (!fs.existsSync(src)) continue
          fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
          fs.copyFileSync(src, path.join(dir, f))
        }
        return runVerify(command, dir)
      }, '_repro')
    } catch (e) { return { ...mine, output: `(não consegui rodar na base: ${e.message})\n\n${mine.output}` } }
    a.evidence.push(`Teste de reprodução (\`${command}\`): falha na base ${sha.slice(0, 8)}: ${!base.ok ? 'sim' : 'NÃO'}; passa na branch: sim.`)
    if (base.ok) {
      return fail(`O teste de reprodução \`${command}\` passa na base ${sha.slice(0, 8)} — ele não reproduz o bug. ` +
        `Escreva um teste que falhe sem a correção.\n\n${base.output}`)
    }
    return { ...mine, output: `Falha na base ${sha.slice(0, 8)} e passa na branch.\n\n${mine.output}` }
  }

  // Verify de referência: a base (de onde a branch saiu) roda o mesmo comando
  // num worktree destacado. Se a base já falhava igual, a falha não é da task —
  // sem isso, um teste quebrado na main consome as tentativas de todo mundo.
  // ponytail: spawnSync como o verify normal — bloqueia o event loop enquanto
  // roda; só acontece quando o verify da task falha, e fica em cache por sha.
  compareWithBaseline(project, workspace, verify) {
    const sha = workspace?.baseSha
    if (!sha || !isGitRepo(project.path)) return verify
    const key = `${project.id}:${sha}:${verify.command}`
    if (!this.baselines.has(key)) {
      if (this.baselines.size > 50) this.baselines.clear()
      let res = null
      // o caminho do worktree da base vira um marcador (o cache serve a tasks em cwds diferentes)
      try {
        res = withDetachedWorktree(project.path, sha, dir => {
          const r = runVerify(verify.command, dir)
          return { ...r, output: r.output.split(dir).join(BASE_DIR_MARK) }
        })
      } catch {}
      this.baselines.set(key, res)
    }
    const base = this.baselines.get(key)
    if (!base || base.ok) return verify
    // sem isso toda linha com caminho absoluto parece falha nova
    const fresh = newFailures(verify.output, base.output.split(BASE_DIR_MARK).join(workspace.cwd || project.path))
    if (!fresh.length) return { ...verify, ok: true, preexisting: true }
    const head = `Falhas novas — a base ${sha.slice(0, 8)} já falhava, mas não nestas linhas:\n${fresh.join('\n')}\n\n`
    return { ...verify, output: head + verify.output.slice(-(MAX_VERIFY_OUTPUT - head.length)) }
  }

  logEvent(a, event) {
    this.recordLog(a, event)
    this.emit('run.log', { projectId: a.projectId, taskId: a.taskId, event })
  }

  // O processo saiu. Os gates que precisam de sessão (revisão) não cabem no
  // finish síncrono: rodam aqui, com o run ainda em actives, e o finish recebe
  // o veredito pronto em a.review.
  async settle(a, exitCode) {
    try { await this.reviewGate(a, exitCode) } catch (e) {
      a.stderr += `\nfalha nos gates pós-run: ${e.message}`
    }
    this.finish(a, exitCode)
  }

  async reviewGate(a, exitCode) {
    const project = this.getProject(a.projectId)
    if (!project?.reviewGate || exitCode !== 0 || a.killed || a.timedOut || a.rawPhase === 'plan') return
    const verify = this.verifyGate(a, project, exitCode)
    if (verify && !verify.ok) return
    let md = ''
    try { md = fs.readFileSync(path.join(a.workspace.cwd, a.taskRelPath), 'utf8') } catch {}
    if (hasHumanRequest(md)) return
    this.logEvent(a, { type: 'raw', text: '[revisão] conferindo se o diff entrega o que a task pede…' })
    let diff = null
    try { diff = captureDiff(a.workspace.cwd, diffBase(a.workspace)) } catch {}
    const title = findTask(project.path, a.taskId)?.title || ''
    // Checagem visual: sobe a app a partir do worktree e tira um screenshot para
    // o revisor olhar. Falhar aqui não reprova — só fica sem a imagem.
    let shot = null
    const vc = project.visualCheck
    if (vc?.command && vc?.url) {
      this.logEvent(a, { type: 'raw', text: '[revisão] subindo a aplicação para o screenshot…' })
      shot = await screenshotApp(vc, a.workspace.cwd)
      this.logEvent(a, { type: 'raw', text: shot.path ? `[revisão] screenshot: ${shot.path}` : `[revisão] sem screenshot: ${shot.error}` })
    }
    try {
      a.review = await reviewTask(project, { title, body: md }, diff, a.workspace.cwd, shot?.path, a.evidence)
    } finally {
      if (shot?.path) fs.rmSync(shot.path, { force: true })
    }
    this.logEvent(a, { type: 'review', approved: a.review.approved, text: a.review.feedback || 'aprovado' })
  }

  // Esgotou as tentativas: com autoDecompose ligado, a task é desmembrada (uma
  // vez) levando o Log de erros como contexto, em vez de travar a árvore toda
  // como blocked. Devolve true quando replanejou. Muta o patch.
  blockOrReplan(project, task, patch) {
    if (!task) return false
    if (project.autoDecompose && !task.tags?.includes(REPLANNED_TAG) && !rawModeOf(project)) {
      patch.tags = withTag(patch.tags || task.tags, REPLANNED_TAG).filter(t => t !== 'blocked')
      patch.decompose = true
      patch.scheduled_at = null
      return true
    }
    patch.tags = withTag(patch.tags || task.tags, 'blocked')
    // Com autopilot.diagnose, o blocked é provisório: o diagnóstico roda logo
    // depois do updateTask do chamador e decide o que fazer com a task.
    if (project.autopilot?.diagnose?.enabled && (task.run?.diagnoses || 0) < MAX_DIAGNOSES
      && !this.diagnosing.has(task.id)) {
      this.diagnosing.set(task.id, new Promise(r => setImmediate(r))
        .then(() => this.diagnose(project, task.id))
        .catch(() => {})
        .finally(() => this.diagnosing.delete(task.id)))
    }
    return false
  }

  // Diagnóstico da falha (lib/diagnoser.js) e a ação para cada causa. Falhar
  // aqui deixa a task como estava: blocked.
  async diagnose(project, taskId) {
    const task = findTask(project.path, taskId)
    if (!task?.tags?.includes('blocked')) return
    let diff = ''
    try { diff = fs.readFileSync(diffFile(project.path, taskId), 'utf8') } catch {}
    const open = listTasks(project.path).filter(t => t.id !== taskId && !['done', 'archived'].includes(t.status))
    const n = (task.run?.diagnoses || 0) + 1
    const now = () => new Date().toISOString()
    let dx
    try {
      dx = await diagnoseTask(project, task, diff, open)
    } catch (e) {
      updateTask(project.path, taskId, { run: { diagnoses: n } })
      appendToSection(project.path, taskId, 'Log de erros', `[${now()}] Diagnóstico automático falhou: ${e.message}`)
      return
    }
    const cur = findTask(project.path, taskId)
    const tags = withTag(cur.tags, DIAGNOSED_PREFIX + dx.cause)
    const run = { diagnoses: n, total_cost_usd: taskCost(cur) + (dx.costUsd || 0) }
    // Volta para a fila do zero (as tentativas que levaram ao diagnóstico não contam).
    const unblock = { tags: tags.filter(t => t !== 'blocked'), run: { ...run, attempts: 0 }, scheduled_at: null }
    const spawnTask = (fallbackTitle, extraTags) => {
      const t = createTask(project.path, {
        title: dx.task?.title || fallbackTitle,
        description: `${dx.task?.description || dx.summary}\n\n_Criada pelo diagnóstico da task "${cur.title}" (${taskId})._`,
        priority: 'urgent', status: 'todo', tags: ['diagnostico', ...extraTags],
      })
      this.emit('task.upserted', { projectId: project.id, task: t })
      return t
    }
    const dependOn = id => ({ ...unblock, depends_on: [...new Set([...(cur.depends_on || []), id])] })

    let patch
    let action
    switch (dx.cause) {
      case 'ambiente': {
        const t = spawnTask(`Preparar ambiente para "${cur.title}"`, [])
        patch = dependOn(t.id)
        action = `criada a task pré-requisito ${t.id} (urgent); esta espera por ela.`
        break
      }
      case 'flaky': {
        const v = this.rerunVerify(project, cur)
        if (v?.ok) {
          patch = unblock
          action = `o verify (\`${v.command}\`) passou ao rodar de novo na branch; nova tentativa.`
        } else if (v) {
          const t = spawnTask(`Corrigir ou pôr em quarentena teste instável (${cur.title})`, ['flaky'])
          patch = dependOn(t.id)
          action = `o verify falhou de novo; criada a task ${t.id} para corrigir/quarentenar o teste.`
        } else {
          patch = unblock
          action = 'sem verify para repetir; nova tentativa.'
        }
        break
      }
      case 'spec_ambigua':
        patch = {
          ...unblock, tags: withTag(unblock.tags, AUTO_DECIDED_TAG),
          body: replaceSection(cur.body, 'Human Response', `${AUTO_DECIDE_RESPONSE}\n\nDiagnóstico: ${dx.summary}`),
        }
        action = 'a sessão seguinte decide pela spec/ADRs e registra um ADR.'
        break
      case 'grande_demais':
        // decompose: true força o desmembramento mesmo acima de MAX_DECOMPOSE_LEVEL.
        patch = { ...unblock, decompose: true }
        action = 'a task será desmembrada de novo.'
        break
      case 'falta_dependencia': {
        const dep = dx.dependsOn && open.find(t => t.id === dx.dependsOn)
        if (dep) {
          patch = dependOn(dep.id)
          action = `esta task passa a depender de ${dep.id} (${dep.title}).`
        } else if (dx.task) {
          const t = spawnTask(dx.task.title, [])
          patch = dependOn(t.id)
          action = `criada a task ${t.id} com o que falta; esta espera por ela.`
        }
        break
      }
    }
    if (!patch) {
      // externo (ou dependência sem task identificável): precisa de gente.
      patch = { tags, run }
      action = 'precisa de um humano — continua blocked.'
      this.emit('task.attention', { projectId: project.id, taskId, reason: `${dx.cause}: ${dx.summary}` })
    }
    const updated = updateTask(project.path, taskId, patch)
    appendToSection(project.path, taskId, 'Log de erros',
      `[${now()}] Diagnóstico automático (${n}/${MAX_DIAGNOSES}): **${dx.cause}** — ${dx.summary}\nAção: ${action}`)
    this.emit('task.upserted', { projectId: project.id, task: updated })
  }

  // Repete o verifyCommand na branch da task (o worktree dela já foi removido).
  rerunVerify(project, task) {
    const cmd = String(project.verifyCommand || '').trim()
    const branch = task.run?.branch
    if (!cmd || !branch || !isGitRepo(project.path)) return null
    try { return withDetachedWorktree(project.path, branch, dir => runVerify(cmd, dir), '_flaky') } catch { return null }
  }

  finish(a, exitCode) {
    if (!this.actives.delete(a.taskId)) return
    clearTimeout(a.timer)
    const project = this.getProject(a.projectId)
    if (!project) { try { a.logStream?.end() } catch {}; return this.tick() }

    let verify = 'verify' in a ? a.verify : this.verifyGate(a, project, exitCode)
    // Revisão reprovada segue o mesmo caminho da verificação reprovada.
    if ((!verify || verify.ok) && a.review && !a.review.approved) {
      verify = { command: 'revisão automática', ok: false, exitCode: 1, output: a.review.feedback || '(sem feedback)', review: true }
    }

    try { a.logStream?.end() } catch {}

    // Captura o diff antes/depois do que a task produziu — precisa acontecer
    // antes de remover o worktree.
    let hasDiff = false
    let diff = null
    try {
      diff = captureDiff(a.workspace.cwd, diffBase(a.workspace))
      if (diff) {
        const file = diffFile(project.path, a.taskId)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, diff)
        hasDiff = true
      }
    } catch {}

    // A sessão pode ter aberto uma PR (autoPR): o resultado só existe no log dela,
    // então perguntamos ao `gh` qual é a PR da branch. Também antes do cleanup.
    let pr = null
    try {
      const g = gitSettings(project)
      if (exitCode === 0 && !a.killed && !a.timedOut && g.autoPush && a.workspace.branch) {
        pr = capturePR(a.workspace.cwd, a.workspace.branch)
      }
    } catch {}

    // Traz o resultado escrito no worktree de volta ao projeto e remove o worktree
    // (a branch da task é preservada) — precisa acontecer antes dos updateTask abaixo.
    try { cleanupWorkspace(project, a.workspace, a.taskRelPath) } catch {}

    const r = a.result || {}
    const prev = findTask(project.path, a.taskId)
    const runMeta = {
      has_diff: hasDiff,
      pr,
      completed_at: new Date().toISOString(),
      exit_code: exitCode,
      session_id: r.session_id ?? null,
      cost_usd: r.total_cost_usd ?? null,
      total_cost_usd: (prev ? taskCost(prev) : 0) + (r.total_cost_usd || 0) + (a.review?.costUsd || 0),
      duration_ms: r.duration_ms ?? null,
      num_turns: r.num_turns ?? null,
      exit_reason: exitReason(a, exitCode, verify),
      // null = revisão não rodou (ou revisor fora do ar). Base do auto-merge.
      review_approved: a.review && !a.review.skipped ? a.review.approved : null,
    }

    const task = prev
    const attempts = task?.run?.attempts || 0
    // Teto de turnos estourado: a sessão parou no meio, não falhou por acaso.
    // Re-executar do zero gastaria tudo de novo para parar no mesmo lugar, então
    // isso nunca conta como retentativa — vai direto para revisão humana.
    const maxTurnsHit = a.result?.subtype === 'error_max_turns'

    // Resume falhou (sessão expirada, id desconhecido, CLI sem o histórico…):
    // cai no run normal, com o prompt completo, levando junto a pergunta e a
    // resposta humana — que já saíram do corpo da task.
    if (a.resumeFrom && exitCode !== 0 && !a.killed && !a.timedOut) {
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${runMeta.completed_at}] Falha ao retomar a sessão ${a.resumeFrom} (exit code ${exitCode}). ` +
        `Re-executando do zero com o prompt completo.\n\n\`\`\`\n${(a.stderr || '').slice(-2000)}\n\`\`\``)
      this.start(a.projectId, a.taskId, a.rawExec
        ? { noResume: true, rawExec: { plan: a.rawExec.plan } }
        : { noResume: true, human: a.answer })
      return
    }
    if (a.killed && !a.timedOut && !a.stuck) {
      updateTask(project.path, a.taskId, { status: 'todo', run: runMeta })
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${runMeta.completed_at}] Sessão morta manualmente pelo usuário.`)
      this.emit('run.killed', { projectId: a.projectId, taskId: a.taskId })
    } else if (maxTurnsHit && !a.timedOut) {
      const patch = { status: 'todo', run: runMeta }
      const replanned = this.blockOrReplan(project, task, patch)
      updateTask(project.path, a.taskId, patch)
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${runMeta.completed_at}] Teto de ${turnLimit(project)} turnos atingido — a sessão parou no meio. ` +
        `Sem nova tentativa automática (repetir gastaria o mesmo para parar no mesmo ponto). ` +
        (replanned ? REPLAN_NOTE : `Quebre a task em partes menores ou aumente o limite de turnos do projeto.`))
      this.emit('run.finished', {
        projectId: a.projectId, taskId: a.taskId, exitCode, maxTurns: true,
        costUsd: runMeta.cost_usd, durationMs: runMeta.duration_ms,
        numTurns: runMeta.num_turns, sessionId: runMeta.session_id,
      })
    } else if (a.rawPhase === 'plan' && exitCode === 0 && !a.timedOut) {
      // Plano pronto: vai para "## Plano". Em 'plan' a task termina aqui; em
      // 'plan-execute' a mesma sessão é retomada para executar.
      const plan = (a.plan || r.result || '').trim()
      if (plan) updateTask(project.path, a.taskId, { body: replaceSection(task.body, 'Plano', plan) })
      if (rawModeOf(project) === 'plan-execute') {
        updateTask(project.path, a.taskId, { run: runMeta })
        this.start(a.projectId, a.taskId, { rawExec: { plan, sessionId: runMeta.session_id } })
        return
      }
      updateTask(project.path, a.taskId, { status: 'done', run: runMeta })
      markSucceeded(a.taskId, { completedAt: runMeta.completed_at, sessionId: runMeta.session_id })
      this.emit('run.finished', {
        projectId: a.projectId, taskId: a.taskId, exitCode,
        costUsd: runMeta.cost_usd, durationMs: runMeta.duration_ms,
        numTurns: runMeta.num_turns, sessionId: runMeta.session_id,
      })
    } else if (exitCode === 0 && !a.timedOut && hasHumanRequest(task?.body)) {
      // O agente sinalizou que depende de uma decisão humana: o card volta para
      // todo com a tag human-request (fora do auto-pilot) em vez de concluir.
      // Com autoDecide ligado (e abaixo do teto), a resposta é escrita pelo
      // próprio orquestrador e a task volta para a fila — o run seguinte retoma
      // a sessão com a decisão tomada, sem ninguém precisar responder.
      const autoDecided = !!project.autoDecide && autoDecideCount(task.body) < MAX_AUTO_DECISIONS
      updateTask(project.path, a.taskId, {
        status: 'todo',
        run: runMeta,
        ...(autoDecided
          ? {
            body: replaceSection(task.body, 'Human Response', AUTO_DECIDE_RESPONSE),
            ...(task.tags?.includes(AUTO_DECIDED_TAG) ? {} : { tags: [...(task.tags || []), AUTO_DECIDED_TAG] }),
          }
          : (task.tags?.includes(HUMAN_REQUEST_TAG) ? {} : { tags: [...(task.tags || []), HUMAN_REQUEST_TAG] })),
      })
      this.emit('run.finished', {
        projectId: a.projectId, taskId: a.taskId, exitCode, humanRequest: true, autoDecided,
        costUsd: runMeta.cost_usd, durationMs: runMeta.duration_ms,
        numTurns: runMeta.num_turns, sessionId: runMeta.session_id,
        pr: runMeta.pr,
      })
      if (autoDecided) this.enqueue(a.projectId, a.taskId)
    } else if (verify && !verify.ok && !a.timedOut) {
      // Verificação reprovou: volta para todo (conta como tentativa) e NÃO entra
      // no ledger — o card precisa ser re-executado até a build passar. Segue a
      // mesma política de retry das falhas de execução (antes ignorava a config
      // do projeto e retentava 3x fixo, sem nenhum backoff).
      const { maxAttempts, backoffMinutes } = retrySettings(project)
      const patch = { status: 'todo', run: runMeta }
      let retryAt = null
      let replanned = false
      if (attempts >= maxAttempts) {
        replanned = this.blockOrReplan(project, task, patch)
      } else if (project.autoRun && backoffMinutes > 0) {
        retryAt = new Date(Date.parse(runMeta.completed_at) + backoffMinutes * 60_000).toISOString()
        patch.scheduled_at = retryAt
      }
      updateTask(project.path, a.taskId, patch)
      const verifyRetryNote = (retryAt
        ? `\nNova tentativa agendada para ${retryAt} (tentativa ${attempts + 1} de ${maxAttempts}).`
        : '') + (replanned ? `\n${REPLAN_NOTE}` : '')
      appendToSection(project.path, a.taskId, 'Log de erros', verify.review
        ? `[${runMeta.completed_at}] Revisão automática reprovou o trabalho.${verifyRetryNote}\n\n${verify.output}`
        : `[${runMeta.completed_at}] Verificação falhou: \`${verify.command}\` (exit ${verify.exitCode}).${verifyRetryNote}\n\n\`\`\`\n${verify.output}\n\`\`\``)
      this.emit('run.finished', {
        projectId: a.projectId, taskId: a.taskId, exitCode, verifyFailed: true,
        costUsd: runMeta.cost_usd, durationMs: runMeta.duration_ms,
        numTurns: runMeta.num_turns, sessionId: runMeta.session_id,
      })
    } else if (exitCode === 0 && !a.timedOut) {
      // No modo cru o agente não sabe do arquivo da task: a resposta final da
      // sessão vira o "## Resultado".
      if (a.rawPhase && r.result?.trim()) {
        updateTask(project.path, a.taskId, { body: replaceSection(task.body, 'Resultado', r.result.trim()) })
      }
      const tags = (task.tags || []).filter(t => t !== CONFLICT_TAG)
      // O feedback da PR já foi atendido nesta execução.
      const cur = findTask(project.path, a.taskId)
      const done = updateTask(project.path, a.taskId, {
        status: 'done', tags,
        // Objetivo integrado: o autopilot (gapLoop) confere a spec e abre as lacunas.
        run: { ...runMeta, merge_from: null, ...(isGoal(task) ? { gap_pending: true } : {}) },
        ...(getSection(cur?.body, PR_FEEDBACK) ? { body: removeSection(cur.body, PR_FEEDBACK) } : {}),
      })
      try { harvestNotes(project.path, done) } catch {}
      const acceptance = task.tags?.includes(DESIGN_TAG) && parentIdOf(task) && sectionCommand(done.body, ACCEPTANCE_SECTION)
      if (acceptance) {
        const goal = updateTask(project.path, parentIdOf(task), { acceptance_command: acceptance })
        if (goal) this.emit('task.upserted', { projectId: a.projectId, task: goal })
      }
      // Registra no ledger ANTES de qualquer coisa depender do status: mesmo que
      // o done/ se perca depois, o card não roda de novo.
      markSucceeded(a.taskId, { completedAt: runMeta.completed_at, sessionId: runMeta.session_id })
      this.emit('run.finished', {
        projectId: a.projectId, taskId: a.taskId, exitCode,
        costUsd: runMeta.cost_usd, durationMs: runMeta.duration_ms,
        numTurns: runMeta.num_turns, sessionId: runMeta.session_id,
        pr: runMeta.pr,
      })
      // Subtask integra no pai; o resto vai para a base se a política deixar.
      const into = parentIdOf(task) && taskBranch(parentIdOf(task))
      if (into) {
        if (a.workspace.branch && a.workspace.branch !== into) {
          this.enqueueMerge({ projectId: project.id, taskId: a.taskId, branch: a.workspace.branch, into, kind: 'parent' })
        }
      } else {
        this.autoMerge(project, done, diff, a.workspace.branch)
      }
    } else {
      const reason = a.timedOut
        ? `Timeout da execução. Limite configurado: ${Math.round((a.timeoutMs || DEFAULT_TIMEOUT_MS) / 60000)} min.`
        : a.stuck ? `Sessão travada: ${a.stuck}.`
        : `${EXIT_REASON_TEXT[runMeta.exit_reason] || 'Falha'} (exit code ${exitCode ?? 'nenhum'}).`
      // O CLI reporta a maioria dos erros (API, crédito, custo) no evento result,
      // não no stderr — sem isso o log mostrava só "Exit code 1" e um bloco vazio.
      const detail = [r.result, ...(Array.isArray(r.errors) ? r.errors : [])]
        .filter(x => typeof x === 'string' && x.trim()).join('\n').slice(-2000)
      const { maxAttempts, backoffMinutes } = retrySettings(project)
      const patch = { status: 'todo', run: runMeta }
      let retryAt = null
      let replanned = false
      if (attempts >= maxAttempts) {
        replanned = this.blockOrReplan(project, task, patch)
      } else if (project.autoRun && backoffMinutes > 0) {
        // Ainda há tentativa sobrando: em vez de deixar o auto-run repescar a task
        // no mesmo tick, marca o horário do retry e deixa o Scheduler enfileirá-la
        // quando o backoff vencer (autoEnqueue ignora scheduled_at no futuro).
        retryAt = new Date(Date.parse(runMeta.completed_at) + backoffMinutes * 60_000).toISOString()
        patch.scheduled_at = retryAt
      }
      updateTask(project.path, a.taskId, patch)
      const retryNote = (retryAt
        ? `\nNova tentativa agendada para ${retryAt} (tentativa ${attempts + 1} de ${maxAttempts}).`
        : '') + (replanned ? `\n${REPLAN_NOTE}` : '')
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${runMeta.completed_at}] ${reason}${retryNote}` +
        (detail ? `\n\nMensagem da sessão:\n\n> ${detail.replace(/\n/g, '\n> ')}` : '') +
        `\n\n\`\`\`\n${(a.stderr || '').slice(-2000)}\n\`\`\``)
      this.emit('run.finished', {
        projectId: a.projectId, taskId: a.taskId, exitCode, exitReason: runMeta.exit_reason,
        costUsd: runMeta.cost_usd, durationMs: runMeta.duration_ms,
        numTurns: runMeta.num_turns, sessionId: runMeta.session_id,
      })
    }
    this.tick()
  }

  // Agenda a sessão que resolve um conflito (merge de `mergeFrom` na branch da
  // task). Devolve false — e marca blocked — quando não dá para tentar de novo.
  scheduleConflictFix(project, task, mergeFrom, runMeta, message) {
    const rounds = task.run?.conflict_rounds || 0
    const resolving = !rawModeOf(project) && rounds < MAX_CONFLICT_ROUNDS
    const updated = updateTask(project.path, task.id, {
      status: 'todo',
      run: resolving ? { ...runMeta, merge_from: mergeFrom, conflict_rounds: rounds + 1 } : runMeta,
      tags: resolving ? withTag(task.tags, CONFLICT_TAG) : withTag(task.tags, 'blocked'),
    })
    appendToSection(project.path, task.id, 'Log de erros', `[${new Date().toISOString()}] ${message}` +
      (resolving ? `\nUma nova sessão vai mergear ${mergeFrom} na branch da task e resolver o conflito.` : ''))
    // Ledger antes do emit: o auto-run reage ao upsert e, com a task ainda no
    // ledger, a reconciliaria de volta para done.
    if (resolving) clearExecuted(task.id)
    this.emit('task.upserted', { projectId: project.id, task: updated })
    return resolving
  }

  // Auto-merge local na base, sem humano, quando a política deixa. Com PR aberta
  // quem mergeia é o autopilot (depois do CI). Subtask integra no pai, não aqui.
  autoMerge(project, task, diff, branch) {
    if (!task || parentIdOf(task) || task.run?.pr || !branch) return
    if (autoMergeBlocker(project, { reviewApproved: task.run.review_approved, diff })) return
    this.enqueueMerge({ projectId: project.id, taskId: task.id, branch, into: gitSettings(project).baseBranch, kind: 'base' })
  }

  // ---- fila de merge ----
  // Branches que passam sozinhas podem quebrar juntas. Cada item: atualiza com a
  // ponta atual do destino (merge-tree, sem checkout) → verifyCommand em cima do
  // resultado → grava. Um item por vez, em todos os projetos.
  // ponytail: serialização global; por destino se a fila virar gargalo.
  enqueueMerge(item) {
    if (this.mergeQueue.some(m => m.taskId === item.taskId)) return
    this.mergeQueue.push({ ...item, stage: null })
    this.persist()
    this.emit('run.queue', this.getQueueView())
    this.drainMerges()
  }

  drainMerges() {
    if (this.mergeDrain) return this.mergeDrain
    this.mergeDrain = (async () => {
      while (this.mergeQueue.length) {
        const item = this.mergeQueue[0]
        let again = false
        try { again = await this.processMerge(item) } catch (e) {
          console.error(`fila de merge: ${item.branch} → ${item.into}: ${e.message}`)
        }
        this.mergeQueue = this.mergeQueue.filter(m => m !== item)
        // O destino andou durante o verify: o resultado testado não vale mais.
        if (again) this.mergeQueue.push({ ...item, stage: null })
        this.persist()
        this.emit('run.queue', this.getQueueView())
      }
    })().finally(() => {
      this.mergeDrain = null
      if (this.mergeQueue.length) this.drainMerges()
      this.tick() // o pai pode ter ficado elegível
    })
    return this.mergeDrain
  }

  // Devolve true quando o item precisa voltar para o fim da fila.
  async processMerge(item) {
    const project = this.getProject(item.projectId)
    const task = project && findTask(project.path, item.taskId)
    if (!task) return false
    let r
    try { r = mergeResult(project.path, item.branch, item.into) } catch (e) {
      if (e.conflict) return this.mergeRejected(project, task, item, `Merge de ${item.branch} em ${item.into} conflitou: ${e.message}`)
      appendToSection(project.path, task.id, 'Log de erros', `[${new Date().toISOString()}] Merge em ${item.into} não aconteceu: ${e.message}`)
      return false
    }
    const cmd = String(project.verifyCommand || '').trim()
    if (cmd && !r.tested) {
      item.stage = 'verify'
      this.emit('run.queue', this.getQueueView())
      const v = await withDetachedWorktree(project.path, r.sha, async dir => {
        const out = await runVerifyAsync(cmd, dir)
        return out.ok ? out : this.compareWithBaseline(project, { baseSha: r.head, cwd: dir }, out)
      }, '_merge')
      if (!v.ok) {
        return this.mergeRejected(project, task, item, `A branch passou sozinha, mas quebra junto com o que já está em ${item.into}: ` +
          `\`${v.command}\` falhou no resultado do merge (exit ${v.exitCode}).\n\n\`\`\`\n${v.output}\n\`\`\``)
      }
    }
    if (resolveRef(project.path, item.into) !== r.head) return true
    return item.kind === 'parent' ? this.landParent(project, task, item) : this.landBase(project, task, item)
  }

  landParent(project, task, item) {
    mergeIntoBranch(project.path, item.branch, item.into)
    const t = updateTask(project.path, task.id, { tags: withTag(task.tags, INTEGRATED_TAG) })
    this.emit('task.upserted', { projectId: project.id, task: t })
    return false
  }

  landBase(project, task, item) {
    let res
    try { res = mergeTaskBranch(project, item.branch) } catch (e) {
      if (e.conflict) return this.mergeRejected(project, task, item, `Auto-merge em ${item.into} conflitou: ${e.message}`)
      // Checkout sujo, base inexistente…: fica para o humano aprovar pelo diff.
      appendToSection(project.path, task.id, 'Log de erros',
        `[${new Date().toISOString()}] Auto-merge não aconteceu: ${e.message}`)
      return false
    }
    // merge_sha: o autopilot reverte este merge se o CI da base quebrar nele.
    const merged = updateTask(project.path, task.id, {
      status: 'archived', tags: withTag(task.tags, 'merged'), run: { merge_sha: res.sha },
    })
    appendToSection(project.path, task.id, 'Resultado',
      `_Mergeado automaticamente em ${res.base} pela fila de merge${res.pushed ? ' (com push)' : ''}._`)
    this.emit('task.moved', { projectId: project.id, taskId: task.id, from: task.status, to: 'archived' })
    this.emit('task.upserted', { projectId: project.id, task: merged })
    return false
  }

  // Conflito ou verify reprovado depois de atualizar: a task volta com a
  // resolução de conflito (mergeia o destino na branch dela e corrige).
  mergeRejected(project, task, item, message) {
    const run = item.kind === 'parent' ? { exit_reason: 'integration_conflict' } : {}
    const resolving = this.scheduleConflictFix(project, task, item.into, run, message)
    // Fora do ledger também quando vai para o humano: o pai não conta como integrada.
    clearExecuted(task.id)
    if (resolving) this.enqueue(project.id, task.id)
    return false
  }

  // Crash recovery: tasks presas em doing/ sem processo ativo voltam para todo/
  recover(projects) {
    for (const project of projects) {
      let tasks
      try { tasks = listTasks(project.path).filter(t => t.status === 'doing') } catch { continue }
      for (const t of tasks) {
        // Se o card já concluiu com sucesso antes do restart, o doing/ é status
        // perdido (não commitado/reconciliado): reconcilia para done, não re-roda.
        if (wasSucceeded(t.id)) {
          updateTask(project.path, t.id, { status: 'done' })
          continue
        }
        updateTask(project.path, t.id, { status: 'todo' })
        appendToSection(project.path, t.id, 'Log de erros',
          `[${new Date().toISOString()}] Execução interrompida (restart do orquestrador).`)
      }
    }
    // Merge que estava na fila (ou no meio) quando o servidor caiu: refaz do zero.
    if (this.mergeQueue.length) this.drainMerges()
  }
}

// Por que o run terminou, gravado em run.exit_reason (null = sucesso ou pedido
// humano). Mesma precedência dos ramos de finish(); a UI traduz o código.
export function exitReason(a, exitCode, verify) {
  const r = a.result || {}
  if (a.timedOut) return 'timeout'
  if (a.stuck) return 'stuck'
  if (a.killed) return 'killed'
  if (r.subtype === 'error_max_turns') return 'max_turns'
  if (exitCode === 0) return verify && !verify.ok ? (verify.review ? 'review_rejected' : 'verify_failed') : null
  if (r.subtype === 'error_max_budget_usd') return 'max_budget'
  if (r.subtype === 'error_during_execution') return 'execution_error'
  if (r.is_error) return 'api_error'
  // Sem exit code = processo morto por sinal que não veio do orquestrador (OOM, kill externo).
  return exitCode == null ? 'signal' : 'exit_code'
}

const MAX_CONFLICT_ROUNDS = 2
export const PR_FEEDBACK = 'Feedback da PR'

// Sandbox nativo do Claude Code (project.sandbox): Bash confinado em filesystem
// e rede, além dos guardrails por regex. Vai por --settings para não mexer no
// settings.json do usuário.
// forbid: um comando barrado não é repetido fora do sandbox (o default "retry"
// anularia o confinamento numa sessão sem humano). gh fica de fora porque, no
// macOS, CLIs em Go falham a verificação TLS dentro do Seatbelt.
export const SANDBOX_SETTINGS = {
  enabled: true,
  failIfUnavailable: true,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: 'forbid',
  excludedCommands: ['gh'],
  network: {
    allowLocalBinding: true,
    allowedDomains: [
      'github.com', '*.github.com', '*.githubusercontent.com',
      'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org',
    ],
  },
}

export function sandboxArgs(project) {
  if (!project?.sandbox) return []
  return ['--settings', JSON.stringify({ sandbox: SANDBOX_SETTINGS })]
}

const REPLAN_NOTE = 'Replanejando: com o autoDecompose do projeto ligado, a task será desmembrada levando este log como contexto.'

const EXIT_REASON_TEXT = {
  max_budget: 'Teto de custo da sessão atingido',
  execution_error: 'Erro durante a execução da sessão',
  api_error: 'A sessão terminou com erro da API/CLI do Claude',
  signal: 'Processo encerrado por sinal externo (OOM, kill…)',
  exit_code: 'Processo do Claude saiu com erro',
}

// Texto do plano no evento de stream: o input da tool ExitPlanMode. No -p ninguém
// aprova a saída do plan mode, então é ali (e não no result) que o plano aparece
// inteiro. Devolve undefined quando o evento não traz plano.
export function exitPlanText(event) {
  if (event?.type !== 'assistant') return undefined
  const use = (event.message?.content || []).find(c => c.type === 'tool_use' && c.name === 'ExitPlanMode')
  return typeof use?.input?.plan === 'string' ? use.input.plan : undefined
}

// Prompt do modo cru: só o que a pessoa escreveria no terminal.
export function buildRawPrompt(task, phase, plan, resumed) {
  if (phase === 'execute' && plan && resumed) return 'Plano aprovado. Execute-o agora, do início ao fim.'
  const desc = getSection(task.body, 'Descrição') || ''
  const base = desc ? `${task.title}\n\n${desc}` : task.title
  return phase === 'execute' && plan ? `${base}\n\nExecute este plano, já aprovado:\n\n${plan}` : base
}

// Subtask não faz push nem PR: a branch dela é integrada pelo orquestrador na
// branch do pai, e quem entrega (push/PR na base) é o run de integração.
function promptGit(project, task) {
  const g = gitSettings(project)
  const parentId = parentIdOf(task)
  return parentId ? { ...g, integratesInto: taskBranch(parentId) } : g
}

function gitInstructions(branch, g) {
  if (!branch) return ''
  const steps = [`
5. Você já está na branch "${branch}" — NÃO troque de branch. Este é um worktree
   isolado: qualquer mudança que você NÃO commitar será DESCARTADA ao final. Antes
   de encerrar, é OBRIGATÓRIO commitar TODAS as suas alterações:
     - rode \`git add -A\` e depois \`git commit\` com mensagem descritiva;
     - confirme com \`git status\` que o working tree está limpo (nada em
       "Changes not staged" nem "Untracked files") ANTES de terminar.
   Se sobrar qualquer arquivo não commitado, o trabalho será perdido.`]
  if (g.integratesInto) {
    steps.push(`
6. NÃO faça push nem abra PR — o orquestrador integra esta branch em
   "${g.integratesInto}" (a branch da task pai) quando você terminar.`)
  } else if (g.autoPush) {
    steps.push(`
6. Se o repositório tiver remote configurado, faça push (git push -u origin ${branch}).`)
    if (g.autoPR) {
      steps.push(g.autoPRDescription ? `
7. Após o push, abra uma pull request com \`gh pr create\` (base: ${g.baseBranch}).
   Gere título e descrição a partir do que foi feito: resumo das mudanças,
   motivação e como testar. Se \`gh\` não estiver disponível ou falhar,
   registre no Resultado e siga em frente.` : `
7. Após o push, abra uma pull request com \`gh pr create\` (base: ${g.baseBranch})
   usando o título da task e descrição mínima (apenas uma linha citando a task
   ${branch} — NÃO gere descrição longa; ela será escrita manualmente).
   Se \`gh\` não estiver disponível ou falhar, registre no Resultado e siga em frente.`)
    }
  } else {
    steps.push(`
6. NÃO faça push — o push será feito manualmente pelo usuário.`)
  }
  return steps.join('')
}

// Instrução opcional de enriquecimento: 'always' reescreve sempre; 'auto' deixa
// o próprio agente julgar se a descrição precisa; 'off' não instrui nada.
function enrichInstructions(mode) {
  if (mode !== 'always' && mode !== 'auto') return ''
  return `
Antes de implementar${mode === 'auto' ? ', SE julgar que a descrição está vaga, ambígua ou sem contexto suficiente' : ''}:
reescreva a seção "## Descrição" do arquivo da task para ficar mais clara e objetiva —
objetivo e escopo explícitos, arquivos/módulos relevantes do código citados pelo caminho,
critérios de aceite. Preserve TODA a intenção original (enriqueça, não invente requisitos).${mode === 'auto' ? '\nSe a descrição já estiver clara e específica, não a altere.' : ''}
Só então execute a task.
`
}

const HUMAN_REQUEST_INSTRUCTIONS = `
Se em algum ponto a task depender de uma escolha ou decisão humana que você não pode
tomar com segurança (ex.: ambiguidade de produto, trade-off de negócio, credencial),
NÃO decida por conta própria e NÃO invente: adicione ao arquivo da task uma seção
"## Human Request" descrevendo objetivamente a(s) pergunta(s) e as opções, registre
em "## Resultado" o que já foi feito, e encerre normalmente. O orquestrador devolverá
o card para revisão humana.
`

// Auto-decisão ligada: ninguém vai responder, então perguntar só queima uma sessão
// inteira para voltar ao mesmo ponto. Decida você mesmo e deixe a escolha registrada.
const AUTO_DECIDE_INSTRUCTIONS = `
Este projeto está com auto-decisão ligada: NÃO existe humano para responder. Se a task
depender de uma escolha (ambiguidade de produto, trade-off técnico), decida você mesmo:
primeiro pela spec e pelos ADRs existentes (${SPEC_REL}/) — não contrarie uma decisão
já registrada; se eles não cobrirem, pela opção que recomendaria (a mais simples e
reversível). Registre a decisão como novo ADR em ${SPEC_REL}/adr/NNNN-titulo.md
(número seguinte ao maior existente; contexto, decisão, alternativas, consequências),
para tasks futuras não decidirem o contrário, e cite-a em "## Resultado". Só abra uma seção "## Human Request" se a task
for de fato impossível sem um humano (credencial, acesso, aprovação externa).
`

const humanRequestInstructions = autoDecide =>
  autoDecide ? AUTO_DECIDE_INSTRUCTIONS : HUMAN_REQUEST_INSTRUCTIONS

// Bloco com o par pergunta/resposta quando o run é uma retomada sem sessão (ou um
// fallback de resume que falhou): as seções já saíram do corpo da task, então o
// contexto precisa vir pelo prompt.
const LEARNINGS_INSTRUCTION = `4b. Se descobriu algo NÃO óbvio sobre este projeto que pouparia tempo às próximas
   tasks (convenção, armadilha, comando que funciona), registre em bullets curtos
   numa seção "## Aprendizados" do arquivo da task. Nada de resumo do que fez.`

function humanAnswerBlock(answer) {
  if (!answer) return ''
  return `
Numa execução anterior você pediu uma decisão humana e o humano respondeu pela UI.
Considere a resposta abaixo como decidida — não pergunte de novo.

<human-request>
${answer.request || '(pergunta não registrada)'}
</human-request>

<human-response>
${answer.response}
</human-response>
`
}

// Prompt de um run que continua a sessão anterior (`claude --resume`): o modelo já
// tem todo o contexto da execução que parou na pergunta — só falta a resposta.
function buildResumePrompt(taskRelPath, answer, branch, g, autoDecide = false) {
  return `O humano respondeu à sua "## Human Request" da task ${taskRelPath}.

<human-request>
${answer.request || '(pergunta não registrada)'}
</human-request>

<human-response>
${answer.response}
</human-response>

Continue a task de onde parou, com essa decisão tomada. A seção "## Human Request"
já foi removida do arquivo da task (a pergunta e a resposta ficam registradas em
"## Histórico de Human Requests") — não a recrie, a menos que precise de uma NOVA
decisão humana.
${humanRequestInstructions(autoDecide)}
Instruções obrigatórias ao concluir:
1. Edite ${taskRelPath}, seção "## Resultado": resumo do que foi feito, decisões
   técnicas e porquês, arquivos criados/alterados, contexto para memória futura
   e pendências que exigem ação humana (cite os ids de pending-actions.md).
2. NÃO altere o frontmatter e NÃO mova o arquivo de pasta — o orquestrador faz isso.
3. Se uma ação sua for bloqueada pelos guardrails do projeto, não tente contornar:
   registre no Resultado e siga com o restante da task.
4. Se não conseguir concluir, escreva em "## Resultado" o que foi tentado,
   onde travou e o que falta.
${LEARNINGS_INSTRUCTION}${gitInstructions(branch, g)}`
}

export function buildPrompt(taskRelPath, md, branch, g, enrichMode = 'off', answer = null, autoDecide = false, context = '') {
  return `Você vai executar a task abaixo, definida no arquivo ${taskRelPath} deste projeto.
Siga a skill "claude-kanban" deste projeto para o workflow de tasks.

<task>
${md}
</task>
${context}${humanAnswerBlock(answer)}${enrichInstructions(enrichMode)}${humanRequestInstructions(autoDecide)}
Instruções obrigatórias ao concluir:
1. Edite ${taskRelPath}, seção "## Resultado": resumo do que foi feito, decisões
   técnicas e porquês, arquivos criados/alterados, contexto para memória futura
   e pendências que exigem ação humana (cite os ids de pending-actions.md).
2. NÃO altere o frontmatter e NÃO mova o arquivo de pasta — o orquestrador faz isso.
3. Se uma ação sua for bloqueada pelos guardrails do projeto, não tente contornar:
   registre no Resultado e siga com o restante da task.
4. Se não conseguir concluir, escreva em "## Resultado" o que foi tentado,
   onde travou e o que falta.
${LEARNINGS_INSTRUCTION}${gitInstructions(branch, g)}`
}
