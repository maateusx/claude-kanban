// Mini-renderizador de markdown → elementos React. Cobre o que uma
// "## Human Request" costuma trazer: títulos, parágrafos, listas (- * 1.),
// **negrito**, *itálico*, `código`, blocos ``` e [links](url). Monta nós
// React em vez de innerHTML, então texto vindo do agente nunca vira HTML.
// ponytail: sem tabelas, citações nem listas aninhadas — trocar por
// react-markdown se aparecer necessidade.
import React from 'react'

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g

function inline(text) {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null
    if (part.startsWith('`')) return <code key={i} className="rounded bg-chip px-1 font-mono text-[0.92em] text-chip-ink">{part.slice(1, -1)}</code>
    if (part.startsWith('**')) return <strong key={i} className="font-semibold text-ink">{part.slice(2, -2)}</strong>
    if (part.startsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>
    if (part.startsWith('[')) {
      const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
      const safe = /^(https?:|mailto:|\/|#)/i.test(m[2])
      return safe
        ? <a key={i} href={m[2]} target="_blank" rel="noreferrer" className="text-accent underline">{m[1]}</a>
        : m[1]
    }
    return part
  })
}

export default function Markdown({ text, className = '' }) {
  const lines = String(text || '').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (line.startsWith('```')) {
      const buf = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) buf.push(lines[i])
      i++
      out.push(<pre key={out.length} className="overflow-x-auto rounded-[6px] bg-subtle p-2 font-mono text-meta">{buf.join('\n')}</pre>)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { out.push(<div key={out.length} className="mt-2 font-semibold text-ink">{inline(h[2])}</div>); i++; continue }
    const li = /^\s*([-*]|\d+[.)])\s+/.exec(line)
    if (li) {
      const ordered = /\d/.test(li[1])
      const items = []
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/
      // Linha seguinte indentada (sem marcador) continua o item anterior.
      while (i < lines.length && (re.test(lines[i]) || (items.length && /^\s+\S/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ''))
        else items[items.length - 1] += ' ' + lines[i].trim()
        i++
      }
      const Tag = ordered ? 'ol' : 'ul'
      out.push(<Tag key={out.length} className={`ml-5 space-y-0.5 ${ordered ? 'list-decimal' : 'list-disc'}`}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</Tag>)
      continue
    }
    const buf = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i].trim()), i++
    out.push(<p key={out.length}>{inline(buf.join(' '))}</p>)
  }
  return <div className={`space-y-1.5 text-body text-ink-2 ${className}`}>{out}</div>
}
