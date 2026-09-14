import React from 'react'
import { render, screen } from '@testing-library/react'
import Markdown from '../src/Markdown.jsx'

const SAMPLE = `### Pergunta
Qual **fonte** usar para o \`token\`?

1. Usar a env atual
2. Pedir ao humano

- opção a
- opção b <script>alert(1)</script>

Ver [docs](https://example.com) e [ruim](javascript:alert(1)).`

test('renderiza headings, listas, negrito, código e links de forma segura', () => {
  const { container } = render(<Markdown text={SAMPLE} />)
  expect(container.querySelector('strong').textContent).toBe('fonte')
  expect(container.querySelector('code').textContent).toBe('token')
  expect(container.querySelectorAll('ol li')).toHaveLength(2)
  expect(container.querySelectorAll('ul li')).toHaveLength(2)
  expect(container.querySelector('script')).toBeNull()
  expect(screen.getByText(/<script>/)).toBeTruthy()
  const links = container.querySelectorAll('a')
  expect(links).toHaveLength(1)
  expect(links[0].getAttribute('href')).toBe('https://example.com')
  expect(container.textContent).toContain('ruim')
  expect(screen.getByText('Pergunta')).toBeTruthy()
})
