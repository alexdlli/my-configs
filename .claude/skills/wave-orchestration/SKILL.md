---
name: wave-orchestration
description: >-
  Planejamento de execução em ondas a partir do grafo de dependências de um
  projeto de tickets. Use quando o usuário pedir "plano de ondas", "quantas
  frentes dá pra tocar em paralelo", "o que dá pra começar agora", "monta o
  grafo desse projeto", ou ao orquestrar várias frentes com marcos de
  sincronização. Lê os tickets de GitHub Issues via `gh`, monta o grafo pelas
  relações reais de bloqueio e apresenta as ondas ao humano. Também cobre o
  disparo **manual** de uma onda por vez — uma árvore e um agente por ticket —
  quando o usuário pedir "dispara a onda 1", "roda essa onda", "abre os
  worktrees". Nunca faz merge: isso é do humano.
---

# Orquestração em ondas

Uma **onda** é o conjunto de tickets que pode ser tocado em paralelo porque
todos os bloqueadores deles já estão mergeados. O paralelismo sai do grafo de
dependências, não da vontade de ir rápido.

Esta skill cobre **planejar** (seções 1 e 2) e **disparar** uma onda de cada vez
(seção `## Dispatch`). O que ela nunca cobre é fechar a onda: merge é humano.

## Pré-requisito: os tickets precisam declarar `blockedBy`

Grafo bom exige aresta explícita. A skill `ticket-contract` é dona disso (campo
9 dos 12: só aresta real, com uma frase dizendo o que este ticket consome do
bloqueador; nunca inferida de título, numeração ou ordem). Projeto sem
`blockedBy` preenchido gera uma onda 1 gigante que mente sobre o paralelismo
disponível — nesse caso, volte para `ticket-contract` antes de planejar.

No GitHub a aresta mora na dependência nativa da issue **ou** no marcador
`<!-- blocked-by: ... -->` no corpo. Nos dois casos ela é declarada, nunca
inferida.

**Não confunda dois artefatos de nome parecido:**

| Artefato | O que é | Quem escreve |
|---|---|---|
| Skill `ticket-contract` | Qualidade do **ticket**: os 12 campos que fazem o ticket servir como prompt de agente | O `pm`, na criação do projeto |
| Arquivo `.wave/<ticket>/contract.md` | Contrato de **interface** entre `implementer` e `tester` durante a execução de um ticket: assinaturas, tipos, erros e a lista de cenários | Os dois agentes, em paralelo, antes de escrever código |

O primeiro existe antes da onda começar; o segundo nasce dentro da execução de
um ticket. Um não substitui o outro.

## 1 — Ler os tickets e montar o grafo

Dois scripts, dois passos. Não recalcule ondas na cabeça e não reordene o
resultado: o cálculo é do `graph.mjs` e é testado.

### A fonte é uma só: GitHub Issues

**O `graph.mjs` é agnóstico de fonte.** Ele consome o formato normalizado e não
sabe de onde veio. Quem conhece o tracker é só o primeiro passo, e existe um
leitor: `tickets-github.mjs`, recortado por `--repo` mais `--milestone`/`--label`.

Jira não tem leitor: lá a leitura é via agente `atlassian`, e não existe pipeline
automatizado de ondas. Um pedido de plano de ondas sobre um projeto do Jira volta
como recusa explícita, não como plano vazio.

O que ainda se decide antes de rodar é o **recorte**, e ele não se adivinha pelo
nome do repo: se o usuário não disse qual milestone ou label, **pergunte**. Rodar
sem recorte devolve um plano do repo inteiro, que custa uma rodada e engana.

```bash
node ~/.claude/harness/scripts/waves/tickets-github.mjs --repo <owner>/<repo> --milestone <n> --json > /tmp/wave-tickets.json
node ~/.claude/harness/scripts/waves/graph.mjs --json < /tmp/wave-tickets.json
```

**`--repo` é obrigatório e o recorte não é.** Sem `--milestone` e sem `--label` o
escopo é o repo inteiro, em todos os estados — o leitor avisa isso no stderr em
caixa alta, e acima de 1000 issues ele recusa em vez de truncar. Se o aviso de
repo inteiro aparecer e o humano queria um milestone, pare e confirme antes de
apresentar o plano.

O `blockedBy` sai da **união** de duas fontes: a dependência nativa do GitHub
("blocked by", a mesma da barra lateral da issue) e um marcador ancorado no
corpo, `<!-- blocked-by: #12, owner/repo#34 -->`. Estimativa vem da label
`est:<n>`. Detalhes em `~/.claude/harness/docs/waves.md`.

Códigos de saída: CLI `gh` ausente (3), GitHub inalcançável ou rate limit (4),
não autenticado ou sem escopo (5), repo inexistente ou issues desabilitadas (6),
erro do `gh` ou leitura truncada (7), **tickets emitidos mas dado ruim atrás
deles (8)**. O 8 é o único em que o stdout ainda presta: marcador malformado ou
labels `est:` conflitantes. Leve o `! bad data:` do stderr ao humano.

### Os dois passos são separados de propósito

**Nunca use um pipe direto.** Num pipe, o código de saída do leitor some e um
erro dele vira "plano vazio". Se o primeiro comando falhar, pare e reporte o
motivo — o leitor nunca emite array vazio como sucesso, e leitura legítima de
zero tickets vem anunciada no stderr.

O `graph.mjs` sai com 3 quando o plano está **incompleto** — ciclo de
dependência ou `blockedBy` apontando para id inexistente. Nesse caso o plano
impresso não é executável: leve os itens de `cycles` e `badData` ao humano antes
de qualquer outra coisa.

