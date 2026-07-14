// Notificações do sistema (Notification API). Tudo aqui é defensivo: navegador
// sem suporte, permissão negada ou storage indisponível nunca podem quebrar o
// board — as funções apenas viram no-op.

export const NOTIFY_KEY = 'ck.notifications'

export function supported() {
  return typeof window !== 'undefined' && typeof window.Notification === 'function'
}

export function loadNotifyEnabled() {
  if (!supported()) return false
  try { return localStorage.getItem(NOTIFY_KEY) === '1' } catch { return false }
}

export function saveNotifyEnabled(v) {
  try { localStorage.setItem(NOTIFY_KEY, v ? '1' : '0') } catch { /* storage indisponível */ }
}

export function permission() {
  return supported() ? Notification.permission : 'denied'
}

// Pede permissão no primeiro "liga o toggle". Resolve com o estado final; nunca
// rejeita (Safari antigo devolve callback em vez de Promise).
export async function ensurePermission() {
  if (!supported()) return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

// Dispara a notificação. onClick foca a aba — o App usa para abrir o drawer.
export function notify({ key, title, body }, onClick) {
  if (!supported() || Notification.permission !== 'granted') return null
  try {
    const n = new Notification(title, { body, tag: key })
    n.onclick = () => {
      try { window.focus() } catch { /* pop-up bloqueado */ }
      n.close()
      onClick?.()
    }
    return n
  } catch {
    // Chrome no Android lança TypeError para `new Notification` (só via SW).
    return null
  }
}
