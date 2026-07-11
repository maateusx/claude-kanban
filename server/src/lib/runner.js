import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { loadState, saveState, diffFile, logFile } from './paths.js'
import { findTask, updateTask, appendToSection, listTasks } from './tasks.js'
import { prepareWorkspace, cleanupWorkspace, captureDiff, gitSettings, isGitRepo } from './git.js'
import { wasSucceeded, markSucceeded, clearExecuted } from './ledger.js'
import { PRIORITY_RANK } from './sort.js'
import { normalizeModel } from './models.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_CONCURRENCY = 8

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
    this.actives = new Map()        // taskId -> { projectId, taskId, child, timer, ... }
  }

  persist() { saveState({ queue: this.queue, maxConcurrency: this.maxConcurrency }) }

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

  eligible(projectId) {
    const project = this.getProject(projectId)
    if (!project) return true // start() descarta e segue
    const busy = [...this.actives.values()].some(a => a.projectId === projectId)
    return !busy || this.canRunConcurrently(project)
  }

  tick() {
    while (this.actives.size < this.maxConcurrency && this.queue.length > 0) {
      const idx = this.queue.findIndex(q => this.eligible(q.projectId))
      if (idx === -1) return
      const [next] = this.queue.splice(idx, 1)
      this.persist()
      this.start(next.projectId, next.taskId)
    }
  }

  start(projectId, taskId) {
    const project = this.getProject(projectId)
    if (!project) return
    let task = findTask(project.path, taskId)
    if (!task) return

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

    task = updateTask(project.path, taskId, {
      status: 'doing',
      run: {
        started_at: new Date().toISOString(),
        attempts: (task.run?.attempts || 0) + 1,
        ...(workspace.branch ? { branch: workspace.branch } : {}),
        ...(model ? { model } : {}),
      },
    })

    const taskRelPath = path.relative(project.path, task.filePath)
    const md = fs.readFileSync(task.filePath, 'utf8')
    const prompt = buildPrompt(taskRelPath, md, workspace.branch, gitSettings(project))

    // O Claude Code não auto-aprova edits em .claude/ mesmo com acceptEdits.
    // Como as tasks vivem em .claude/claude-kanban/tasks/, liberamos Edit/Write
    // desse caminho explicitamente para o modelo poder preencher o ## Resultado.
    const kanbanGlob = '.claude/claude-kanban/tasks/**'
    const allowRules = [`Edit(${kanbanGlob})`, `Write(${kanbanGlob})`]
    const allowedTools = [project.allowedTools, ...allowRules].filter(Boolean).join(' ')

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      ...(model ? ['--model', model] : []),
      ...(project.skipPermissions
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
      logStream: null, logBytes: 0, logEvents: [],
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
    this.emit('run.started', { projectId, taskId, pid: child.pid })

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
    try { a.logStream?.end() } catch {}
    const project = this.getProject(a.projectId)
    if (!project) return this.tick()

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

    // Traz o resultado escrito no worktree de volta ao projeto e remove o worktree
    // (a branch da task é preservada) — precisa acontecer antes dos updateTask abaixo.
    try { cleanupWorkspace(project, a.workspace, a.taskRelPath) } catch {}

    const r = a.result || {}
    const runMeta = {
      has_diff: hasDiff,
      completed_at: new Date().toISOString(),
      exit_code: exitCode,
      session_id: r.session_id ?? null,
      cost_usd: r.total_cost_usd ?? null,
      duration_ms: r.duration_ms ?? null,
      num_turns: r.num_turns ?? null,
    }

    const task = findTask(project.path, a.taskId)
    const attempts = task?.run?.attempts || 0

    if (a.killed && !a.timedOut) {
      updateTask(project.path, a.taskId, { status: 'todo', run: runMeta })
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${runMeta.completed_at}] Sessão morta manualmente pelo usuário.`)
      this.emit('run.killed', { projectId: a.projectId, taskId: a.taskId })
    } else if (exitCode === 0 && !a.timedOut) {
      updateTask(project.path, a.taskId, { status: 'done', run: runMeta })
      // Registra no ledger ANTES de qualquer coisa depender do status: mesmo que
      // o done/ se perca depois, o card não roda de novo.
      markSucceeded(a.taskId, { completedAt: runMeta.completed_at, sessionId: runMeta.session_id })
      this.emit('run.finished', {
        projectId: a.projectId, taskId: a.taskId, exitCode,
        costUsd: runMeta.cost_usd, durationMs: runMeta.duration_ms,
        numTurns: runMeta.num_turns, sessionId: runMeta.session_id,
      })
    } else {
      const reason = a.timedOut
        ? `Timeout da execução. Limite configurado: ${Math.round((a.timeoutMs || DEFAULT_TIMEOUT_MS) / 60000)} min.`
        : `Exit code ${exitCode}.`
      const patch = { status: 'todo', run: runMeta }
      if (attempts >= 3 && task && !task.tags?.includes('blocked')) {
        patch.tags = [...(task.tags || []), 'blocked']
      }
      updateTask(project.path, a.taskId, patch)
      appendToSection(project.path, a.taskId, 'Log de erros',
        `[${runMeta.completed_at}] ${reason}\n\n\`\`\`\n${(a.stderr || '').slice(-2000)}\n\`\`\``)
      this.emit('run.finished', {
        projectId: a.projectId, taskId: a.taskId, exitCode,
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

function buildPrompt(taskRelPath, md, branch, g) {
  return `Você vai executar a task abaixo, definida no arquivo ${taskRelPath} deste projeto.
Siga a skill "claude-kanban" deste projeto para o workflow de tasks.

<task>
${md}
</task>

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