O que sai do `graph.mjs --json`:

| Campo | Conteúdo |
|---|---|
| `waves[]` | `{ number, tickets[] }` — cada ticket com `blockedBy`, `waitingOn`, `fanIn`, `unblocks` |
| `done[]` | Já mergeado (onda 0). Conta como bloqueador satisfeito |
| `blocked[]` | Não agendado, com `reason` (`external`, `cycle`, `unknown-blocker`, `upstream`) e `detail` legível |
| `cycles[]` | Nós de cada ciclo detectado |
| `badData[]` | `blockedBy` apontando para id que não existe no registro |
| `externals[]` | Bloqueadores fora do projeto, com status e quem eles seguram |
| `labels` | `id` → `ENG-123`, para renderizar as listas de ids |

## 2 — Apresentar o plano ao humano

Uma tabela, nesta ordem, com os ids traduzidos por `labels`:

```text
| Onda | Tickets | Desbloqueia depois |
```

E, logo abaixo, três destaques que não podem ficar escondidos numa célula:

- **Fan-in** (`fanIn: true`): diga explicitamente que o ticket só começa quando
  **todos** os bloqueadores estiverem mergeados, listando-os.
- **Bloqueado externamente**: fora da tabela, com o id e o status do bloqueador
  externo. **Não é onda alta** — é ticket sem onda, e ele não entra em nenhuma
  linha da tabela.
- **Dado ruim** (`cycles`, `badData`): antes da tabela, porque invalida o plano.

Feche com o total de tickets, quantos foram agendados, quantos ficaram de fora e
por quê. Se o plano tiver uma única onda, diga isso na cara: ou o projeto é
mesmo plano, ou os `blockedBy` não foram preenchidos.

## Regras invioláveis

Valem desde já, antes mesmo de existir disparo automático.

1. **Merge é SEMPRE humano.** Nem branch de worker, nem PR, dentro ou fora de
   onda. O output de uma onda "pronta" é o resumo e o pedido de aprovação —
   nunca o comando de merge.
2. **Cada onda nasce de `origin/main` atualizada.** Antes de cortar qualquer
   onda dependente, `git fetch origin main`. Sem isso o worktree filho não
   enxerga o código do bloqueador que acabou de mergear, e o ticket é
   reimplementado ou quebra na integração.
3. **O paralelismo vem do grafo, não da contagem de tickets.** Dez tickets numa
   onda 1 legítima são dez frentes; dez tickets encadeados são uma. Nunca
   aumente a largura da onda "porque tem gente sobrando".
4. **Nada assinado como IA.** Commit, PR, título, corpo, comentário em ticket ou
   PR: sem `Co-Authored-By` de assistente, sem "Generated with", sem marca
   equivalente. O autor é o usuário.
5. **Uma onda só fecha quando o humano diz que fechou.** Ticket em review não é
   ticket mergeado, e a onda seguinte depende de merge, não de aprovação.
6. **`git stash` é PROIBIDO dentro de uma worktree.** Vale igual para `git
   stash pop` e `git stash apply`. `refs/stash` mora no git dir comum e é um
   ref único do repositório, compartilhado por todas as worktrees — os refs
   por-worktree são `HEAD`, `refs/bisect`, `refs/worktree` e `refs/rewritten`,
   e `refs/stash` não está entre eles. O seu stash cai na mesma pilha do agente
   ao lado, e o `pop` dele leva o trabalho não commitado da outra frente.
   Estado temporário vai em **commit na própria branch da worktree**, na forma
   completa `git add -A && git commit -m "wip: ..."` — é local e reescrevível
   antes do PR, e só assim guarda staged, não staged e arquivo novo, menos o que
   está no `.gitignore`. O `add -A` é o que torna a frase verdadeira:
   `commit -m` sozinho leva **só** o que está staged, e `commit -am` deixa o
   arquivo novo não rastreado para trás.
   Não quer commit? `git add -A && git diff --staged --binary > <arquivo>.patch`
   fora da árvore, com a mesma ressalva do `.gitignore`: no fluxo de ondas,
   `.wave/<ticket>/contract.md` fica de fora e precisa de cópia à parte. O
   `add -A` não é enfeite: `git diff` sozinho omite o que já está staged e sai
   **vazio** para arquivo novo não rastreado, de modo que o patch parece salvo e
   o trabalho some — o mesmo modo de falha silencioso que esta regra existe para
   impedir. O `--binary` também não: sem ele, arquivo binário novo vira só
   `Binary files ... differ` e o `git apply` sai **exit 1** sem aplicar nada do
   patch, levando junto o arquivo de texto que estava no mesmo patch. E o patch
   salva sem limpar: a árvore fica suja, tudo staged, e quem foi buscar árvore
   limpa (rebase, pull, build) não terminou. O round trip é salvar, limpar com
   `git reset --hard` e restaurar com `git apply <arquivo>.patch`. Duas
   ressalvas: o índice **não** volta — o que estava staged volta não staged e
   arquivo novo volta como `??` —, e o `reset --hard` é destrutivo justamente
   por causa do `add -A`, que pôs os arquivos novos no índice para o reset
   apagar; patch ruim aí é trabalho perdido. Vale em qualquer repo com mais de
   uma worktree ativa, não só no fluxo de ondas.

## Dispatch

Disparar uma onda é criar **um worktree por ticket** e colocar **um agente** em
cada um. Planejar é barato; disparar toca o disco, gasta contexto de verdade e
cada erro aqui custa a onda inteira.

