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
essa detecção estão em [`integrations/session-context.md`](integrations/session-context.md).

**Assimetria deliberada entre trackers:** GitHub Issues (pessoal) tem leitura e escrita, via
CLI `gh`; é onde os tickets nascem. Jira (trabalho) é **somente leitura**, via o agente
`atlassian`: lá os tickets chegam prontos, e o papel do fluxo é normalizar e auditar contra o
contrato, apontando os campos que faltam.

### Autoria

Nada gerado a partir de um ticket leva assinatura de IA — commit, PR, comentário. Sem
`Co-Authored-By`, sem "Generated with", sem marca equivalente. Isso inverte a recomendação da
skill de origem do fluxo; a regra local vence.

## Grafo de dependências e plano de ondas

### Onde mora cada peça

| Artefato | Papel |
|---|---|
| `scripts/waves/tickets-github.mjs` | Lê GitHub Issues via CLI `gh` e emite o formato normalizado. Somente leitura |
| `scripts/waves/graph.mjs` | `planWaves()` — função pura que transforma tickets em ondas. Traz um wrapper stdin/stdout para o pipeline |
| `.claude/skills/wave-orchestration/SKILL.md` | Como montar o grafo, como apresentar o plano e as regras invioláveis da onda |
| `.claude/commands/wave-plan.md` | `/wave-plan` — roda o pipeline e imprime a tabela de ondas |

### Duas extensões do formato normalizado

Além dos oito campos já descritos acima, o leitor emite dois campos que o grafo precisa:

- `statusType` — o `type` do estado no tracker, normalizado para `completed` quando o ticket está
  entregue (no GitHub sai de `CLOSED` + `COMPLETED`). É o sinal confiável de "mergeado"; o nome
  do estado é livre e varia por time.
- `external` — `true` quando o ticket não pertence ao escopo lido e só está no registro porque
  alguém depende dele.

O leitor emite ainda um extra próprio, `blockedBySources`, que o `graph.mjs` ignora —
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
node ~/.claude/harness/scripts/waves/tickets-github.mjs --repo <owner>/<repo> --milestone <n> --json > /tmp/wave-tickets.json
node ~/.claude/harness/scripts/waves/graph.mjs --json < /tmp/wave-tickets.json
```

**Os dois passos são separados de propósito.** Num pipe direto, o código de saída do leitor
some e uma falha dele chega ao planejador como entrada vazia — o modo de falha que faz um plano
de ondas mentir. O `graph.mjs` recusa stdin vazia em vez de imprimir um plano de zero ondas.

O primeiro passo é o único que conhece o tracker, e a separação continua valendo mesmo com um
leitor só: é ela que mantém o `graph.mjs` agnóstico e é onde outro tracker entraria, se um dia
entrar. Os códigos de saída do leitor estão em [Falha honesta](#falha-honesta).

`graph.mjs` sai com 2 para entrada inutilizável e com **3 quando o plano está incompleto**
(ciclo ou id inexistente) — o plano é impresso, mas não é executável.

### Testes

`node --test <diretório>` não funciona no Node instalado (24.15): o diretório é resolvido como
módulo e o runner nem chega a rodar. Passe um glob:

```bash
node --test 'scripts/waves/*.test.mjs'
```

O grafo é coberto por fixtures — caminho simples, fan-in, ciclo de 2 e de 3 nós, auto-bloqueio,
bloqueador inexistente, externo aberto, externo já mergeado, órfão, conjunto vazio e
determinismo com a entrada embaralhada.

No leitor, a lógica pura é separada do I/O e testada sozinha: dada a resposta do CLI, qual é
o array normalizado? Nenhum teste chama `gh`.

## Fonte GitHub Issues

`tickets-github.mjs` é o único leitor de tickets, e emite o formato normalizado que o
`graph.mjs` consome. O que ele resolve por conta própria é o recorte, a origem das arestas e a
origem da estimativa.

### Comando

```bash
node ~/.claude/harness/scripts/waves/tickets-github.mjs --repo <owner>/<repo> [--milestone <n>] [--label <l>] [--json]
```

`--repo` é **obrigatório**; `--label` pode repetir. O estado não é opção: a leitura é sempre
`--state all`, porque bloqueador já fechado é o que produz onda 0.

### Escopo: não existe "projeto" no GitHub

O GitHub não tem "projeto" no sentido de recorte de trabalho, então o recorte é
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
| `.claude/skills/wave-orchestration/SKILL.md`, seção `## Dispatch` | Procedimento completo: resolução de contexto, corte de `origin/main`, criação da árvore por host, marcador de worker, prompt do worker, agente não-default, bypass |
| `.claude/commands/wave-status.md` | `/wave-status` — delega a leitura de estado ao `wave-monitor` |
| `.claude/agents/wave-monitor.md` | Agente `haiku`, `Read` + `Bash`, que devolve o estado das branches da onda em uma tabela. Reporta; não conserta, não mergeia |
| `.claude/hooks/lib/context.mjs` | Campo `dispatch` da detecção de sessão: em qual host o disparo é possível |

### Onde o disparo é possível

