import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { loadState, saveState, diffFile, logFile } from './paths.js'
import { findTask, updateTask, appendToSection, listTasks, createTask, getSection, removeSection, replaceSection } from './tasks.js'
import { decomposeTask, subtaskLevel, MAX_DECOMPOSE_LEVEL } from './decomposer.js'
import { prepareWorkspace, cleanupWorkspace, captureDiff, capturePR, gitSettings, isGitRepo } from './git.js'
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
export const DEFAULT_RETRY = { maxAttempts: 2, backoffMinutes: 10 }

export function retrySettings(project) {
  const r = project?.retry || {}
  const maxAttempts = Number(r.maxAttempts)
  const backoffMinutes = Number(r.backoffMinutes)
  return {
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts >= 1 ? Math.round(maxAttempts) : DEFAULT_RETRY.maxAttempts,
    backoffMinutes: Number.isFinite(backoffMinutes) && backoffMinutes >= 0 ? backoffMinutes : DEFAULT_RETRY.backoffMinutes,
  }
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
export const AUTO_DECIDE_RESPONSE = `${AUTO_DECIDE_MARK} Nenhum humano foi consultado: o projeto está com auto-decisão ligada. Assuma a opção que você mesmo recomendou (na falta de recomendação explícita, a mais simples e reversível), registre a escolha e o porquê em "## Resultado" e siga em frente.`

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
  const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
  const failedToRun = !!res.error
  const output = (failedToRun ? `${out}\n${res.error.message}`.trim() : out).slice(-MAX_VERIFY_OUTPUT)
  return {
    command,
    ok: !failedToRun && res.status === 0,
    exitCode: failedToRun ? -1 : res.status,
    output: output || '(sem saída)',
  }
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
  }

  persist() {
    saveState({
      queue: this.queue,
      maxConcurrency: this.maxConcurrency,
      paused: this.paused,
      pausedUntil: this.pausedUntil,
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
    const decomposeMode = skipDecompose || rawExec ? null
      : task.decompose === true ? 'forced'
      : (task.decompose == null && project.autoDecompose) ? 'auto'
      : null
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
      workspace = prepareWorkspace(project, taskId)
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
    const model = normalizeModel(task.model) || normalizeModel(project.defaultModel) || null

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
      ? buildResumePrompt(taskRelPath, answer, workspace.branch, gitSettings(project), !!project.autoDecide)
      : buildPrompt(taskRelPath, md, workspace.branch, gitSettings(project), enrichMode, answer, !!project.autoDecide)

    // O Claude Code não auto-aprova edits em .claude/ mesmo com acceptEdits.
    // Como as tasks vivem em .claude/claude-kanban/tasks/, liberamos Edit/Write
    // desse caminho explicitamente para o modelo poder preencher o ## Resultado.
    const kanbanGlob = '.claude/claude-kanban/tasks/**'
    const allowRules = [`Edit(${kanbanGlob})`, `Write(${kanbanGlob})`]
    const allowedTools = [project.allowedTools, ...allowRules].filter(Boolean).join(' ')

    const turns = turnLimit(project)
    const args = [
      ...(resumeFrom ? ['--resume', resumeFrom] : []),
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      ...(turns ? ['--max-turns', String(turns)] : []),
      ...(model ? ['--model', model] : []),
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
      }
    })
    child.stderr.on('data', d => { a.stderr += d })

    child.on('close', code => this.finish(a, code))
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
    for (const s of res.subtasks) {
      const t = createTask(project.path, {
        title: s.title,
        description: `${s.description}\n\n_Subtask desmembrada de "${parent.title}" (${parent.id})._`,
        priority: s.priority,
        tags: ['subtask', `pai:${parent.id}`, `nivel:${level}`],
        status: 'todo',
        model: parent.model || null,
        // null = deixa o autoDecompose do projeto decidir se essa subtask ainda
        // vale quebrar; no último nível fecha a porta para não descer infinito.
        decompose: level >= MAX_DECOMPOSE_LEVEL ? false : null,
        // O modelo devolve as subtasks já ordenadas por dependência: encadeamos em
        // série para a fila respeitar essa ordem (a 3ª não roda antes da 1ª).
        depends_on: created.length ? [created[created.length - 1].id] : [],
      })
      created.push(t)
      this.emit('task.upserted', { projectId: a.projectId, task: t })
    }

    appendToSection(project.path, a.taskId, 'Resultado',
      `Task desmembrada em ${created.length} subtasks:\n${created.map(t => `- ${t.id} — ${t.title}`).join('\n')}`)
    const task = updateTask(project.path, a.taskId, {
      status: 'done',
      run: { completed_at: completedAt, exit_code: 0, cost_usd: res.costUsd },
    })
    markSucceeded(a.taskId, { completedAt })
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

  finish(a, exitCode) {
    if (!this.actives.delete(a.taskId)) return
    clearTimeout(a.timer)
    const project = this.getProject(a.projectId)
    if (!project) { try { a.logStream?.end() } catch {}; return this.tick() }

    // Gate de verificação: `exit 0` do claude não basta para virar done se o
    // projeto define um comando (testes/lint). Roda no worktree da task, antes
    // do cleanup, e o resultado vai para o log do run (visível no drawer).
    const verifyCommand = String(project.verifyCommand || '').trim()
    let verify = null
    if (exitCode === 0 && !a.killed && !a.timedOut && verifyCommand) {
      verify = runVerify(verifyCommand, a.workspace.cwd)
      const event = {
        type: 'verify',
        command: verify.command,
        ok: verify.ok,
        exitCode: verify.exitCode,
        text: verify.output,
      }
      this.recordLog(a, event)
      this.emit('run.log', { projectId: a.projectId, taskId: a.taskId, event })
    }

    try { a.logStream?.end() } catch {}

    // Captura o diff antes/depois do que a task produziu — precisa acontecer
    // antes de remover o worktree.
    let hasDiff = false
    try {
      const diff = captureDiff(a.workspace.cwd, a.workspace.startSha)
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
    const runMeta = {
      has_diff: hasDiff,
      pr,
      completed_at: new Date().toISOString(),
      exit_code: exitCode,
      session_id: r.session_id ?? null,
      cost_usd: r.total_cost_usd ?? null,
      duration_ms: r.duration_ms ?? null,
      num_turns: r.num_turns ?? null,
      exit_reason: exitReason(a, exitCode, verify),
    }

    const task = findTask(project.path, a.taskId)
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
    if (a.killed && !a.timedOut) {
      updateTask(project.path, a.taskId, { status: 'todo', run: runMeta })
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${runMeta.completed_at}] Sessão morta manualmente pelo usuário.`)
      this.emit('run.killed', { projectId: a.projectId, taskId: a.taskId })
    } else if (maxTurnsHit && !a.timedOut) {
      const patch = { status: 'todo', run: runMeta }
      if (task && !task.tags?.includes('blocked')) patch.tags = [...(task.tags || []), 'blocked']
      updateTask(project.path, a.taskId, patch)
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${runMeta.completed_at}] Teto de ${turnLimit(project)} turnos atingido — a sessão parou no meio. ` +
        `Sem nova tentativa automática (repetir gastaria o mesmo para parar no mesmo ponto). ` +
        `Quebre a task em partes menores ou aumente o limite de turnos do projeto.`)
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
      if (attempts >= maxAttempts) {
        if (task && !task.tags?.includes('blocked')) patch.tags = [...(task.tags || []), 'blocked']
      } else if (project.autoRun && backoffMinutes > 0) {
        retryAt = new Date(Date.parse(runMeta.completed_at) + backoffMinutes * 60_000).toISOString()
        patch.scheduled_at = retryAt
      }
      updateTask(project.path, a.taskId, patch)
      const verifyRetryNote = retryAt
        ? `\nNova tentativa agendada para ${retryAt} (tentativa ${attempts + 1} de ${maxAttempts}).`
        : ''
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${runMeta.completed_at}] Verificação falhou: \`${verify.command}\` (exit ${verify.exitCode}).${verifyRetryNote}\n\n\`\`\`\n${verify.output}\n\`\`\``)
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
      updateTask(project.path, a.taskId, { status: 'done', run: runMeta })
      // Registra no ledger ANTES de qualquer coisa depender do status: mesmo que
      // o done/ se perca depois, o card não roda de novo.
      markSucceeded(a.taskId, { completedAt: runMeta.completed_at, sessionId: runMeta.session_id })
      this.emit('run.finished', {
        projectId: a.projectId, taskId: a.taskId, exitCode,
        costUsd: runMeta.cost_usd, durationMs: runMeta.duration_ms,
        numTurns: runMeta.num_turns, sessionId: runMeta.session_id,
        pr: runMeta.pr,
      })
    } else {
      const reason = a.timedOut
        ? `Timeout da execução. Limite configurado: ${Math.round((a.timeoutMs || DEFAULT_TIMEOUT_MS) / 60000)} min.`
        : `${EXIT_REASON_TEXT[runMeta.exit_reason] || 'Falha'} (exit code ${exitCode ?? 'nenhum'}).`
      // O CLI reporta a maioria dos erros (API, crédito, custo) no evento result,
      // não no stderr — sem isso o log mostrava só "Exit code 1" e um bloco vazio.
      const detail = [r.result, ...(Array.isArray(r.errors) ? r.errors : [])]
        .filter(x => typeof x === 'string' && x.trim()).join('\n').slice(-2000)
      const { maxAttempts, backoffMinutes } = retrySettings(project)
      const patch = { status: 'todo', run: runMeta }
      let retryAt = null
      if (attempts >= maxAttempts) {
        if (task && !task.tags?.includes('blocked')) patch.tags = [...(task.tags || []), 'blocked']
      } else if (project.autoRun && backoffMinutes > 0) {
        // Ainda há tentativa sobrando: em vez de deixar o auto-run repescar a task
        // no mesmo tick, marca o horário do retry e deixa o Scheduler enfileirá-la
        // quando o backoff vencer (autoEnqueue ignora scheduled_at no futuro).
        retryAt = new Date(Date.parse(runMeta.completed_at) + backoffMinutes * 60_000).toISOString()
        patch.scheduled_at = retryAt
      }
      updateTask(project.path, a.taskId, patch)
      const retryNote = retryAt
        ? `\nNova tentativa agendada para ${retryAt} (tentativa ${attempts + 1} de ${maxAttempts}).`
        : ''
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
  }
}