**Uma onda por vez.** O humano nomeia qual. Nunca dispare a onda seguinte junto,
nem "as duas primeiras porque a segunda é pequena": a onda seguinte depende de
**merge**, e merge é humano.

### Onde o disparo é possível

`node ~/.claude/hooks/session-context.mjs --json` traz o campo `dispatch`:

| `host` | `dispatch` | O que fazer |
|---|---|---|
| `orca` | `available: true`, driver `orca-cli` | Siga esta seção |
| `maestri` | `available: false`, sem driver | O adaptador **automático** não existe, mas a topologia sim: um `floor create` por ticket e um `recruit --floor` em cada. Disparo **manual**, de dentro do terminal do app, e só depois de confirmar na resposta que o floor saiu isolado (skill `maestri-orchestration`) |
| `plain` | `available: false` | Sem gerenciador de worktree na sessão: entregue o plano e o humano dispara |

Fora do Orca e do Maestri a entrega da skill continua sendo o **plano**. Não
improvise substituto com `git worktree` na mão: o que o Orca dá aqui não é o
checkout, é a linhagem, o terminal gerenciado e o vínculo com o ticket.

No Maestri o floor **não** é improviso — é isolamento nativo, um clone por ticket.
Mas ele pode sair **simples**, compartilhando o diretório do térreo, e aí a
premissa desta skill (uma árvore por frente) deixa de valer: nesse caso serializa
as frentes num agente só ou traz a onda pro Orca, nunca N agentes sobre o mesmo
diretório. Como distinguir os dois é da `maestri-orchestration`.

### 0 — Resolver o contexto uma vez

Os dois selectores usados em **todo** ticket da onda saem de uma chamada só:

```bash
WT=$(orca worktree current --json)
[ "$(jq -r '.ok' <<<"$WT")" = true ] || { echo "orca worktree current falhou"; exit 1; }
REPO_ID=$(jq -r '.result.worktree.repoId' <<<"$WT")
PARENT=$(jq -r '.result.worktree.path' <<<"$WT")
```

O envelope tem `ok` no topo e os campos sob `result.worktree` — confira o `.ok`
antes de ler o resto, porque envelope de erro não traz `worktree` e o `jq`
devolveria `null` silenciosamente para os dois selectores.

### 1 — `git fetch origin main` antes de cortar a onda

**Esta é a regra que mais custa caro quando esquecida. Ela vale para toda onda
depois da primeira, sem exceção.**

```bash
git fetch origin main
git log origin/main --oneline -1
```

A segunda linha não é enfeite, é a **prova**. Compare o commit impresso com o
merge do bloqueador que fechou a onda anterior. Se o merge não estiver ali,
**pare**: o fetch não trouxe o que você acha que trouxe, e cortar agora produz
worktree cego.

Por que dói tanto: worktree cortado de uma `origin/main` velha não contém o
código do bloqueador. O agente do ticket abre o arquivo que a spec manda ler,
não encontra, e faz uma de duas coisas — reimplementa o que o irmão já entregou
(conflito garantido no merge) ou trava dizendo que o ticket está errado. Nos
dois casos a onda volta para a fila inteira, e o sintoma só aparece horas
depois.

Vale inclusive quando "acabei de dar fetch faz dois minutos": o merge do humano
pode ter acontecido nesses dois minutos, e é exatamente por isso que a onda
estava esperando.

### 2 — Um worktree por ticket

**Um comando por ticket.** O `create` corta o worktree, sobe o agente no
**primeiro** terminal e entrega o prompt no argv de lançamento:

```bash
CREATE=$(orca worktree create \
  --repo "id:$REPO_ID" \
  --name w1-issue-3 \
  --parent-worktree "path:$PARENT" \
  --base-branch origin/main \
  --issue 3 \
  --agent claude \
  --prompt "$(cat .wave/3/prompt.md)" \
  --json)
HANDLE=$(jq -r '.result.agentTerminalHandle // .result.startupTerminal.handle // empty' <<<"$CREATE")
```

| Flag | Por quê |
|---|---|
| `--repo id:$REPO_ID` | Explícito. Sem ele o Orca infere o repo do cwd, e o cwd de um loop de N tickets não é confiável |
| `--name` | Prefixo da onda + ticket (`w1-issue-3`). É o que a tabela da onda e o `orca worktree list` mostram |
| `--parent-worktree path:$PARENT` | Linhagem: os worktrees da onda são **filhos** do worktree atual, não irmãos soltos |
| `--base-branch origin/main` | O corte. Depende do passo 1 ter rodado |
| `--issue <n>` / `--linear-issue <id\|url>` | Vincula o worktree ao ticket. GitHub usa `--issue`, Linear usa `--linear-issue` |
| `--agent claude` | Sobe o agente conhecido no primeiro terminal. Ids: `claude`, `codex`, e os outros TUIs instalados |
| `--prompt "$(cat ...)"` | O prompt do ticket, sempre do arquivo (passo 3) |
| `--setup` | `inherit` é o default. Passe `--setup run` quando o ticket precisa das deps instaladas para rodar teste |

**O argv do agente não vem da linha de comando — vem do setting.** `--agent
claude` não sobe um `claude` pelado: o Orca monta
`claude --dangerously-skip-permissions '<prompt>'` a partir de
`settings.agentDefaultArgs`, em
`~/Library/Application Support/orca/profiles/local-default/orca-data.json`, que
já traz `{"claude": "--dangerously-skip-permissions", "codex":
"--dangerously-bypass-approvals-and-sandbox"}`. E isso é **default de fábrica**,
não configuração desta máquina: no `app.asar` a constante chama-se
`YOLO_TUI_AGENT_ARGS`, com `DEFAULT_TUI_AGENT_ARGS = YOLO_TUI_AGENT_ARGS`. Não
existe flag de CLI para trocar esse argv (ver `### Bypass de permissão`
adiante).

