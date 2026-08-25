import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../src/api.js', () => ({
  api: {
    searchSources: vi.fn(), addSearchSource: vi.fn(),
    patchSearchSource: vi.fn(), removeSearchSource: vi.fn(),
    fetchSearchSource: vi.fn(), fetchAllSearchSources: vi.fn(), importSearchItems: vi.fn(),
  },
}))

const { api } = await import('../src/api.js')
const { SearchSourcesModal, SearchTasksModal } = await import('../src/SearchSources.jsx')

const PROJECT = { id: 'p1', name: 'Proj' }
const SOURCE = {
  id: 's1', name: 'HN', method: 'GET', url: 'https://hn.example/api',
  headers: [], queryParams: [], body: '', bodyType: 'json', enabled: true,
  resultsPath: 'hits', titleField: 'title', descriptionField: '',
}
const list = (...s) => ({ searchSources: s })

beforeEach(() => {
  vi.clearAllMocks()
  api.searchSources.mockResolvedValue(list(SOURCE))
})

describe('SearchSourcesModal', () => {
  it('lista as fontes cadastradas', async () => {
    render(<SearchSourcesModal project={PROJECT} onClose={() => {}} />)
    await screen.findByText('HN')
    expect(api.searchSources).toHaveBeenCalledWith('p1')
    expect(screen.getByText('https://hn.example/api')).toBeTruthy()
    expect(screen.getByText('GET')).toBeTruthy()
  })

  it('cria uma fonte com method, header e body', async () => {
    api.addSearchSource.mockResolvedValue({ source: SOURCE })
    render(<SearchSourcesModal project={PROJECT} onClose={() => {}} />)
    await screen.findByText('HN')

    await userEvent.click(screen.getByRole('button', { name: 'Nova fonte +' }))
    await userEvent.type(screen.getByLabelText('Nome'), 'Jobs')
    await userEvent.type(screen.getByLabelText('URL'), 'https://api.example/jobs')
    await userEvent.selectOptions(screen.getByLabelText('Método'), 'POST')

    await userEvent.click(screen.getByRole('button', { name: 'adicionar Headers' }))
    await userEvent.type(screen.getByLabelText('Headers chave 1'), 'authorization')
    await userEvent.type(screen.getByLabelText('Headers valor 1'), 'Bearer x')

    // body só aparece quando o método manda corpo
    await userEvent.type(screen.getByLabelText('Body'), '{{"q":"react"}')
    await userEvent.selectOptions(screen.getByLabelText('Tipo do body'), 'text')
    await userEvent.type(screen.getByLabelText('Caminho dos resultados'), 'data.items')

    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(api.addSearchSource).toHaveBeenCalled())
    expect(api.addSearchSource.mock.calls[0][0]).toBe('p1')
    expect(api.addSearchSource.mock.calls[0][1]).toMatchObject({
      name: 'Jobs', method: 'POST', url: 'https://api.example/jobs',
      headers: [{ key: 'authorization', value: 'Bearer x' }],
      queryParams: [], body: '{"q":"react"}', bodyType: 'text',
      resultsPath: 'data.items', enabled: true,
    })
    expect(api.searchSources).toHaveBeenCalledTimes(2) // recarrega depois de salvar
  })

  it('edita uma fonte existente', async () => {
    api.patchSearchSource.mockResolvedValue({ source: SOURCE })
    render(<SearchSourcesModal project={PROJECT} onClose={() => {}} />)
    await screen.findByText('HN')

    await userEvent.click(screen.getByRole('button', { name: 'editar' }))
    const name = screen.getByLabelText('Nome')
    await userEvent.clear(name)
    await userEvent.type(name, 'Hacker News')
    await userEvent.click(screen.getByLabelText('Ativa'))
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))

    await waitFor(() => expect(api.patchSearchSource).toHaveBeenCalled())
    const [pid, sid, patch] = api.patchSearchSource.mock.calls[0]
    expect([pid, sid]).toEqual(['p1', 's1'])
    expect(patch).toMatchObject({ name: 'Hacker News', enabled: false, url: SOURCE.url })
  })

  it('o toggle da lista manda só o enabled', async () => {
    api.patchSearchSource.mockResolvedValue({ source: SOURCE })
    render(<SearchSourcesModal project={PROJECT} onClose={() => {}} />)
    await screen.findByText('HN')
    await userEvent.click(screen.getByRole('button', { name: 'desativar' }))
    expect(api.patchSearchSource).toHaveBeenCalledWith('p1', 's1', { enabled: false })
  })

  it('remove só depois de confirmar', async () => {
    api.removeSearchSource.mockResolvedValue({ ok: true })
    render(<SearchSourcesModal project={PROJECT} onClose={() => {}} />)
    await screen.findByText('HN')

    await userEvent.click(screen.getByRole('button', { name: 'remover' }))
    expect(api.removeSearchSource).not.toHaveBeenCalled()

    api.searchSources.mockResolvedValue(list())
    await userEvent.click(screen.getByRole('button', { name: 'confirmar' }))
    expect(api.removeSearchSource).toHaveBeenCalledWith('p1', 's1')
    await screen.findByText('Nenhuma fonte cadastrada.')
  })

  it('erro do servidor aparece na tela e mantém o form aberto', async () => {
    api.addSearchSource.mockRejectedValue(new Error('url deve ser uma URL http(s) válida'))
    render(<SearchSourcesModal project={PROJECT} onClose={() => {}} />)
    await screen.findByText('HN')
    await userEvent.click(screen.getByRole('button', { name: 'Nova fonte +' }))
    await userEvent.type(screen.getByLabelText('Nome'), 'X')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await screen.findByText('url deve ser uma URL http(s) válida')
    expect(screen.getByLabelText('Nome')).toBeTruthy()
  })
})