`node ~/.claude/hooks/session-context.mjs --json` traz `dispatch`, derivado só do host — a
função continua pura, não sonda CLI nenhuma e não executa nada:

| `host` | `dispatch.available` | `driver` |
|---|---|---|
| `maestri` | `false` | `null` — a topologia existe (`floor create` + `recruit --floor`) e o disparo é manual, de dentro do terminal do app |
| `plain` | `false` | `null` — a árvore é um `git worktree` cortado à mão, com o agente aberto por você |

**`available` é `false` em todo host, e isso não quer dizer "não dá para disparar daqui".**
Quer dizer que nenhum driver automático existe: o disparo é um procedimento manual em ambos.
O que distingue os hosts é a `reason`, que nomeia o procedimento daquele host — e é ela, não o
booleano, que o coordenador lê. O dia em que um driver entrar, este campo é o primeiro a mudar.

No Maestri o floor não é improviso — é isolamento nativo —, mas pode sair simples e compartilhar
o diretório; a skill `maestri-orchestration` diz como distinguir e o que fazer quando saiu. No
terminal comum não existe linhagem nem vínculo automático com o ticket: o marcador
`.wave/worker.json` e a tabela da onda são o que substitui os dois, e ambos são obrigatórios.

### As cinco decisões que custaram caro

**1. `git fetch origin main` antes de cortar qualquer onda depois da primeira, verificado com
`git log origin/main --oneline -1`.** Worktree cortado de uma `origin/main` velha não contém o
código do bloqueador. O agente abre o arquivo que a spec manda ler, não encontra, e ou
reimplementa o que o irmão já entregou — conflito garantido no merge — ou trava dizendo que o
ticket está errado. O `git log` é a prova, não enfeite: se o merge do bloqueador não estiver no
commit impresso, o fetch não trouxe o que parecia ter trazido.

**2. O prompt vai em arquivo (`.wave/<ticket>/prompt.md`), entregue como
`"$(cat ...)"`.** Markdown de vários KB colado inline é comido pelo escaping do shell,
e o modo de falha não é erro: é um prompt truncado que o agente obedece achando que está
completo. O arquivo também torna o disparo reexecutável — se o agente morrer, o reenvio relê o
mesmo arquivo em vez de remontar o texto de memória.

O prompt precisa ser **autocontido**: a spec inteira do ticket dentro dele. O worker nasce sem
contexto, e cada ida ao tracker é uma rodada perdida e um ponto onde ele pode ler o ticket
errado. Quando o ticket consome código de um irmão recém-mergeado, isso vai escrito com todas
as letras ("`origin/main` já contém X de #N — REUSE, não reimplemente"); sem a frase, o agente
acha o arquivo, não sabe se pode confiar nele, e reescreve por segurança.

**3. `git stash` é proibido em qualquer repo com mais de uma worktree ativa, não só para o
worker.** Vale igual para `git stash pop` e `git stash apply`. O stash é um ref único
compartilhado por todas as worktrees do repo: o `git stash` de um agente só empilha, mas o `pop`
pega `stash@{0}` — que pode ser de outra frente —, aplica na árvore de quem chamou e descarta a
entrada, deixando a outra worktree limpa e sem o trabalho dela. Estado temporário vira
`git add -A && git commit -m "wip: ..."` na própria branch, a forma que guarda staged, não
staged e arquivo novo (`commit -m` leva só o staged, `commit -am` deixa o arquivo novo não
rastreado para trás); quem não quer commit usa
`git add -A && git diff --staged --binary > <arquivo>.patch` fora da árvore — `git diff` sozinho
omite o que está staged e sai vazio para arquivo novo, e sem `--binary` um binário novo faz o
`git apply` recusar o patch inteiro. O patch salva e deixa a árvore suja: o round trip é
`git reset --hard` para limpar — que apaga os arquivos novos que o `add -A` indexou — e
`git apply <arquivo>.patch` para voltar, restaurando o conteúdo mas não o índice. Nenhuma das
duas formas pega o que está no `.gitignore` — no fluxo de ondas,
`.wave/<ticket>/contract.md`.

**4. Baseline antes de editar.** O worker captura lint/test/build da área antes da primeira
edição. Falha pré-existente não é dele: reporta como pré-existente e segue. Consertar sem
autorização é scope creep e apaga a autoria do bug; travar por causa dela é pior ainda.

