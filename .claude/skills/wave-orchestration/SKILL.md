---
name: wave-orchestration
description: >-
  Planejamento de execução em ondas a partir do grafo de dependências de um
  projeto de tickets. Use quando o usuário pedir "plano de ondas", "quantas
  frentes dá pra tocar em paralelo", "o que dá pra começar agora", "monta o
  grafo desse projeto", ou ao orquestrar várias frentes com marcos de
  sincronização. Lê os tickets de uma de duas fontes — projeto no Linear via
  `orca linear`, ou GitHub Issues via `gh` — monta o grafo pelas relações reais
  de bloqueio e apresenta as ondas ao humano. Também dispara **uma** onda por
  vez em worktrees do Orca — um worktree e um agente por ticket — quando o
  usuário pedir "dispara a onda 1", "roda essa onda", "abre os worktrees".
  Nunca faz merge: isso é do humano.
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

Onde a aresta mora depende da fonte: no Linear, na relação "blocked by"; no
GitHub, na dependência nativa da issue **ou** no marcador `<!-- blocked-by: ...
-->` no corpo. Nos dois casos ela é declarada, nunca inferida.

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

### Escolher a fonte

**O `graph.mjs` é agnóstico de fonte.** Ele consome o formato normalizado e não
sabe de onde veio. Só o primeiro passo muda:

| Fonte | Leitor | Recorte |
|---|---|---|
| Linear (pessoal) | `tickets-linear.mjs` | O projeto (URL ou nome) |
| GitHub Issues | `tickets-github.mjs` | `--repo` obrigatório, `--milestone`/`--label` opcionais |

Como escolher, nesta ordem:

1. **O usuário disse.** "plano de ondas do milestone 7" ou uma URL do Linear
   resolve sozinho.
2. **O tracker do repo**, por `node ~/.claude/hooks/session-context.mjs --json`
   (campos `tracker` e `trackerSource`). Nunca adivinhe pelo nome do repo.
3. **Na dúvida, pergunte.** Rodar o leitor errado devolve "projeto não
   encontrado" ou um plano do repo inteiro — os dois custam uma rodada.

Jira não tem leitor: lá a leitura é via agente `atlassian`, e não existe pipeline
automatizado de ondas.

### Linear

```bash
node ~/.claude/harness/scripts/waves/tickets-linear.mjs "<projeto>" --json > /tmp/wave-tickets.json
node ~/.claude/harness/scripts/waves/graph.mjs --json < /tmp/wave-tickets.json
```

`<projeto>` é a URL ou o nome do projeto no Linear. O leitor distingue CLI
ausente (3), app Orca fora do ar (4), Linear desconectado (5), projeto não
encontrado ou ambíguo (6) e erro do `orca` (7).

### GitHub Issues

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
motivo — nenhum dos dois leitores emite array vazio como sucesso, e leitura
legítima de zero tickets vem anunciada no stderr.

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
| `maestri` | `available: false` | Não existe adaptador de onda para o Maestri, e a CLI dele só existe como `$MAESTRI_CLI` dentro do terminal do app. Diga isso e pare |
| `plain` | `available: false` | Sem gerenciador de worktree na sessão: entregue o plano e o humano dispara |

Fora do Orca a entrega da skill continua sendo o **plano**. Não improvise
substituto com `git worktree` na mão: o que o Orca dá aqui não é o checkout, é a
linhagem, o terminal gerenciado e o vínculo com o ticket.

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

O worker roda com `--dangerously-skip-permissions` por padrão (ver
`### Bypass de permissão` adiante), e `--agent <id>` **não aceita argv extra** —
ele sobe o agente conhecido sem flags. Por isso o caminho padrão tem dois
passos: cria o worktree, sobe o CLI com o argv que você quer, espera o TUI ficar
pronto e manda o prompt.