// Fluxo de aceite da task: buscar → ver resultados → importar → buscar de novo e
// confirmar que o item já importado vem desabilitado (dedupe por tag).
describe('SearchTasksModal', () => {
  const ITEM = {
    sourceId: 's1', sourceName: 'HN', title: 'Bug no login',
    description: 'estoura 500', url: 'https://hn.example/1',
    tag: 'search:s1:abc123', already_imported: false,
  }

  it('busca em todas as fontes, importa e não duplica na busca seguinte', async () => {
    const user = userEvent.setup()
    api.fetchAllSearchSources.mockResolvedValueOnce({ items: [ITEM], errors: [] })
    api.importSearchItems.mockResolvedValue({ created: [{ id: 't1' }], skipped: [] })
    const onImported = vi.fn()
    render(<SearchTasksModal project={PROJECT} onClose={() => {}} onImported={onImported} />)

    await user.click(await screen.findByRole('button', { name: 'Buscar' }))
    await screen.findByText('Bug no login')
    expect(api.fetchAllSearchSources).toHaveBeenCalledWith('p1')

    const box = screen.getByRole('checkbox')
    expect(box.checked).toBe(true)   // não importado vem pré-selecionado
    await user.click(screen.getByRole('button', { name: 'Importar 1 no Backlog' }))

    await screen.findByText(/1 task\(s\) criada\(s\)/)
    expect(api.importSearchItems).toHaveBeenCalledWith('p1', [{
      sourceId: 's1', sourceName: 'HN', title: 'Bug no login',
      description: 'estoura 500', url: 'https://hn.example/1',
    }])
    expect(onImported).toHaveBeenCalled()
    // Marcado localmente logo após o import, sem refazer a busca.
    expect(screen.getByRole('checkbox').disabled).toBe(true)

    // Buscar de novo: o server devolve already_imported e o item fica travado.
    api.fetchAllSearchSources.mockResolvedValueOnce({ items: [{ ...ITEM, already_imported: true }], errors: [] })
    await user.click(screen.getByRole('button', { name: 'Buscar' }))
    await screen.findByText('já existe')
    expect(screen.getByRole('checkbox').disabled).toBe(true)
    expect(screen.getByRole('button', { name: /Importar 0/ }).disabled).toBe(true)
  })

  it('busca em uma fonte específica e mostra erro por fonte', async () => {
    const user = userEvent.setup()
    api.fetchSearchSource.mockResolvedValue({ items: [] })
    render(<SearchTasksModal project={PROJECT} onClose={() => {}} />)

    await user.selectOptions(await screen.findByLabelText('Buscar em'), 's1')
    await user.click(screen.getByRole('button', { name: 'Buscar' }))
    await waitFor(() => expect(api.fetchSearchSource).toHaveBeenCalledWith('p1', 's1'))
    await screen.findByText('Nenhum resultado.')
  })
})
