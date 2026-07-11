import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'

// Gerência dos processos de "dev server" por projeto. Cada projeto pode ter um
// comando (ex: `npm run dev`) e uma URL. O botão do header inicia o processo (se
// ainda não estiver rodando) e abre a URL no Chrome.
export class DevServers {
  constructor(emit) {
    this.emit = emit
    this.running = new Map() // projectId -> { child, command, startedAt, logs: [] }
  }

  isRunning(projectId) {
    return this.running.has(projectId)
  }

  status(projectId) {
    const s = this.running.get(projectId)
    return {
      running: !!s,
      pid: s?.child.pid ?? null,
      startedAt: s?.startedAt ?? null,
    }
  }

  start(project) {
    const command = project.devServer?.command?.trim()
    if (!command) throw new Error('nenhum comando de dev server configurado para este projeto')
    if (this.running.has(project.id)) return this.status(project.id)
    if (!fs.existsSync(project.path)) throw new Error('diretório do projeto indisponível')

    // detached: true coloca o shell e todos os seus filhos (vite, next dev, ...)
    // em um process group próprio, o que permite matar a árvore inteira em stop().
    const child = spawn(command, {
      cwd: project.path,
      shell: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    const s = { child, command, startedAt: new Date().toISOString(), logs: [] }
    const push = chunk => {
      s.logs.push(String(chunk))
      if (s.logs.length > 500) s.logs.splice(0, s.logs.length - 500)
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)

    child.on('close', code => {
      this.running.delete(project.id)
      this.emit('devserver.updated', { projectId: project.id, ...this.status(project.id), exitCode: code })
    })
    child.on('error', err => {
      s.logs.push(`spawn error: ${err.message}`)
    })

    this.running.set(project.id, s)
    this.emit('devserver.updated', { projectId: project.id, ...this.status(project.id) })
    return this.status(project.id)
  }

  // Mata o process group inteiro (shell + dev server real). No Windows não há
  // process group POSIX, então usamos taskkill com /T para a árvore.
  #signal(child, signal) {
    if (!child.pid) return
    if (process.platform === 'win32') {
      if (signal === 'SIGKILL') {
        try { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}) } catch {}
      } else {
        try { child.kill(signal) } catch {}
      }
      return
    }
    try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} }
  }

  stop(projectId) {
    const s = this.running.get(projectId)
    if (!s) return false
    this.#signal(s.child, 'SIGTERM')
    setTimeout(() => {
      // só escala para SIGKILL se o processo ainda estiver vivo (o handler de
      // 'close' remove a entrada de this.running).
      if (this.running.get(projectId) !== s) return
      this.#signal(s.child, 'SIGKILL')
    }, 8000).unref?.()
    return true
  }

  logs(projectId) {
    return (this.running.get(projectId)?.logs || []).join('')
  }

  // Abre a URL no Google Chrome. macOS usa `open -a`; demais plataformas tentam
  // o binário do Chrome direto.
  openInChrome(url) {
    if (!url) throw new Error('nenhuma URL de dev server configurada para este projeto')
    let cmd, args
    if (process.platform === 'darwin') {
      cmd = 'open'; args = ['-a', 'Google Chrome', url]
    } else if (process.platform === 'win32') {
      cmd = 'cmd'; args = ['/c', 'start', 'chrome', url]
    } else {
      cmd = 'google-chrome'; args = [url]
    }
    return new Promise((resolve, reject) => {
      execFile(cmd, args, err => err ? reject(err) : resolve())
    })
  }

  // Inicia o dev server (se necessário) e abre a URL no Chrome após um pequeno
  // delay para dar tempo do servidor subir.
  async launch(project) {
    const wasRunning = this.running.has(project.id)
    if (!wasRunning) this.start(project)
    const url = project.devServer?.url?.trim()
    if (url) {
      const delay = wasRunning ? 0 : (project.devServer?.startDelayMs ?? 2500)
      if (delay) await new Promise(r => setTimeout(r, delay))
      await this.openInChrome(url)
    }
    return { ...this.status(project.id), opened: !!url }
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id)
  }

  // Usado no cleanup síncrono do processo (handler de 'exit'), onde timers não
  // chegam a rodar: mata os grupos imediatamente com SIGKILL.
  killAll() {
    for (const s of this.running.values()) this.#signal(s.child, 'SIGKILL')
    this.running.clear()
  }
}