Duas armadilhas do caminho de dois passos simplesmente **não existem aqui**:

- **Nenhum shell órfão.** O agente entra na primeira aba — que é exatamente a que
  virava o shell de fallback quando o `create` rodava sem `--agent`.
- **Nenhuma corrida de `tui-idle`.** O agente `claude` tem
  `promptInjectionMode: "argv"`: o prompt viaja no argv de lançamento, não é
  digitado no TUI. Não há `terminal wait`, não há `terminal send`, e o defeito
  descrito no passo 2b não tem por onde acontecer.

Com `--agent`, **não** crie um segundo terminal com o mesmo agente depois: ele já
está no primeiro, e um segundo é um agente duplicado no mesmo checkout brigando
pelos mesmos arquivos.

Não passe `--activate` num loop de N tickets: cada `--activate` rouba o foco do
app e o humano perde o lugar N vezes.

### 2a — Marcar o worktree como worker, no comando seguinte

**É este passo que impede o worker de mergear. Tirar ele reabre o buraco.**

```bash
WT_PATH=$(jq -r '.result.worktree.path' <<<"$CREATE")
BRANCH=$(jq -r '.result.worktree.branch' <<<"$CREATE")
mkdir -p "$WT_PATH/.wave"
jq -n --arg ticket 3 --arg branch "$BRANCH" --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{ticket: $ticket, branch: $branch, createdAt: $createdAt}' > "$WT_PATH/.wave/worker.json"
```

O hook `guard-destructive` nega `gh pr merge` — literal e envelopado em
`bash -c` — **quando acha esse marcador** subindo de `CLAUDE_PROJECT_DIR` e da
cwd até a raiz do repo. Sem marcador ele fica calado e o comando cai no prompt
de permissão normal, que é o que o Alex quer para a sessão dele e **não** é o que
se quer num worker rodando com `--dangerously-skip-permissions`, onde não existe
prompt para barrar nada. Ver [`../../../docs/guard-destructive.md`](../../../docs/guard-destructive.md).

Três coisas que não podem mudar sem pensar:

- **O conteúdo não é lido pelo guard, só a presença e o fato de ser JSON
  válido.** Os campos são para o humano que abre o worktree e para o
  `wave-monitor`. Marcador truncado ou não-JSON conta como "não sei" e o guard
  nega o merge — é o lado seguro do erro.
- **Nada de detectar worker pelo nome da pasta.** `w1-issue-3` é convenção deste
  dispatch e vai mudar; marcador explícito é o contrato.
- **`.wave/` é gitignorado**, então o marcador nunca entra num commit nem
  aparece no `git status` do worker.

Roda **imediatamente depois** do `create`, antes de qualquer outra coisa. O
`--agent` já subiu o agente, então existe uma janela entre o worktree nascer e o
marcador existir. Ela é inofensiva na prática — para mergear, o worker precisa
antes ler o prompt, fazer o trabalho e abrir um PR, e nada disso acontece nos
milissegundos do `jq` — mas não a alargue colocando outros comandos no meio.

### 2b — Caminho de exceção: dois passos, com verificação

Só quando o `--agent` não expressa o que o ticket precisa: **agente não-default**
ou **modelo específico** (ver `### Agente não-default` adiante). Nunca como
padrão — e a razão está medida.

**O defeito: no primeiro disparo real de onda, 4 de 5 tickets subiram sem
prompt.** `orca terminal wait --for tui-idle --timeout-ms 60000 --json` devolveu
`{ok: true, state: null, waitedMs: null}` — voltou na hora, sem esperar coisa
alguma. O `terminal send --text ... --enter` seguinte entregou o texto, mas o
Enter chegou cedo demais: o prompt de 15-22 KB ficou **no composer, não
submetido**. Da tela, o terminal parecia um agente pensando. Só apareceu porque o
humano olhou.

Daí a regra deste caminho: **verificação, não esperança.** Depois do `send`,
confirme a submissão lendo o terminal.

Aqui o marcador de worker (passo 2a) tem lugar melhor que no caminho padrão:
como o agente só sobe no `terminal create`, escrevê-lo entre os dois comandos
fecha a janela em vez de apenas encurtá-la.

```bash
NEW=$(orca worktree create --repo "id:$REPO_ID" --name w1-issue-3 \
  --parent-worktree "path:$PARENT" --base-branch origin/main --issue 3 --json)
WT_ID=$(jq -r '.result.worktree.id' <<<"$NEW")
WT_PATH=$(jq -r '.result.worktree.path' <<<"$NEW")

mkdir -p "$WT_PATH/.wave"
jq -n --arg ticket 3 --arg branch "$(jq -r '.result.worktree.branch' <<<"$NEW")" \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{ticket: $ticket, branch: $branch, createdAt: $createdAt}' > "$WT_PATH/.wave/worker.json"

TERM=$(orca terminal create --worktree "id:$WT_ID" --title w1-issue-3 \
  --command 'codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5' --json)
HANDLE=$(jq -r '.result.terminal.handle // .result.handle // empty' <<<"$TERM")
[ -n "$HANDLE" ] || HANDLE=$(orca terminal list --worktree "id:$WT_ID" --json \
  | jq -r '.result.terminals[] | select(.title | contains("w1-issue-3")) | .handle')

orca terminal send --terminal "$HANDLE" --text "$(cat .wave/3/prompt.md)" --enter --json
orca terminal read --terminal "$HANDLE" --json
```

