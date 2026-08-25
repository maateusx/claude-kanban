// Sons de alerta via Web Audio (sem arquivos de áudio). Como em notify.js, tudo
// é defensivo: browser sem AudioContext, autoplay bloqueado ou storage
// indisponível viram no-op — som nunca pode quebrar o board.
//
// Três categorias de evento (sucesso, ação manual, erro), cada uma com um som
// escolhível da biblioteca abaixo. A escolha persiste em localStorage.

export const SOUND_KEY = 'ck.sounds'
export const SOUND_MAP_KEY = 'ck.sounds.map'

// Só as chaves: label e hint saem de i18n (`sound.category.<key>[.hint]`).
export const CATEGORIES = [
  { key: 'success' },
  { key: 'attention' },
  { key: 'error' },
]

// Cada som é uma sequência de notas [freq Hz, início s, duração s].
const LIBRARY = {
  chime: { type: 'sine', vol: 0.06, notes: [[880, 0, 0.12], [1320, 0.13, 0.18]] },
  ping: { type: 'sine', vol: 0.07, notes: [[1568, 0, 0.25]] },
  blip: { type: 'square', vol: 0.03, notes: [[660, 0, 0.06], [990, 0.08, 0.1]] },
  triplo: { type: 'sine', vol: 0.08, notes: [[587, 0, 0.14], [587, 0.22, 0.14], [466, 0.44, 0.22]] },
  batida: { type: 'triangle', vol: 0.12, notes: [[330, 0, 0.1], [330, 0.16, 0.14]] },
  sirene: { type: 'sine', vol: 0.08, notes: [[622, 0, 0.12], [466, 0.14, 0.12], [622, 0.28, 0.12], [466, 0.42, 0.2]] },
  grave: { type: 'sawtooth', vol: 0.04, notes: [[196, 0, 0.25], [147, 0.28, 0.35]] },
  none: { notes: [] },
}

// O label de cada variante sai de i18n (`sound.variant.<key>`).
export const VARIANTS = Object.keys(LIBRARY).map(key => ({ key }))

export const DEFAULT_MAP = { success: 'chime', attention: 'triplo', error: 'grave' }

export function supported() {
  return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext)
}

// Ligado por padrão: diferente das notificações, não exige permissão do browser.
export function loadSoundEnabled() {
  if (!supported()) return false
  try { return localStorage.getItem(SOUND_KEY) !== '0' } catch { return true }
}

export function saveSoundEnabled(v) {
  try { localStorage.setItem(SOUND_KEY, v ? '1' : '0') } catch { /* storage indisponível */ }
}

export function loadSoundMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(SOUND_MAP_KEY) || '{}')
    const map = { ...DEFAULT_MAP }
    for (const { key } of CATEGORIES) if (LIBRARY[raw[key]]) map[key] = raw[key]
    return map
  } catch {
    return { ...DEFAULT_MAP }
  }
}

export function saveSoundMap(map) {
  try { localStorage.setItem(SOUND_MAP_KEY, JSON.stringify(map)) } catch { /* storage indisponível */ }
}

let ctx = null
function audioCtx() {
  if (!supported()) return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!ctx) ctx = new AC()
  // Autoplay policy: o contexto nasce suspenso até o primeiro gesto do usuário.
  // resume() é assíncrono — se ainda estiver suspenso este som se perde, mas os
  // próximos tocam.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

function tone(c, type, start, freq, dur, vol) {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  // Envelope com rampa para não estalar no início/fim.
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(vol, start + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(gain).connect(c.destination)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

// Toca um som da biblioteca pelo nome ('chime', 'triplo'...).
export function playVariant(name) {
  const spec = LIBRARY[name]
  if (!spec || !spec.notes.length) return
  try {
    const c = audioCtx()
    if (!c) return
    const t = c.currentTime
    for (const [freq, at, dur] of spec.notes) tone(c, spec.type, t + at, freq, dur, spec.vol)
  } catch { /* Web Audio indisponível ou bloqueado */ }
}

// Toca o som configurado para uma categoria ('success' | 'attention' | 'error').
export function play(category, map) {
  if (!category) return
  playVariant((map || loadSoundMap())[category])
}