```bash
NEW=$(orca worktree create \
  --repo "id:$REPO_ID" \
  --name w1-issue-3 \
  --parent-worktree "path:$PARENT" \
  --base-branch origin/main \
  --issue 3 \
  --json)
WT_ID=$(jq -r '.result.worktree.id' <<<"$NEW")

TERM=$(orca terminal create --worktree "id:$WT_ID" --title w1-issue-3 \
  --command 'claude --dangerously-skip-permissions' --json)
HANDLE=$(jq -r '.result.terminal.handle // .result.handle // empty' <<<"$TERM")
[ -n "$HANDLE" ] || HANDLE=$(orca terminal list --worktree "id:$WT_ID" --json \
  | jq -r '.result.terminals[] | select(.title | contains("w1-issue-3")) | .handle')

orca terminal wait --terminal "$HANDLE" --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal "$HANDLE" --text "$(cat .wave/3/prompt.md)" --enter --json
```

| Flag | Por quê |
|---|---|
| `--repo id:$REPO_ID` | Explícito. Sem ele o Orca infere o repo do cwd, e o cwd de um loop de N tickets não é confiável |
| `--name` | Prefixo da onda + ticket (`w1-issue-3`). É o que a tabela da onda e o `orca worktree list` mostram |
| `--parent-worktree path:$PARENT` | Linhagem: os worktrees da onda são **filhos** do worktree atual, não irmãos soltos |
| `--base-branch origin/main` | O corte. Depende do passo 1 ter rodado |
| `--issue <n>` / `--linear-issue <id\|url>` | Vincula o worktree ao ticket. GitHub usa `--issue`, Linear usa `--linear-issue` |
| `--setup` | `inherit` é o default. Passe `--setup run` quando o ticket precisa das deps instaladas para rodar teste |
| `--title` no `terminal create` | O mesmo nome do worktree. É o que distingue o terminal do agente do shell de fallback, e o plano B para reachar o handle |

Três detalhes que fazem esse caminho falhar em silêncio:

- **`wait --for tui-idle` não é opcional.** Texto mandado para um TUI que ainda
  está subindo é perdido, e a perda é silenciosa: o terminal fica lá, vazio,
  parecendo um agente pensando. Sempre com `--timeout-ms`.
- **Pegue o handle logo depois do `terminal create`, e case o título por
  `contains`, nunca por igualdade.** Um agente TUI reescreve o próprio título da
  aba assim que sobe — um `w1-issue-3` vira algo como `⠐ w1-issue-3` ou o nome
  que o agente escolher. Comparação exata funciona no primeiro segundo e para de
  funcionar depois, que é o pior tipo de bug para depurar às cegas.
- **Sem `--agent`, o create abre um shell de fallback** quando o repo não tem
  terminal default configurado. Mire só no handle do agente, e só feche o outro
  depois que `orca terminal list` confirmar que ele é um shell sem uso.

Não passe `--activate` num loop de N tickets: cada `--activate` rouba o foco do
app e o humano perde o lugar N vezes.

**Caminho curto**, para quando o humano desligou o bypass naquele ticket e
nenhum argv é necessário — um comando só, agente no primeiro terminal:

```bash
orca worktree create --repo "id:$REPO_ID" --name w1-issue-3 \
  --parent-worktree "path:$PARENT" --base-branch origin/main --issue 3 \
  --agent claude --prompt "$(cat .wave/3/prompt.md)" --json
```

Ids de agente conhecidos: `claude`, `codex`, e os outros TUIs instalados. Com
`--agent`, **não** crie um segundo terminal com o mesmo agente depois: ele já
está no primeiro, e um segundo é um agente duplicado no mesmo checkout brigando
pelos mesmos arquivos.

### 3 — O prompt vai em ARQUIVO, sempre

Escreva `.wave/<ticket>/prompt.md` e passe o **conteúdo do arquivo**:
`--text "$(cat .wave/<ticket>/prompt.md)"` no `terminal send`, ou
`--prompt "$(cat .wave/<ticket>/prompt.md)"` no caminho curto.
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
- **Terminal handle** no caminho padrão vem do envelope do `terminal create`,
  com plano B em `orca terminal list --worktree "id:<worktreeId>" --json` casando
  o título por `contains`. No caminho curto (`--agent`) ele sai do envelope do
  `worktree create`, em `.result.agentTerminalHandle`;
  runtimes antigos devolvem só `.result.startupTerminal.handle`, então leia os
  dois:

  ```bash
  HANDLE=$(jq -r '.result.agentTerminalHandle // .result.startupTerminal.handle // empty' <<<"$CREATE")
  ```

  Handle vazio não é falha do create: recupere pela mesma lista. Handles são de
  escopo de runtime — se o Orca reiniciar, o handle antigo morre e tem que ser
  readquirido.

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

