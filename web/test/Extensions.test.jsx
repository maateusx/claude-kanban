import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../src/api.js', () => ({
  api: { extensions: vi.fn(), installExtension: vi.fn(), toggleExtension: vi.fn(), removeExtension: vi.fn(), plugins: vi.fn(), pluginAction: vi.fn() },
}))

const { api } = await import('../src/api.js')
const { ExtensionsDrawer } = await import('../src/Extensions.jsx')

const PROJECT = { id: 'p1', name: 'Proj' }
const payload = (skills = [], overrides = {}) => ({
  scope: 'global', root: '/home/u/.claude',
  items: { skills, agents: [], commands: [], hooks: [] },
  catalog: [
    { id: 'skill:commits-convencionais', kind: 'skills', name: 'commits-convencionais', title: 'Commits convencionais', description: 'padroniza commits', signature: null },
    { id: 'hook:x', kind: 'hooks', name: 'x', title: 'Hook X', description: 'faz algo', signature: 'Stop:abc123' },
  ],
  ...overrides,
})
const SKILL = { kind: 'skills', name: 'minha-skill', title: 'minha-skill', description: 'faz algo', enabled: true }

beforeEach(() => {
  vi.clearAllMocks()
  api.extensions.mockResolvedValue(payload([SKILL]))
})

describe('ExtensionsDrawer', () => {
  it('lista o que está instalado e o catálogo do tipo selecionado', async () => {
    render(<ExtensionsDrawer project={PROJECT} onClose={() => {}} />)
    await screen.findByText('minha-skill')
    expect(api.extensions).toHaveBeenCalledWith(null) // abre no escopo global
    expect(screen.getByText('Commits convencionais')).toBeTruthy()
    expect(screen.getByText('ativo')).toBeTruthy()
  })

  it('trocar para o escopo do projeto recarrega com o projectId', async () => {
    render(<ExtensionsDrawer project={PROJECT} onClose={() => {}} />)
    await screen.findByText('minha-skill')
    await userEvent.click(screen.getByText('Projeto · Proj'))
    await waitFor(() => expect(api.extensions).toHaveBeenCalledWith('p1'))
  })

  it('desativar manda o toggle e reflete a resposta', async () => {
    api.toggleExtension.mockResolvedValue(payload([{ ...SKILL, enabled: false }]))
    render(<ExtensionsDrawer project={PROJECT} onClose={() => {}} />)
    await screen.findByText('minha-skill')
    await userEvent.click(screen.getByRole('button', { name: 'desativar' }))
    expect(api.toggleExtension).toHaveBeenCalledWith(null, 'skills', 'minha-skill', false)
    await screen.findByText('desativado')
    expect(screen.getByRole('button', { name: 'ativar' })).toBeTruthy()
  })

  it('instalar um item do catálogo usa o escopo atual', async () => {
    api.installExtension.mockResolvedValue(payload([SKILL, { ...SKILL, name: 'commits-convencionais', title: 'commits-convencionais' }]))
    render(<ExtensionsDrawer project={PROJECT} onClose={() => {}} />)
    await screen.findByText('Commits convencionais')
    await userEvent.click(screen.getByRole('button', { name: 'instalar' }))
    expect(api.installExtension).toHaveBeenCalledWith(null, 'skill:commits-convencionais')
    // sai do catálogo depois de instalado
    await waitFor(() => expect(screen.queryByText('Commits convencionais')).toBeNull())
  })

  it('hook já presente no settings.json não reaparece no catálogo', async () => {
    api.extensions.mockResolvedValue(payload([], {
      items: { skills: [], agents: [], commands: [], hooks: [{ kind: 'hooks', name: 'Stop:abc123', title: 'Stop', description: 'cmd', enabled: true }] },
    }))
    render(<ExtensionsDrawer project={PROJECT} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Hooks/ }))
    await screen.findByText('Stop')
    expect(screen.queryByText('Hook X')).toBeNull()
  })

  it('a aba Plugins lista instalados, esconde-os do marketplace e instala pelo CLI', async () => {
    api.plugins.mockResolvedValue({
      installed: [{ id: 'ja-tenho@mk', name: 'ja-tenho', version: '1.0.0', scope: 'user', enabled: true }],
      available: [
        { id: 'ja-tenho@mk', name: 'ja-tenho', description: 'duplicado', marketplace: 'mk' },
        { id: 'novo@mk', name: 'novo', description: 'plugin novo', marketplace: 'mk' },
      ],
    })
    api.pluginAction.mockResolvedValue({ ok: true })
    render(<ExtensionsDrawer project={PROJECT} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Plugins/ }))
    await screen.findByText('ja-tenho@mk')
    expect(screen.getByText('v1.0.0 · escopo user')).toBeTruthy()
    // o que já está instalado não reaparece no marketplace
    expect(screen.queryByText('ja-tenho')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /instalar global/ }))
    expect(api.pluginAction).toHaveBeenCalledWith(null, 'install', 'novo@mk')
  })

  it('erro do CLI de plugins aparece com opção de tentar de novo', async () => {
    api.plugins.mockRejectedValue(new Error('CLI do Claude Code não encontrado no PATH'))
    render(<ExtensionsDrawer project={PROJECT} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Plugins/ }))
    await screen.findByText(/não encontrado no PATH/)
    expect(screen.getByRole('button', { name: 'tentar de novo' })).toBeTruthy()
  })

  it('erro do servidor aparece na tela', async () => {
    api.toggleExtension.mockRejectedValue(new Error('item não encontrado'))
    render(<ExtensionsDrawer project={PROJECT} onClose={() => {}} />)
    await screen.findByText('minha-skill')
    await userEvent.click(screen.getByRole('button', { name: 'desativar' }))
    await screen.findByText('item não encontrado')
  })
})
