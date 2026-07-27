# Waves

Fluxo de execução em ondas: um projeto é quebrado em tickets, os tickets viram prompts de
agentes autônomos, e as ondas avançam pela frontier do grafo de dependências.

Esta página cobre o **contrato de ticket** — a fundação do fluxo — e o **grafo de
dependências** que gera o plano de ondas. O disparo das ondas (worktree e agente por ticket)
ainda não existe: hoje o plano sai, e quem dispara é o humano.

## Contrato de ticket

### Premissa

O ticket **é** o prompt. Quem executa é um agente em contexto limpo: não esteve na reunião,
não leu a thread, não sabe o que já tinha sido combinado. O que não está escrito no ticket
não existe para ele.

Daí a régua: *colar só o corpo do ticket numa sessão nova precisa ser suficiente para o
agente entregar a coisa certa.* "Adicionar suporte a transações recorrentes" reprova.

### Onde mora cada peça

| Artefato | Papel |
|---|---|
| `.claude/skills/ticket-contract/SKILL.md` | Fonte da verdade: os 12 campos, as regras de criação de projeto, a checagem de prontidão, o adaptador de tracker e a regra de autoria |
| `.claude/agents/pm.md` | Agente que transforma discussão/spec em projeto + tickets. Lê o codebase para preencher os campos técnicos; nunca edita código |
| `.claude/commands/ticket-new.md` | `/ticket-new` — aciona o fluxo |
| `.claude/skills/orca-linear/SKILL.md` | Stub de descoberta da CLI `orca linear` (guia completo vem do binário) |
| `~/.claude/skills/to-tickets/SKILL.md` | Prior art externa reaproveitada para a mecânica de decomposição |

Os 12 campos e as regras não são repetidos aqui de propósito: quem edita, edita a skill.

### Os 12 campos, em uma linha

1. Título imperativo e específico. 2. Problema e por que resolver. 3. Escopo e o que está
FORA. 4. Comportamento esperado. 5. Detalhes técnicos relevantes. 6. Módulos, funções e
arquivos afetados. 7. Acceptance criteria. 8. Cenários de teste. 9. Dependências em
`blockedBy`. 10. Rollout e kill switch. 11. Eventos e métricas. 12. i18n, LGPD e factories.

### Divergência deliberada de `to-tickets`

