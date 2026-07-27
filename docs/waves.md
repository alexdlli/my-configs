# Waves

Fluxo de execução em ondas: um projeto é quebrado em tickets, os tickets viram prompts de
agentes autônomos, e as ondas avançam pela frontier do grafo de dependências.

Esta página cobre o **contrato de ticket** — a fundação do fluxo —, o **grafo de
dependências** que gera o plano de ondas, e o **dispatch**: um worktree e um agente por
ticket, uma onda por vez. O que continua sendo do humano é o merge, e é ele que libera a
onda seguinte.

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

## Dispatch de onda

### Onde mora cada peça

| Artefato | Papel |
|---|---|
| `.claude/skills/wave-orchestration/SKILL.md`, seção `## Dispatch` | Procedimento completo: resolução de contexto, corte de `origin/main`, criação de worktree, prompt do worker, agente não-default, bypass |
| `.claude/commands/wave-run.md` | `/wave-run` — dispara **uma** onda |
| `.claude/commands/wave-status.md` | `/wave-status` — delega a leitura de estado ao `wave-monitor` |
| `.claude/agents/wave-monitor.md` | Agente `haiku`, `Read` + `Bash`, que devolve o estado das branches da onda em uma tabela. Reporta; não conserta, não mergeia |
| `.claude/hooks/lib/context.mjs` | Campo `dispatch` da detecção de sessão: em qual host o disparo é possível |

### Onde o disparo é possível

`node ~/.claude/hooks/session-context.mjs --json` traz `dispatch`, derivado só do host — a
função continua pura, não sonda CLI nenhuma e não executa nada:

| `host` | `dispatch.available` | `driver` |
|---|---|---|
| `orca` | `true` | `orca-cli` |
| `maestri` | `false` | `null` — não existe adaptador de onda para o Maestri, e a CLI dele só existe como `$MAESTRI_CLI` dentro do terminal do app |
| `plain` | `false` | `null` — sem gerenciador de worktree; o disparo é manual |

Fora do Orca a entrega continua sendo o plano. Improvisar com `git worktree` na mão perde o
que o Orca dá aqui: linhagem, terminal gerenciado e vínculo com o ticket.

### As quatro decisões que custaram caro

**1. `git fetch origin main` antes de cortar qualquer onda depois da primeira, verificado com
`git log origin/main --oneline -1`.** Worktree cortado de uma `origin/main` velha não contém o
código do bloqueador. O agente abre o arquivo que a spec manda ler, não encontra, e ou
reimplementa o que o irmão já entregou — conflito garantido no merge — ou trava dizendo que o
ticket está errado. O `git log` é a prova, não enfeite: se o merge do bloqueador não estiver no
commit impresso, o fetch não trouxe o que parecia ter trazido.

**2. O prompt vai em arquivo (`.wave/<ticket>/prompt.md`), passado por
`--text "$(cat ...)"`.** Markdown de vários KB colado inline é comido pelo escaping do shell, e
o modo de falha não é erro: é um prompt truncado que o agente obedece achando que está
completo. O arquivo também torna o disparo reexecutável — se o agente morrer, o reenvio é um
`orca terminal send`.

O prompt precisa ser **autocontido**: a spec inteira do ticket dentro dele. O worker nasce sem
contexto, e cada ida ao tracker é uma rodada perdida e um ponto onde ele pode ler o ticket
errado. Quando o ticket consome código de um irmão recém-mergeado, isso vai escrito com todas
as letras ("`origin/main` já contém X de #N — REUSE, não reimplemente"); sem a frase, o agente
acha o arquivo, não sabe se pode confiar nele, e reescreve por segurança.

**3. `git stash` é proibido para o worker.** O stash é um ref único compartilhado por todas as
worktrees do repo: um `git stash` de um agente pode engolir o trabalho não commitado de outro
rodando em paralelo. Estado temporário vira commit `wip:` na própria branch.

**4. Baseline antes de editar.** O worker captura lint/test/build da área antes da primeira
edição. Falha pré-existente não é dele: reporta como pré-existente e segue. Consertar sem
autorização é scope creep e apaga a autoria do bug; travar por causa dela é pior ainda.

### Bypass de permissão: ligado por padrão

O worker roda com `--dangerously-skip-permissions`. O motivo é operacional: numa onda de N
worktrees ninguém está olhando o terminal de cada agente, e agente parado num prompt de
permissão é agente bloqueado descoberto horas depois. Desligar é **opt-out**, por pedido
explícito.

A consequência muda o desenho: não se pode assumir que o `permissions.deny` declarado em
arquivo sobrevive ao bypass — a questão está aberta (issue #2 em `alexdlli/my-configs`) e, até
ser medida, o pressuposto é o pior caso. Por isso **a garantia de "merge é sempre humano" mora
no prompt do worker**, não na camada de permissão: o "abra o PR contra `main` e PARE, você não
faz merge nunca — mesmo que o comando esteja disponível" é texto explícito no template, e é ele
que conta. `Bash(gh pr merge *)` no `permissions.deny` continua lá; é bônus, não a garantia.

Como `--agent <id>` não aceita argv extra, o caminho padrão do dispatch é de dois passos:

```bash
orca worktree create --repo "id:<repoId>" --name "w1-issue-3" \
  --parent-worktree "path:<parent>" --base-branch origin/main --issue 3 --json
orca terminal create --worktree "id:<worktreeId>" --title "w1-issue-3" \
  --command 'claude --dangerously-skip-permissions' --json
orca terminal wait --terminal "<handle>" --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal "<handle>" --text "$(cat .wave/3/prompt.md)" --enter --json
```

O `wait` não é opcional — texto mandado a um TUI que ainda está subindo é perdido em silêncio.
O handle sai do envelope do `terminal create`, com plano B em `orca terminal list --worktree
"id:<worktreeId>" --json` casando o `--title` por `contains`: um agente TUI reescreve o próprio
título da aba assim que sobe, então comparação exata funciona no primeiro segundo e para de
funcionar depois. O caminho curto (`--agent` + `--prompt`, um comando só) fica para quando o
bypass está desligado naquele ticket.

### Acompanhamento

Polling de N branches gera saída enorme e repetida, e ela fica no contexto da thread que menos
pode gastá-lo. Daí o `wave-monitor` ser um agente separado em `haiku`: ele consulta, comprime e
morre com o volume. Ele reutiliza `scripts/waves/pr-state.mjs`, que já separa run cancelado por
force-push (`RUNNING` com `reason: superseded-by-newer-commit` — o agente se autocorrigiu) de
build vermelho de verdade.

Exit code de `pr-state.mjs` é sobre a **consulta**, nunca sobre o CI. Exit 5 numa branch de onda
quase sempre significa "PR ainda não existe", não falha — `git ls-remote --heads origin <branch>`
distingue "não deu push" de "deu push, sem PR".

### O que o dispatch nunca faz

Merge (nem comando, nem instrução ao worker), duas ondas de uma vez, commit na `main`, edição
no worktree de outro ticket, ou worktree a partir de ticket que não passou pelo contrato.