Se o `read` mostrar o prompt parado no composer em vez de um agente trabalhando,
mande só o Enter e leia de novo:

```bash
orca terminal send --terminal "$HANDLE" --text "" --enter --json
orca terminal read --terminal "$HANDLE" --json
```

`wait --for tui-idle` pode continuar no roteiro como aceleração, mas **não vale
como garantia**: ele já voltou `state: null` na hora, para 4 terminais de 5. Quem
decide é o `read`.

**Pegue o handle do envelope do `terminal create`, na hora.** O plano B por
título (`contains`, nunca igualdade) só vale nos primeiros instantes: o TUI
reescreve o título da aba assim que sobe, e depois disso o título não identifica
mais nada.

**E sobra um shell.** Sem `--agent`, o `create` abriu um terminal de fallback, e
ele fica aberto ao lado do agente. **Casar por título não desempata os dois:**
ambos aparecem com o mesmo texto (`⠂ orchestrator`), porque quem escreve o título
da aba é o TUI, não o `--title`. O discriminador confiável é
`orca worktree ps --json`, que traz `worktrees[].agents[].paneKey` no formato
`<tabId>:<leafId>` — monte o set de paneKeys de agente e trate como não-agente
todo terminal cujo `<tabId>:<leafId>` esteja fora do set:

```bash
AGENT_PANES=$(orca worktree ps --json | jq -r '.result.worktrees[].agents[].paneKey')
orca terminal list --worktree "id:$WT_ID" --json | jq -r --arg panes "$AGENT_PANES" '
  ($panes | split("\n")) as $set
  | .result.terminals[]
  | select(("\(.tabId):\(.leafId)" | IN($set[])) | not)
  | .handle'
```

Fecha com `orca terminal close --terminal <handle> --tab`. Confira o handle antes
de fechar: aba errada é um agente da onda morto no meio do trabalho.

### 3 — O prompt vai em ARQUIVO, sempre

Escreva `.wave/<ticket>/prompt.md` e passe o **conteúdo do arquivo**:
`--prompt "$(cat .wave/<ticket>/prompt.md)"` no `worktree create`, ou
`--text "$(cat .wave/<ticket>/prompt.md)"` no `terminal send` do caminho 2b.
**Nunca cole o markdown direto na linha de comando.**

O prompt de um ticket bom tem vários KB de markdown: crase, `$`, `!`, aspas,
bloco de código, comentário HTML. Inline, o shell come parte disso antes de o
`orca` ver — e o modo de falha não é erro, é um prompt **truncado ou
adulterado** que o agente obedece achando que está completo.

O arquivo também é o que torna o disparo reexecutável: se o agente morrer, o
prompt continua no disco e o reenvio é `orca terminal send --text "$(cat ...)"`.

**O prompt precisa ser autocontido.** A spec inteira do ticket vai dentro dele —
os 12 campos, ou o que existir deles. O agente do worktree não deve precisar
reabrir o Linear nem o GitHub para saber o que construir: ele nasce sem
contexto, e cada ida ao tracker é uma rodada perdida e um ponto onde ele pode
ler o ticket errado.

Se o ticket consome código de um irmão recém-mergeado, diga com todas as letras,
dentro do prompt:

```text
`origin/main` já contém o leitor de issues do GitHub entregue em #12, em
`scripts/waves/tickets-github.mjs`. REUSE — não reimplemente.
```

Sem essa frase o agente encontra o arquivo, não sabe se pode confiar nele, e
reescreve por segurança.

### 4 — Registrar a onda

Uma linha por ticket, atualizada a cada create:

```text
| Ticket | Worktree id | Branch | Terminal handle | PR |
```

- **Worktree id** é o `.result.worktree.id` do create, no formato
  `<repoId>::<path>`. Guarde **inteiro**; o `repoId` sozinho endereça o repo, não
  o worktree.
- **Terminal handle** no caminho padrão sai do envelope do `worktree create`, em
  `.result.agentTerminalHandle`; runtimes antigos devolvem só
  `.result.startupTerminal.handle`, então leia os dois:

  ```bash
  HANDLE=$(jq -r '.result.agentTerminalHandle // .result.startupTerminal.handle // empty' <<<"$CREATE")
  ```

  No caminho de exceção (2b) ele vem do envelope do `terminal create`, com plano
  B em `orca terminal list --worktree "id:<worktreeId>" --json` casando o título
  por `contains`. Handle vazio não é falha do create: recupere pela mesma lista.
  Handles são de escopo de runtime — se o Orca reiniciar, o handle antigo morre e
  tem que ser readquirido.

Opcionalmente, mova a coluna do board com
`orca worktree set --worktree "id:<worktreeId>" --workspace-status in-progress --json`
(ids default: `todo`, `in-progress`, `in-review`, `completed`).

### 5 — Reparent em pé, se a linhagem escapou

Esqueceu o `--parent-worktree` num ticket? Não recrie o worktree e não mate o
agente:

```bash
orca worktree set --worktree "branch:<branch>" --parent-worktree "path:$PARENT" --json
```

É metadado do Orca: não mexe no checkout, não mexe no git, não perturba o agente
que já está trabalhando lá dentro.

### O prompt padrão do worker

Tudo abaixo vai **dentro** do `prompt.md` de todo ticket, junto com a spec. Não é
enfeite: cada regra aqui saiu de uma sessão real que custou caro.