**5. O PR se vincula ao ticket, escrito pelo worker na abertura do PR.** A onda 1 mergeou cinco
PRs e deixou as issues #4, #5 e #6 abertas: os corpos de PR não traziam palavra-chave de
fechamento, e só as #1 e #3 fecharam (L-014 em [`lessons.md`](lessons.md)). Trabalho entregue com
ticket aberto envenena o plano seguinte — `/wave-plan` lê o ticket, não a `main`, e lista como
pendente o que já foi entregue. O momento é o da abertura do PR porque é o único em que o
contexto do ticket ainda está de pé; depois do merge ninguém volta para amarrar. O vínculo é a
palavra-chave no **corpo** do PR (`Closes #<n>`; `close`/`closes`/`closed`,
`fix`/`fixes`/`fixed` e `resolve`/`resolves`/`resolved` valem igual, caixa alta e dois-pontos
opcionais), que fecha a issue **no merge** — no título não conta, issue de outro repo vai
qualificada (`Closes owner/repo#<n>`), cada issue quer a sintaxe repetida (`Closes #10, closes
#11`, porque `Closes #10, #11` fecha só a #10), e nada disso é interpretado se o PR não mirar a
branch default. Não há guard, deny nem CI que perceba a falta do vínculo: o texto do prompt é a
camada única.

### Bypass de permissão: ligado por padrão

O worker roda com `--dangerously-skip-permissions`. O motivo é operacional: numa onda de N
árvores ninguém está olhando o terminal de cada agente, e agente parado num prompt de
permissão é agente bloqueado descoberto horas depois. Desligar é **opt-out**, por pedido
explícito.

A questão que isso abria foi medida (issue #2 em `alexdlli/my-configs`, fechada). O
`permissions.deny` declarado em arquivo **sobrevive** ao bypass: os quatro comandos negados
continuaram barrados com o flag ligado. Só que o `deny` é casamento de string, e o bypass
remove o prompt de aprovação que era o backstop dele — `Bash(gh pr merge *)` barra
`gh pr merge 3` e não enxerga `bash -c "gh pr merge 3"`. Quem fecha esse envelope é o hook
`PreToolUse` `.claude/hooks/guard-destructive.mjs`, que barra as duas formas e continua sendo
avaliado sob bypass ([`guard-destructive.md`](guard-destructive.md)).

Mesmo assim, **a garantia de "merge é sempre humano" continua morando também no prompt do
worker**: o "abra o PR contra `main` e PARE, você não faz merge nunca — mesmo que o comando
esteja disponível" segue sendo texto explícito no template. Não porque o deny falhe, mas porque
o desenho é defesa em camadas — e a camada de baixo tem um vão conhecido. **O contexto de
subagente não foi medido**, e o worker nasce no `orchestrator` e delega: quase tudo que uma
onda executa acontece exatamente nesse contexto. As duas camadas de permissão rodam no cliente;
a única garantia que não depende dele é branch protection no GitHub.

**Quem escreve o bypass é quem sobe o agente — você.** Não há mais gerenciador injetando esse
argv por configuração: a flag entra na linha do `recruit --command` no Maestri, ou no `claude`
digitado dentro do worktree no terminal comum. Esquecer é um worker travado no primeiro prompt
de permissão sem ninguém olhando; desligar num ticket é só não escrever a flag.

### O disparo, por host

**`host: maestri` — um floor por ticket.**

```bash
"$MAESTRI_CLI" floor create "w1-issue-3" --branch w1-issue-3
"$MAESTRI_CLI" recruit "W1-3" --preset <preset> --floor "w1-issue-3"
```

Duas armadilhas medidas governam esse par. O `"$MAESTRI_CLI"` **sai com 0 mesmo em erro** —
verbo inválido devolveu `EXIT=0` —, então nada aqui pode usar `set -e` nem `$?` como detector:
a decisão sai do texto da resposta, e o isolamento se confirma pelos literais `isolated clone
at` e `isolated clone on branch '`. E `floor create` é **irreversível pela CLI** (`floor` é
`create|list`, não existe verbo de remoção): uma onda de N tickets deixa N floors que só o
humano apaga na interface do app.

**`host: plain` — um worktree por ticket.**

```bash
git worktree add "../w1-issue-3" -b w1-issue-3 origin/main
```

E aí o agente é aberto à mão dentro da árvore, com o prompt do arquivo.

Nos dois casos o marcador `.wave/worker.json` é escrito **antes** de o agente subir — e
**confirmado a partir da árvore-alvo**, também antes disso. O caminho da árvore (`$WT_PATH`) é
transcrito à mão, no Maestri lido da prosa de um `floor create` que sai com 0 mesmo em falha, e
marcador escrito fora da árvore certa não produz erro nenhum na tela:

```bash
WT_ROOT="$(git -C "$WT_PATH" rev-parse --show-toplevel)" \
  && jq -e . "$WT_ROOT/.wave/worker.json" \
  && echo "MARCADOR CONFIRMADO EM: $WT_ROOT" \
  || echo "PARE: marcador NAO confirmado em $WT_PATH"
```

São duas provas: que `$WT_PATH` é raiz de árvore git — e **qual**, porque o caminho impresso é o
que tem que ser o do `--floor`/`cd` que sobe o agente —, e que o marcador é JSON válido lá
dentro. **Falhou qualquer uma, o agente não sobe.** Sem marcador na árvore em que o worker roda,
`guard-destructive` classifica a sessão como `other` e **não emite veredito nenhum**: o
`gh pr merge` cai no caminho normal de permissão, que sob `--dangerously-skip-permissions` é
execução direta. O procedimento completo está no passo 2a da skill `wave-orchestration`.

Essa é a única vantagem que o disparo manual tem sobre um driver — a janela entre a árvore nascer
e o marcador existir não chega a abrir —, e ela só vale com a confirmação feita.

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
