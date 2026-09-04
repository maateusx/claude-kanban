// Catálogo embutido de extensões prontas (skills, agents e hooks) que a tela de
// Extensões oferece para instalar com um clique, global ou por projeto.
//
// Plugins NÃO ficam aqui: o catálogo real vem dos marketplaces do próprio Claude
// Code (`claude plugin list --available`), em lib/plugins.js.
//
// Formato: `files` grava arquivos relativos à raiz do escopo (~/.claude ou
// <projeto>/.claude); `hook` insere uma entrada em settings.json.

const skill = (name, title, description, body) => ({
  id: `skill:${name}`, kind: 'skills', name, title, description,
  files: [{ rel: `skills/${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}` }],
})

const agent = (name, title, description, tools, body) => ({
  id: `agent:${name}`, kind: 'agents', name, title, description,
  files: [{ rel: `agents/${name}.md`, content: `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\n\n${body}` }],
})

// O hook recebe o JSON do evento no stdin; usamos node (sempre disponível, é o
// runtime do próprio kanban) em vez de jq/python para não depender de extras.
const PRETTIER_CMD = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const f=JSON.parse(s).tool_input&&JSON.parse(s).tool_input.file_path;if(f)require('child_process').execFileSync('npx',['--no-install','prettier','--write',f],{stdio:'ignore'})}catch{}})"`

export const CATALOG = [
  skill('commits-convencionais', 'Commits convencionais',
    'Padroniza mensagens de commit no formato Conventional Commits (feat/fix/chore…).',
    `# Commits convencionais

Toda mensagem de commit segue \`tipo(escopo): resumo no imperativo\`.

Tipos: \`feat\`, \`fix\`, \`refactor\`, \`docs\`, \`test\`, \`chore\`, \`perf\`, \`build\`.

Regras:
- resumo em minúsculas, sem ponto final, até 72 caracteres;
- corpo (opcional) explica o **porquê**, não o que o diff já mostra;
- breaking change vira \`tipo!: resumo\` + rodapé \`BREAKING CHANGE: ...\`;
- um commit por mudança coerente — não misture refactor com feature.
`),

  skill('revisao-de-pr', 'Checklist de revisão de PR',
    'Checklist objetivo para revisar um diff antes de abrir ou aprovar um PR.',
    `# Revisão de PR

Antes de abrir/aprovar, confira nesta ordem e relate só o que falhou:

1. **Escopo** — o diff faz só o que o título promete? Arquivo fora do escopo é red flag.
2. **Correção** — casos de borda: nulo/vazio, erro de rede, concorrência, fuso horário.
3. **Testes** — existe teste que falha sem a mudança? Se não, aponte qual falta.
4. **Segurança** — entrada validada na fronteira, segredo fora do código, path traversal.
5. **Ruído** — código morto, console.log, TODO sem dono, dependência nova sem motivo.

Formato da resposta: uma linha por achado, \`arquivo:linha — problema — sugestão\`.
Sem achados, diga "sem bloqueios" e pare.
`),

  skill('testes-primeiro', 'Teste antes do fix',
    'Para bugs: escreve primeiro o teste que reproduz a falha, só depois corrige.',
    `# Teste antes do fix

Ao corrigir um bug:

1. Escreva o menor teste que **falha** por causa do bug e rode-o para ver falhar.
2. Só então corrija o código.
3. Rode o teste de novo e o restante da suíte.
4. No commit, cite o comportamento que o teste trava.

Se o bug não for testável sem uma refatoração grande, diga isso explicitamente
em vez de pular o teste em silêncio.
`),

  agent('revisor', 'Agente revisor de código',
    'Revisa o diff atual em busca de bugs e riscos. Somente leitura.',
    'Read, Grep, Glob, Bash',
    `Você revisa código. Nunca edite arquivos.

Rode \`git diff\` (e \`git diff --staged\`) para ver a mudança, leia os arquivos
tocados por inteiro e os chamadores das funções alteradas.

Reporte apenas achados concretos, ordenados por severidade:
\`arquivo:linha — o que quebra — em que cenário\`.

Não comente estilo, não elogie, não resuma o diff. Sem achados: "sem bloqueios".
`),

  agent('documentador', 'Agente de documentação',
    'Atualiza README e docs para refletir mudanças recentes de código.',
    'Read, Grep, Glob, Edit, Write',
    `Você mantém a documentação sincronizada com o código.

A partir do diff recente, localize a documentação afetada (README, docs/, comentários
de módulo) e atualize **apenas** o que ficou incorreto. Não crie documentação nova
onde não havia, não reescreva seções corretas, não invente exemplo que você não
verificou no código.

Responda com a lista de arquivos alterados e uma linha do que mudou em cada um.
`),

  {
    id: 'hook:formatar-ao-editar', kind: 'hooks', name: 'formatar-ao-editar',
    title: 'Formatar ao editar',
    description: 'Roda `npx prettier --write` no arquivo logo depois de o Claude editar (silencioso se o projeto não tiver prettier).',
    hook: { event: 'PostToolUse', entry: { matcher: 'Edit|Write', hooks: [{ type: 'command', command: PRETTIER_CMD }] } },
  },
  {
    id: 'hook:avisar-ao-terminar', kind: 'hooks', name: 'avisar-ao-terminar',
    title: 'Avisar ao terminar (macOS)',
    description: 'Notificação do sistema quando o Claude termina uma resposta. Só funciona no macOS (usa osascript).',
    hook: {
      event: 'Stop',
      entry: { hooks: [{ type: 'command', command: 'osascript -e \'display notification "Claude terminou" with title "Claude Code"\' >/dev/null 2>&1 || true' }] },
    },
  },
  {
    id: 'hook:proteger-segredos', kind: 'hooks', name: 'proteger-segredos',
    title: 'Bloquear leitura de .env',
    description: 'Nega Read/Edit/Write em arquivos .env (exceto .env.example/.template) antes da ferramenta rodar.',
    hook: {
      event: 'PreToolUse',
      entry: {
        matcher: 'Read|Edit|Write',
        hooks: [{
          type: 'command',
          command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let f='';try{f=(JSON.parse(s).tool_input||{}).file_path||''}catch{};const b=require('path').basename(f);if(/^\\\\.env(\\\\..+)?$/.test(b)&&!/\\\\.env\\\\.(example|template)$/i.test(b))process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'arquivo .env protegido por hook'}}))})"`,
        }],
      },
    },
  },
]

export const catalogItem = id => CATALOG.find(c => c.id === id) || null