```markdown
# <ticket-id> — <título>

## O que construir
<a spec inteira do ticket: os 12 campos, ou o que existir deles>

## Seu worktree
Branch `<branch>`, cortada de `origin/main` em `<sha>`, em `<path>`.
Trabalhe **só aqui**. Nunca commite em `main`, nunca toque no worktree de outro
ticket. Merge e resolução de conflito não são seus.

## `git stash` é PROIBIDO
O stash é um ref **único, compartilhado por todas as worktrees do repo**. O seu
`git stash` só empilha; quem engole trabalho é o `pop`: ele pega `stash@{0}`,
que pode ser de outro agente rodando em paralelo, aplica na **sua** árvore e
descarta a entrada — a outra frente fica limpa e sem o trabalho dela, e o `pop`
dela leva o seu pelo mesmo caminho. Precisa guardar estado temporário?
`git add -A && git commit -m "wip: ..."` na sua própria branch — é a saída
primária, e nessa forma guarda staged, não staged e arquivo novo; `commit -m`
sozinho leva só o staged e `commit -am` deixa o arquivo novo não rastreado para
trás. Não pega o que está no `.gitignore`, e `.wave/<ticket>/contract.md` está,
então copie o contrato à parte. Ele é seu, é local, e some com um rebase.

Vale igual para você: `git stash pop` e `git stash apply` também são proibidos.
`git stash list` mostra a pilha do repo inteiro, não a sua — um stash que
aparece ali pode ser de outra frente, e o seu `pop` leva o trabalho dela. Não
quer nem o commit `wip:`?
`git add -A && git diff --staged --binary > <arquivo>.patch` fora da árvore
guarda o mesmo estado sem tocar em ref nenhum, com a mesma ressalva do
`.gitignore`. Use essa forma exata: `git diff` sozinho omite o que já está
staged e sai vazio para arquivo novo não rastreado, e sem `--binary` um binário
novo faz o `git apply` recusar o patch inteiro — o patch parece salvo e o
trabalho some. Ele salva e deixa a árvore suja, tudo staged: se você foi buscar
árvore limpa (rebase, pull, build), o round trip é `git reset --hard` depois de
gerar o patch e `git apply <arquivo>.patch` para voltar. O índice não volta —
staged volta não staged, arquivo novo volta como `??` — e o `reset --hard` apaga
os arquivos novos que o `add -A` acabou de indexar: patch ruim aí é trabalho
perdido.

## Baseline antes de mexer
Rode lint/test/build da área **antes** da primeira edição e guarde o resultado.
Falha que já existia **não é sua**: reporte como pré-existente, com o comando e
a saída, e siga. Não conserte sem autorização — isso é scope creep e some com a
autoria do bug. E não trave por causa dela: baseline vermelho é contexto, não
bloqueio.

## Contrato antes do código
Se um tester trabalha esta mesma unidade em paralelo, o contrato vive em
`.wave/<ticket>/contract.md` e é escrito **antes** de qualquer código: assinatura
e tipos do que cruza a fronteira, comportamento de erro, e a lista de cenários
derivada dos acceptance criteria. Assinaturas, tipos e erros são seus; a lista
de cenários é do tester. Mudou o contrato no meio? Edite o arquivo primeiro,
depois o código, e avise. Contrato que só existe no seu código deixa a suíte
paralela provando uma forma que não existe mais.

## Achado fora do escopo: reporte, não conserte
Bug que você tropeçou e não está no seu ticket vira linha no seu relatório e PR
próprio. Uma exceção: é pré-requisito para a sua própria mudança ficar correta
ou reversível — aí conserte e diga por que não dava para esperar.

## Hipótese vai rotulada
Qualquer coisa que você acredita mas não verificou sai prefixada com
`HIPÓTESE:` e o teste que decide. Nunca como fato: quem lê seu relatório
dispara outro agente em cima dele, e hipótese lida como achado vira código
construído e depois revertido.

## Verifique antes de reportar pronto
Editar não é entregar. Rode lint, typecheck, teste e build que o **projeto**
define (leia `package.json`, `Makefile`, `pyproject.toml` — não invente comando).
Se qualquer passo falhar, corrija e **rode tudo de novo desde o começo**: um
passo verde antes do conserto não vale depois dele.

## Sensor de discriminação: prove que a sua verificação sabe falhar
Suíte verde só vale se ela ficar vermelha quando o comportamento quebra. Antes de
reportar pronto, **prove isso** — não afirme.

Tem teste? Injete de 1 a 3 mutações de comportamento na **sua** implementação (≥5
em caminho crítico: dinheiro, autenticação, integridade de dado). Inverta uma
condição, troque um valor de retorno, mude um limite de laço, remova um efeito
colateral que a spec exige. Rode os testes que cobrem o trecho mutado e mostre
cada mutação ficando **vermelha**.

**O estado é descartável, e nunca é o seu worktree.** Materialize o HEAD da sua
branch fora da árvore de trabalho e mute lá:
`D=$(mktemp -d) && git archive HEAD | tar -x -C "$D"`. O `archive` leva só o que
está **rastreado e commitado**, e daí duas consequências: commite antes
(`git add -A && git commit -m "wip: ..."`), senão você muta uma árvore sem o seu
trabalho dentro e o sensor mede o vazio em silêncio; e copie a árvore em vez de
arquivá-la quando a suíte precisar das dependências instaladas. `git stash` não é
alternativa: é proibido, pelo motivo da seção acima.

Não tem o que rodar (skill, prompt, doc, config)? O equivalente é **rodar a sua
própria verificação contra o exemplo que você acabou de escrever**. Check escrito
três linhas abaixo de um exemplo que ele não pega é a falha exata que este
parágrafo existe para impedir.

**Mutante sobrevivente é tarefa de conserto, não observação.** Teste que passa com
o comportamento quebrado não é cobertura: reforce a asserção e rode o sensor de
novo. Seu ticket não fecha com sensor fraco.

A saída do sensor vai no corpo do PR como **evidência**: qual mutação, em que
`path:line`, e qual teste morreu com ela. "Rodei mutação e está tudo certo" é
afirmação, não evidência.

## Teto de iteração por achado
`TETO_POR_ACHADO = 3` — três ciclos correção → re-verificação para o **mesmo**
achado, seja ele um check vermelho seu ou um comentário na revisão do seu PR. O
contador é por achado: cinco achados são cinco orçamentos independentes, e mexer
no A não gasta o do B. Batido o teto naquele achado, **pare** — nos outros você
continua.

**Bater o teto não é falha sua.** É o sinal de que aquele achado precisa de uma
decisão humana: requisito ambíguo, dois consertos válidos com custos diferentes,
causa raiz fora do seu ticket. Insistir além do teto queima contexto e produz
código pior que nenhum.

Ao escalar, entregue **o que aprendeu em cada tentativa** — uma linha por
tentativa, com o que você mudou e o que a re-verificação produziu — e feche com a
melhor hipótese viva e o teste que a decide. "Não consegui" não é relatório.

## Pronto é
<critério verificável — comando + saída esperada, não "está funcionando">

## Nada assinado como IA
Sem `Co-Authored-By`, sem "Generated with", sem marca equivalente — em commit,
PR, título, corpo ou comentário. O autor é o alexdlli.

## Ao terminar
Abra o PR contra `main`, **vincule o PR ao ticket** e **PARE**.

**O vínculo é escrito na abertura do PR, por você** — não depois, não pelo
coordenador, não pelo humano que aperta merge. É a única hora em que quem tem o
contexto do ticket ainda está de pé. Sem ele o trabalho entra na `main` e o
ticket continua aberto, e o próximo plano de ondas lista como pendente o que já
foi entregue.

**Ticket no GitHub Issues:** a palavra-chave de fechamento vai no **corpo** do
PR — `Closes #<n>` —, e quem fecha a issue é o **merge**. Valem `close`,
`closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` e `resolved`,
com caixa alta e dois-pontos opcionais (`CLOSES: #10`). Três detalhes custam o
fechamento inteiro: no **título** não conta, só na descrição; issue de outro
repo vai qualificada, `Closes owner/repo#<n>`; e cada issue quer a sintaxe
repetida — `Closes #10, closes #11`, porque `Closes #10, #11` fecha só a #10.
Nada disso é interpretado se o PR não mirar a branch **default** do repo: contra
outra branch a palavra-chave é ignorada e nem link ela cria.