## Pronto é
<critério verificável — comando + saída esperada, não "está funcionando">
Teto de tentativas: <N>. Batendo o teto, **pare** e reporte o que aprendeu:
o que tentou, o que cada tentativa produziu, e qual é a sua melhor hipótese.
Insistir além disso queima contexto e produz código pior que nenhum.

## Nada assinado como IA
Sem `Co-Authored-By`, sem "Generated with", sem marca equivalente — em commit,
PR, título, corpo ou comentário. O autor é o alexdlli.

## Ao terminar
Abra o PR contra `main` e **PARE**.

**Você não faz merge. Nunca.** Não rode `gh pr merge`, não mergeie pela UI, não
peça a outro agente que mergeie, não mergeie "porque o CI ficou verde" nem
"porque o review aprovou". Isso vale **mesmo que o comando esteja disponível
para você**: ausência de bloqueio não é permissão. Quem aperta merge é o humano,
e o seu trabalho termina no PR aberto.
```

A última seção não é redundância com o `permissions.deny` do harness. O deny
sobrevive ao bypass (medido, issue #2), mas é casamento de string: barra
`gh pr merge 3` e não enxerga `bash -c "gh pr merge 3"`. O hook
`guard-destructive` fecha esse envelope, e esta instrução é a camada que não
depende de nenhum dos dois. Não a encurte, não a resuma, não a mova para o fim
de outro parágrafo.

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
worker de fato lê) e o item 3 de "As quatro decisões que custaram caro", em
`docs/waves.md`, que a enuncia para quem lê o fluxo de fora. Mudou a regra no
item 6? Propague para os outros dois — cópia que diverge em silêncio é pior que
cópia nenhuma.

### Agente não-default: Codex, ou um modelo específico

`--agent <id>` escolhe **o agente, não o modelo**: ele não aceita `--model` nem
`-c model_reasoning_effort=...`. Mas isso não exige caminho novo — é o caminho
padrão do passo 2, trocando só o `--command`:

```bash
orca terminal create --worktree "id:$WT_ID" --title w1-issue-3 \
  --command 'codex --model gpt-5.5 -c model_reasoning_effort="xhigh"' --json
```

O resto (`terminal list` pelo `--title`, `wait --for tui-idle`, `send --text`) é
idêntico.

**Se o CLI local rejeitar o modelo, pare e mostre o erro exato.** O erro está no
próprio terminal: `orca terminal read --terminal "$HANDLE" --json`. Não caia em
outro modelo em silêncio — o humano pediu aquele modelo por um motivo, e um
worker rodando o modelo errado entrega um resultado que ninguém consegue
explicar depois.

### Bypass de permissão: ligado por padrão, e o que isso obriga

O worker roda com `--dangerously-skip-permissions` por padrão. O motivo é
operacional: numa onda de N worktrees ninguém está olhando o terminal de cada
agente, e agente parado num prompt de permissão é agente bloqueado que só é
descoberto horas depois. Para desligar num ticket específico, o humano pede — é
**opt-out**, não opt-in.

**A consequência, e é ela que muda o desenho do fluxo:** medido na issue #2 de
`alexdlli/my-configs` (fechada), o `permissions.deny` declarado em arquivo
continua valendo sob bypass — mas é casamento de string e não enxerga
`bash -c "gh pr merge 3"`, e o hook `guard-destructive` existe justamente para
barrar as duas formas. Ainda assim **as salvaguardas desta onda não podem
depender só da camada de permissão**: "abra o PR e pare" tem que estar escrito,
explícito e inequívoco, no prompt que todo worker recebe — e está, na seção
`## Ao terminar` do template acima. O contexto de subagente, que é onde o worker
executa quase tudo, não foi medido; o texto do prompt é o que não depende dele.

### O que o dispatch nunca faz

- **Nunca mergeia.** `Bash(gh pr merge *)` está no `permissions.deny` do harness e
  o hook `guard-destructive` pega até a forma envelopada — as duas camadas foram
  medidas sob bypass. A instrução no prompt do worker continua lá mesmo assim,
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
