import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { notificationsFor, pendingIds } from '../src/events.js'
import { notify, ensurePermission, loadNotifyEnabled, saveNotifyEnabled, NOTIFY_KEY } from '../src/notify.js'

const PID = 'p1'
const ctx = over => ({
  projects: [{ id: PID, name: 'claude-kanban' }],
  tasks: [{ id: 't1', title: 'Notificações do sistema' }],
  seenPendingIds: new Set(),
  ...over,
})

describe('notificationsFor — run.finished', () => {
  it('sucesso: título é o projeto, corpo é a task', () => {
    const [n] = notificationsFor({ type: 'run.finished', projectId: PID, taskId: 't1', exitCode: 0 }, ctx())
    expect(n.title).toBe('claude-kanban')
    expect(n.body).toContain('Notificações do sistema')
    expect(n.body).toContain('Concluída')
    expect(n).toMatchObject({ projectId: PID, taskId: 't1', sound: 'success' })
  })

  it('categorias de som: falha é "error", human-request e guardrail são "attention"', () => {
    const fail = notificationsFor({ type: 'run.finished', projectId: PID, taskId: 't1', exitCode: 1 }, ctx())[0]
    const hr = notificationsFor({ type: 'run.finished', projectId: PID, taskId: 't1', exitCode: 0, humanRequest: true }, ctx())[0]
    const pend = notificationsFor({
      type: 'pending.updated', projectId: PID,
      actions: [{ id: 'pa-9', label: 'git push', status: 'pending', taskId: 't1' }],
    }, ctx())[0]
    expect(fail.sound).toBe('error')
    expect(hr.sound).toBe('attention')
    expect(pend.sound).toBe('attention')
  })

  it('falha e human-request têm corpos distintos', () => {
    const fail = notificationsFor({ type: 'run.finished', projectId: PID, taskId: 't1', exitCode: 1 }, ctx())[0]
    const hr = notificationsFor({ type: 'run.finished', projectId: PID, taskId: 't1', exitCode: 0, humanRequest: true }, ctx())[0]
    expect(fail.body).toContain('Falhou')
    expect(hr.body).toContain('decisão humana')
  })

  it('task de outro projeto (não carregada) cai no id', () => {
    const [n] = notificationsFor({ type: 'run.finished', projectId: 'p2', taskId: 'zz', exitCode: 0 }, ctx())
    expect(n.title).toBe('claude-kanban')  // fallback de nome
    expect(n.body).toContain('zz')
  })
})

describe('notificationsFor — pending.updated', () => {
  const evt = {
    type: 'pending.updated',
    projectId: PID,
    actions: [
      { id: 'pa-1', label: 'git push', status: 'pending', taskId: 't1' },
      { id: 'pa-2', label: 'rm -rf', status: 'done', taskId: 't1' },
    ],
  }

  it('notifica só as pendentes ainda não vistas', () => {
    const ns = notificationsFor(evt, ctx())
    expect(ns).toHaveLength(1)
    expect(ns[0].body).toContain('git push')
    expect(ns[0].taskId).toBe('t1')
  })

  it('não repete uma ação já notificada', () => {
    expect(notificationsFor(evt, ctx({ seenPendingIds: new Set(['pa-1']) }))).toEqual([])
  })

  it('pendingIds devolve todos os ids do evento', () => {
    expect(pendingIds(evt)).toEqual(['pa-1', 'pa-2'])
  })
})

it('outros eventos não notificam', () => {
  expect(notificationsFor({ type: 'run.started', projectId: PID, taskId: 't1' }, ctx())).toEqual([])
})

describe('notify', () => {
  let ctor
  beforeEach(() => {
    ctor = vi.fn()
    class FakeNotification {
      constructor(title, opts) { ctor(title, opts); this.close = vi.fn() }
      static permission = 'granted'
      static requestPermission = vi.fn(async () => 'granted')
    }
    vi.stubGlobal('Notification', FakeNotification)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('dispara com título, corpo e tag', () => {
    const n = notify({ key: 'k', title: 'proj', body: 'task' })
    expect(ctor).toHaveBeenCalledWith('proj', { body: 'task', tag: 'k' })
    expect(n).not.toBeNull()
  })

  it('clique chama o handler', () => {
    const onClick = vi.fn()
    notify({ key: 'k', title: 'p', body: 'b' }, onClick).onclick()
    expect(onClick).toHaveBeenCalled()
  })

  it('permissão negada: no-op silencioso, sem lançar', () => {
    Notification.permission = 'denied'
    expect(notify({ key: 'k', title: 'p', body: 'b' })).toBeNull()
    expect(ctor).not.toHaveBeenCalled()
  })

  it('construtor que lança (Chrome Android) não propaga o erro', () => {
    ctor.mockImplementation(() => { throw new TypeError('Illegal constructor') })
    expect(notify({ key: 'k', title: 'p', body: 'b' })).toBeNull()
  })

  it('ensurePermission só pergunta quando o estado é default', async () => {
    Notification.permission = 'granted'
    expect(await ensurePermission()).toBe('granted')
    expect(Notification.requestPermission).not.toHaveBeenCalled()

    Notification.permission = 'default'
    expect(await ensurePermission()).toBe('granted')
    expect(Notification.requestPermission).toHaveBeenCalled()
  })

  it('preferência persiste no localStorage', () => {
    saveNotifyEnabled(true)
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('1')
    expect(loadNotifyEnabled()).toBe(true)
    saveNotifyEnabled(false)
    expect(loadNotifyEnabled()).toBe(false)
  })
})

describe('sounds — mapa de sons por categoria', async () => {
  const sounds = await import('../src/sounds.js')

  it('padrão quando não há nada salvo ou o JSON é inválido', () => {
    localStorage.removeItem(sounds.SOUND_MAP_KEY)
    expect(sounds.loadSoundMap()).toEqual(sounds.DEFAULT_MAP)
    localStorage.setItem(sounds.SOUND_MAP_KEY, 'não é json')
    expect(sounds.loadSoundMap()).toEqual(sounds.DEFAULT_MAP)
  })

  it('persiste a escolha e ignora variantes desconhecidas', () => {
    sounds.saveSoundMap({ success: 'ping', attention: 'sirene', error: 'inexistente' })
    expect(sounds.loadSoundMap()).toEqual({ success: 'ping', attention: 'sirene', error: sounds.DEFAULT_MAP.error })
    localStorage.removeItem(sounds.SOUND_MAP_KEY)
  })

  it('todas as categorias apontam para variantes existentes por padrão', () => {
    const keys = sounds.VARIANTS.map(v => v.key)
    for (const { key } of sounds.CATEGORIES) expect(keys).toContain(sounds.DEFAULT_MAP[key])
  })

  it('play/playVariant sem AudioContext no ambiente são no-op', () => {
    expect(() => sounds.playVariant('chime')).not.toThrow()
    expect(() => sounds.play('success')).not.toThrow()
    expect(() => sounds.play('inexistente')).not.toThrow()
  })
})

it('sem Notification no browser, notify é no-op', () => {
  vi.stubGlobal('Notification', undefined)
  expect(notify({ key: 'k', title: 'p', body: 'b' })).toBeNull()
  expect(loadNotifyEnabled()).toBe(false)
  vi.unstubAllGlobals()
})