**Ticket no Linear:** não existe palavra-chave — `Closes ENG-123` no corpo não
fecha nada. O vínculo são dois comandos, na mesma hora:
`orca linear attach --current --url <url-do-pr> --title "PR" --json` anexa o PR
ao issue, e `orca linear status set --current --to "<estado>" --json` move o
status. `--current` usa o issue que o Orca linkou a esta worktree, então não há
id para errar. O `--to` quer o **nome exato do workflow state do time**, que
varia por workspace: liste com `orca linear team states --team <key> --json` em
vez de chutar `"In Review"`. `orca` ausente ou Linear desconectado não vira
palpite: deixe o ticket sem vínculo e **diga isso no relatório**.

**Mover o ticket para revisão também é seu, na abertura do PR**, quando a fonte
tiver esse estado. No Linear é o `status set` acima; no GitHub Issues não existe
estado de revisão, e o PR vinculado é o próprio sinal.

**Você não faz merge. Nunca.** Não rode `gh pr merge`, não mergeie pela UI, não
peça a outro agente que mergeie, não mergeie "porque o CI ficou verde" nem
"porque o review aprovou". Isso vale **mesmo que o comando esteja disponível
para você**: ausência de bloqueio não é permissão. Quem aperta merge é o humano,
e o seu trabalho termina no PR aberto.
```

A última seção não é redundância com o guard. Desde a política **ask-then-merge**,
`Bash(gh pr merge *)` **saiu** do `permissions.deny` — o coordenador pode mergear
pedindo ao Alex no prompt de permissão — e quem barra o worker é só o hook
`guard-destructive`, via o marcador do passo 2a. Uma camada a menos do lado do
worker é exatamente por que esta instrução no prompt pesa mais do que pesava. Não
a encurte, não a resuma, não a mova para o fim de outro parágrafo.

O vínculo com o ticket, na mesma seção, tem camada nenhuma atrás dele: não há
guard, permissão nem CI que perceba um PR que não referencia o ticket. A onda 1
mediu o preço — cinco PRs mergeados, e as issues #4, #5 e #6 continuaram abertas
porque só dois corpos de PR traziam a palavra-chave (L-014 em
[`docs/lessons.md`](../../../docs/lessons.md)). Ele está escrito em **dois
lugares**: a seção `## Ao terminar` do template acima (a única que o worker de
fato lê) e o item 5 de "As cinco decisões que custaram caro" em `docs/waves.md`,
para quem lê o fluxo de fora. Mesma regra de propagação do `git stash` abaixo, e
pelo mesmo motivo.