// Por que o run terminou, gravado em run.exit_reason (null = sucesso ou pedido
// humano). Mesma precedência dos ramos de finish(); a UI traduz o código.
export function exitReason(a, exitCode, verify) {
  const r = a.result || {}
  if (a.timedOut) return 'timeout'
  if (a.killed) return 'killed'
  if (r.subtype === 'error_max_turns') return 'max_turns'
  if (exitCode === 0) return verify && !verify.ok ? 'verify_failed' : null
  if (r.subtype === 'error_max_budget_usd') return 'max_budget'
  if (r.subtype === 'error_during_execution') return 'execution_error'
  if (r.is_error) return 'api_error'
  // Sem exit code = processo morto por sinal que não veio do orquestrador (OOM, kill externo).
  return exitCode == null ? 'signal' : 'exit_code'
}

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
  if (g.autoPush) {
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
depender de uma escolha (ambiguidade de produto, trade-off técnico), decida você mesmo
pela opção que recomendaria — a mais simples e reversível — e registre em "## Resultado"
a decisão, as alternativas e o porquê. Só abra uma seção "## Human Request" se a task
for de fato impossível sem um humano (credencial, acesso, aprovação externa).
`

const humanRequestInstructions = autoDecide =>
  autoDecide ? AUTO_DECIDE_INSTRUCTIONS : HUMAN_REQUEST_INSTRUCTIONS

// Bloco com o par pergunta/resposta quando o run é uma retomada sem sessão (ou um
// fallback de resume que falhou): as seções já saíram do corpo da task, então o
// contexto precisa vir pelo prompt.
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
   onde travou e o que falta.${gitInstructions(branch, g)}`
}

function buildPrompt(taskRelPath, md, branch, g, enrichMode = 'off', answer = null, autoDecide = false) {
  return `Você vai executar a task abaixo, definida no arquivo ${taskRelPath} deste projeto.
Siga a skill "claude-kanban" deste projeto para o workflow de tasks.

<task>
${md}
</task>
${humanAnswerBlock(answer)}${enrichInstructions(enrichMode)}${humanRequestInstructions(autoDecide)}
Instruções obrigatórias ao concluir:
1. Edite ${taskRelPath}, seção "## Resultado": resumo do que foi feito, decisões
   técnicas e porquês, arquivos criados/alterados, contexto para memória futura
   e pendências que exigem ação humana (cite os ids de pending-actions.md).
2. NÃO altere o frontmatter e NÃO mova o arquivo de pasta — o orquestrador faz isso.
3. Se uma ação sua for bloqueada pelos guardrails do projeto, não tente contornar:
   registre no Resultado e siga com o restante da task.
4. Se não conseguir concluir, escreva em "## Resultado" o que foi tentado,
   onde travou e o que falta.${gitInstructions(branch, g)}`
}