A skill `to-tickets` desaconselha file paths e code snippets no ticket ("they go stale
fast"). Aqui eles são **obrigatórios** (campos 5 e 6). O consumidor é diferente: lá, um
humano que talvez abra o ticket seis meses depois; aqui, um agente sem memória do codebase
que executa na mesma semana. Path desatualizado é barato de corrigir; agente reimplementando
no módulo errado, não.

O resto de `to-tickets` continua valendo e é referenciado, não reescrito: fatia vertical /
tracer bullet, wide refactor por expand-migrate-contract, o quiz de granularidade ao usuário,
e a publicação em ordem de dependência trabalhando a frontier.

### Formato normalizado

As fases seguintes consomem tickets independentes de tracker:

```
{ id, key, title, url, estimate, status, blockedBy: [id], body }
```

O tracker é detectado por `node ~/.claude/hooks/session-context.mjs --json` (campos `tracker`
e `trackerSource`), nunca adivinhado pelo nome do repo. Os sinais de ambiente que alimentam
essa detecção estão em [`integrations/orca.md`](integrations/orca.md).

**Assimetria deliberada entre trackers:** Linear (pessoal) tem leitura e escrita, via CLI
`orca linear` — é onde os tickets pessoais nascem. Jira (trabalho) é **somente leitura**, via
o agente `atlassian`: lá os tickets chegam prontos, e o papel do fluxo é normalizar e auditar
contra o contrato, apontando os campos que faltam.

### Autoria

Nada gerado a partir de um ticket leva assinatura de IA — commit, PR, comentário. Sem
`Co-Authored-By`, sem "Generated with", sem marca equivalente. Isso inverte a recomendação da
skill de origem do fluxo; a regra local vence.

## Grafo de dependências e plano de ondas

### Onde mora cada peça

| Artefato | Papel |
|---|---|
| `scripts/waves/tickets-linear.mjs` | Lê um projeto do Linear via CLI `orca linear` e emite o formato normalizado. Somente leitura |
| `scripts/waves/tickets-github.mjs` | Lê GitHub Issues via CLI `gh` e emite o mesmo formato normalizado. Somente leitura |
| `scripts/waves/graph.mjs` | `planWaves()` — função pura que transforma tickets em ondas. Traz um wrapper stdin/stdout para o pipeline |
| `.claude/skills/wave-orchestration/SKILL.md` | Como montar o grafo, como apresentar o plano e as regras invioláveis da onda |
| `.claude/commands/wave-plan.md` | `/wave-plan` — roda o pipeline e imprime a tabela de ondas |

### Duas extensões do formato normalizado

Além dos oito campos já descritos acima, o leitor emite dois campos que o grafo precisa:

- `statusType` — o `type` do estado no tracker, normalizado para `completed` quando o ticket está
  entregue (no Linear é o próprio `type`; no GitHub sai de `CLOSED` + `COMPLETED`). É o sinal
  confiável de "mergeado"; o nome do estado é livre e varia por time.
- `external` — `true` quando o ticket não pertence ao escopo lido e só está no registro porque
  alguém depende dele.

O leitor do GitHub emite ainda um extra próprio, `blockedBySources`, que o `graph.mjs` ignora —
veja [Fonte GitHub Issues](#fonte-github-issues).

### Como o grafo decide a onda

- Nós são tickets, arestas são `blockedBy`. `onda(t) = max(onda dos bloqueadores) + 1`; sem
  bloqueador aberto, onda 1.
- Ticket já mergeado (`statusType: completed`, ou status `done`/`merged`/`completed`) é **onda
  0** e satisfaz quem depende dele.
- **Bloqueador externo ainda aberto: o dependente não recebe onda.** Ele sai em `blocked` com
  `reason: external` e o detalhe `blocked externally by <ID> (<status>)`. Isso não é "onda
  alta" — é ticket que não entra no plano. Quem depende desse dependente também fica de fora,
  com `reason: upstream` e a causa raiz preservada.
- Externo cujo status não pôde ser lido conta como **aberto**. O leitor avisa no stderr e
  mantém o id no registro.
- **Fan-in** (2+ bloqueadores) vem marcado com `fanIn: true` e a lista `waitingOn`: o ticket só
  começa quando todos mergearem.
- **Ciclo** é detectado (Tarjan iterativo, sem recursão) e reportado com os nós envolvidos; os
  nós do ciclo não recebem onda.
- **`blockedBy` apontando para id inexistente** sai em `badData` e o ticket não é agendado.
  Ignorar em silêncio produziria uma onda 1 falsa.
- A ordem de entrada não muda o resultado: ids são ordenados por `key` (comparação numérica,
  `ENG-2` antes de `ENG-10`) antes de qualquer cálculo.

### Pipeline

```bash
node ~/.claude/harness/scripts/waves/tickets-linear.mjs "<projeto>" --json > /tmp/wave-tickets.json
node ~/.claude/harness/scripts/waves/graph.mjs --json < /tmp/wave-tickets.json
```

**Os dois passos são separados de propósito.** Num pipe direto, o código de saída do leitor
some e uma falha dele chega ao planejador como entrada vazia — o modo de falha que faz um plano
de ondas mentir. O `graph.mjs` recusa stdin vazia em vez de imprimir um plano de zero ondas.

O primeiro passo é o único que conhece o tracker. Trocar `tickets-linear.mjs` por
`tickets-github.mjs` não muda nada depois dele: o `graph.mjs` consome o formato normalizado e
não sabe de onde veio.

### Falha honesta

`tickets-linear.mjs` nunca emite array vazio como sucesso. Códigos de saída:

| Código | Situação |
|---|---|
| 2 | Uso errado (sem projeto, flag desconhecida) |
| 3 | CLI `orca` não encontrada (respeita `ORCA_CLI_COMMAND`) |
| 4 | App Orca fora do ar ou runtime inalcançável |
| 5 | Orca rodando, mas Linear não conectado |
| 6 | Projeto não encontrado, ou o texto casa com mais de um |
| 7 | Erro do `orca` (código e mensagem do envelope repassados) |

Também falha, em vez de truncar, quando o Linear devolve leitura parcial, `workspaceErrors`, ou
mais páginas de issues do que o cursor consegue percorrer.

`graph.mjs` sai com 2 para entrada inutilizável e com **3 quando o plano está incompleto**
(ciclo ou id inexistente) — o plano é impresso, mas não é executável.

### Testes

`node --test <diretório>` não funciona no Node instalado (24.15): o diretório é resolvido como
módulo e o runner nem chega a rodar. Passe os arquivos:

```bash
node --test scripts/waves/graph.test.mjs scripts/waves/tickets-linear.test.mjs scripts/waves/tickets-github.test.mjs
```

O grafo é coberto por fixtures — caminho simples, fan-in, ciclo de 2 e de 3 nós, auto-bloqueio,
bloqueador inexistente, externo aberto, externo já mergeado, órfão, conjunto vazio e
determinismo com a entrada embaralhada.

Nos leitores, a lógica pura é separada do I/O e testada sozinha: dada a resposta do CLI, qual é
o array normalizado? Nenhum teste chama `orca` ou `gh`.

## Fonte GitHub Issues

`tickets-github.mjs` emite exatamente o mesmo formato normalizado que o leitor do Linear, então
o `graph.mjs` não muda. O que muda é o recorte, a origem das arestas e a origem da estimativa.

### Comando

```bash
node ~/.claude/harness/scripts/waves/tickets-github.mjs --repo <owner>/<repo> [--milestone <n>] [--label <l>] [--json]
```

`--repo` é **obrigatório**; `--label` pode repetir. O estado não é opção: a leitura é sempre
`--state all`, porque bloqueador já fechado é o que produz onda 0.

### Escopo: não existe "projeto" no GitHub

No Linear o recorte natural é o projeto. No GitHub não há equivalente, então o recorte é
`--milestone` ou `--label`. **Sem recorte, o escopo é o repo inteiro** — e isso vem anunciado
em caixa alta no stderr, porque um plano de ondas do repo todo quando a pessoa queria um
milestone é o tipo de erro que só aparece tarde:

```text
scope: acme/api, THE WHOLE REPO (no --milestone, no --label) — 312 issue(s), every state
```

Acima de 1000 issues no escopo o leitor **recusa** em vez de truncar, e manda recortar.

### `blockedBy`: união de duas fontes

| Fonte | De onde vem |
|---|---|
| `native` | A dependência nativa de issue do GitHub — a mesma "blocked by" da barra lateral, campo `blockedBy` do `gh issue list --json` |
| `marker` | Um marcador ancorado no corpo da issue |

O marcador é um comentário HTML, `<!-- blocked-by: #12, owner/repo#34 -->`. Comentário porque
não renderiza no corpo da issue, e **ancorado** porque a alternativa — caçar `#\d+` em texto
livre — casaria com prosa, bloco de código e checklist, inventando aresta que ninguém declarou.

Regras do marcador:

- Aceita a forma curta `#12` (assume o repo alvo) e a cross-repo `owner/repo#12`.
- **Vários marcadores no mesmo corpo são unidos**, não rejeitados: corpo editado em duas passadas
  não é dado ruim, e a união é a mesma operação já aplicada entre as duas fontes.
- Entrada malformada (`<!-- blocked-by: banana -->`, `<!-- blocked-by: -->`) é **dado ruim
  reportado** — nunca ignorada em silêncio. As entradas boas do mesmo marcador continuam valendo.

As duas fontes são normalizadas para o mesmo id canônico antes da união, senão a dedup não
funciona. O id é `<owner>/<repo>#<número>`, em minúsculas — nome de owner e de repo no GitHub é
case-insensitive, e um marcador digitado à mão não casaria com a resposta da API sem isso.

Cada aresta guarda de onde veio, no campo extra `blockedBySources` (`native` | `marker` |
`both`). O `graph.mjs` ignora esse campo; ele existe para depurar grafo errado.

### Estimativa: label `est:<n>`

Convenção que **eu** aplico na mão nas issues, porque o GitHub não tem campo de estimativa:

- `est:3`, `est: 0.5`, `EST:2` — todos valem.
- Sem label → `estimate: null`.
- Duas labels `est:` com valores diferentes → **dado ruim reportado**, `estimate: null`. Nunca
  escolha silenciosa. Duas labels com o mesmo valor passam.
- `est:banana` → dado ruim reportado.

### Estado: `COMPLETED` é o sinal confiável

| `state` / `stateReason` | `status` | `statusType` | Satisfaz quem depende? |
|---|---|---|---|
| `OPEN` (inclusive `REOPENED`) | `Open` | `open` | não |
| `CLOSED` + `COMPLETED` | `Closed (completed)` | `completed` | **sim** |
| `CLOSED` + `NOT_PLANNED` | `Closed (not planned)` | `canceled` | **não** |
| `CLOSED` sem motivo | `Closed (no reason)` | `completed` | sim |
| Estado ilegível | `null` | `null` | não |

Fechar como *not planned* não é entregar — o dependente continua sem onda. A terceira linha é
decisão deliberada: o GitHub fez backfill dos fechamentos pré-2022 como `COMPLETED` e só oferece
"not planned" como opt-out, então motivo em branco significa "fechado, ninguém disse o
contrário". A leitura oposta prenderia o dependente atrás de um bloqueador visivelmente fechado.

### Bloqueador externo

O `blockedBy` nativo devolve os nós **sem** o campo `repository` — só `{id, number, state,
title, url}`. A URL é a única forma de descobrir o repo do bloqueador pela CLI, e é dela que sai
o `external: true`.

É externo tudo que o `blockedBy` aponta e está fora do escopo lido: outro repo, ou o mesmo repo
fora do milestone/label. Cada um é lido individualmente com `gh issue view` para pegar o
`stateReason` real (que o nó da relação não traz). Bloqueador que não pôde ser lido entra no
registro com status `null`, ou seja, conta como aberto — e o motivo vai para o stderr.

Se a URL do bloqueador não for de issue (um PR, por exemplo), ele é reportado como dado ruim e
tratado como ilegível: `gh issue view` responde por PR também, mas `CLOSED` num PR não distingue
mergeado de fechado sem merge, e chutar aí produziria onda errada.

### Truncamento: falha alta

O GitHub limita cada conexão de relação a 50 nós por issue. Passando disso, os nós voltam
truncados e só o `totalCount` denuncia. O leitor compara os dois e **falha** (código 7) em vez de
cair para GraphQL cru paginado: grafo truncado gera plano de ondas errado, e um caso de 50+
bloqueadores numa issue é patológico o bastante para merecer uma mensagem em vez de um caminho
de código paralelo.

### Falha honesta

`tickets-github.mjs` nunca emite array vazio como sucesso. Repo com zero issues no escopo é
resultado legítimo — e vem dito com todas as letras no stderr, para não ser confundido com
leitura que falhou:

```text
read succeeded and matched 0 issue(s) — an empty plan here means an empty scope, not a failed read
```

Códigos de saída:

| Código | Situação |
|---|---|
| 2 | Uso errado (sem `--repo`, `--repo` fora do formato `owner/repo`, flag desconhecida) |
| 3 | CLI `gh` não encontrada (respeita `GH_CLI_COMMAND`) |
| 4 | GitHub inalcançável ou rate limit (inclusive o secundário, que vem como 403) |
| 5 | `gh` não autenticado, ou token sem escopo para o repo |
| 6 | Repo inexistente, ou repo com issues desabilitadas |
| 7 | Erro do `gh`, ou leitura truncada (mais de 1000 issues, ou relação acima do teto de 50) |
| 8 | Tickets emitidos, mas há dado ruim atrás deles |

O **8** é o único em que o stdout ainda presta: os tickets saem, cada problema sai como
`! bad data: <id>: <detalhe>` no stderr, e o código não-zero impede que automação trate a
leitura como limpa. É o mesmo padrão do `graph.mjs`, que imprime o plano e sai com 3 quando ele
está incompleto.

Dependência nativa de issue é GA no `gh` 2.95: sem header de preview e sem escopo além do `repo`.
Custo medido: 1 ponto de GraphQL por 100 issues.