A seção `git stash` do template duplica de propósito o item 6 das regras
invioláveis: o worker recebe o prompt como arquivo e não carrega esta skill, de
modo que ali a regra precisa estar escrita por inteiro — proibição nominal de
`stash`, `pop` e `apply`, o commit `wip:` como saída primária na forma completa
(`git add -A && git commit -m "wip: ..."`) e o patch também na forma completa
(`git add -A && git diff --staged --binary`), com o round trip que o devolve. A
**fonte** da regra é o item 6, o único lugar onde mora o motivo mecânico
completo (`refs/stash` no git dir comum, e os quatro refs que de fato são
por-worktree). Ela está escrita em
**três lugares**: o item 6 desta skill, a seção do template acima (a única que o
worker de fato lê) e o item 3 de "As cinco decisões que custaram caro", em
`docs/waves.md`, que a enuncia para quem lê o fluxo de fora. Mudou a regra no
item 6? Propague para os outros dois — cópia que diverge em silêncio é pior que
cópia nenhuma.

As seções restantes do template seguem a mesma economia, e cada uma tem **uma**
fonte fora dele, que é onde mora o racional completo:

| Seção do template | Fonte | O que a cópia é |
|---|---|---|
| `## Sensor de discriminação` | `ticket-contract`, seção "O sensor de discriminação" | Lá o sensor é definido como parte do artefato de prova que o ticket declara; aqui é a instrução operacional de quem executa |
| `## Teto de iteração por achado` | `adversarial-review`, seção "Teto de iteração por achado" | Lá o teto governa o ciclo correção → re-revisão que a revisão dispara; aqui é o mesmo teto visto de dentro, pelo worker |

A regra de propagação é a do item 6, pelo mesmo motivo mecânico: **o worker não
carrega skill nenhuma**. O que não estiver no `prompt.md` não existe para ele.
Mudou na fonte, propague para o template; não vale encurtar a cópia até virar um
ponteiro para um arquivo que ele não vai abrir.

### Agente não-default: Codex, ou um modelo específico

`--agent <id>` escolhe **o agente, não o modelo**: ele não aceita `--model` nem
`-c model_reasoning_effort=...`. É esta a situação — junto com o agente que não
está na lista de ids conhecidos — que justifica o caminho de exceção do passo 2b.
Só o `--command` muda:

```text
codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5 -c model_reasoning_effort="xhigh"
```

O resto é o 2b inteiro, sem atalho: handle do envelope, `send --text`, **`read`
para confirmar que o prompt foi submetido** e descarte do shell órfão por
`paneKey`. Repare que o bypass vai escrito à mão: `agentDefaultArgs` só vale no
caminho `--agent`, então aqui o argv é responsabilidade de quem monta a linha.

**Se o CLI local rejeitar o modelo, pare e mostre o erro exato.** O erro está no
próprio terminal: `orca terminal read --terminal "$HANDLE" --json`. Não caia em
outro modelo em silêncio — o humano pediu aquele modelo por um motivo, e um
worker rodando o modelo errado entrega um resultado que ninguém consegue
explicar depois.

### Bypass de permissão: ligado por padrão, e o que isso obriga

O worker roda com `--dangerously-skip-permissions` por padrão. O motivo é
operacional: numa onda de N worktrees ninguém está olhando o terminal de cada
agente, e agente parado num prompt de permissão é agente bloqueado que só é
descoberto horas depois. É **opt-out**, não opt-in.

**Quem liga isso não é a skill, é o Orca.** O argv sai de
`settings.agentDefaultArgs` (`orca-data.json`), cujo default de fábrica é a
constante `YOLO_TUI_AGENT_ARGS` do `app.asar`. O dispatch não passa flag nenhuma
de bypass no caminho padrão, e não existe flag de CLI para desligá-la ali:
desligar num ticket é mexer no setting, ou cair no caminho de exceção 2b e montar
o `--command` à mão.

**A consequência, e é ela que muda o desenho do fluxo:** sob bypass **não existe
prompt de permissão** para barrar nada. Para o worker, o merge não é uma decisão
adiada até alguém aprovar — ele simplesmente roda. Por isso o worker é o único
contexto em que `gh pr merge` continua negado a seco, e por isso o marcador do
passo 2a não é burocracia: sem ele o guard fica calado e, sem prompt atrás,
"calado" quer dizer "executou". Ainda assim **as salvaguardas desta onda não
podem depender só do guard**: "abra o PR e pare" tem que estar escrito, explícito
e inequívoco, no prompt que todo worker recebe — e está, na seção
`## Ao terminar` do template acima. O contexto de subagente, que é onde o worker
executa quase tudo, não foi medido; o texto do prompt é o que não depende dele.

### O que o dispatch nunca faz

- **Nunca mergeia.** No worker, o hook `guard-destructive` nega `gh pr merge`
  literal e envelopado, desde que o marcador do passo 2a exista — e é a única
  camada automática que sobrou ali, porque `Bash(gh pr merge *)` saiu do
  `permissions.deny`. A instrução no prompt do worker continua lá mesmo assim,
  por defesa em camadas. Não existe caminho nesta skill que tente merge, nem
  instrução ao worker para mergear.
- **Nunca dispara duas ondas.** Onda seguinte espera merge humano do que veio
  antes, não aprovação e não CI verde.
- **Nunca commita na `main`** nem edita o worktree de outro ticket.
- **Nunca substitui um ticket ruim por adivinhação.** Ticket sem os campos que
  viram prompt volta para `ticket-contract` antes de virar worktree.

### Acompanhar a onda sem queimar contexto

Polling gera saída enorme e repetida. Delegue ao agente **`wave-monitor`**
(`model: haiku`, só `Read` e `Bash`): ele consulta o estado das branches da onda
e devolve uma tabela compacta. Ele **reporta**; não conserta, não mergeia.

`/wave-status` é a porta de entrada.
