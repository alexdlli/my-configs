---
name: wave-orchestration
description: >-
  Planejamento de execução em ondas a partir do grafo de dependências de um
  projeto de tickets. **Opt-in: só carregue quando o usuário pedir ondas ou
  grafo pelo nome** — "plano de ondas", "monta o grafo desse projeto", "quantas
  frentes dá pra tocar em paralelo", "dispara a onda 1", ou o comando
  `/wave-plan`. Tocar várias frentes em paralelo, por si só, **não** é motivo
  para carregar esta skill: isso é o trabalho normal do orquestrador. Lê os
  tickets de GitHub Issues via `gh`, monta o grafo pelas relações reais de
  bloqueio e apresenta as ondas ao humano. Também cobre o disparo **manual** de
  uma onda por vez — uma árvore e um agente por ticket. O merge do PR é do
  humano.
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

1. **O merge do PR é SEMPRE humano.** `gh pr merge` não é seu, dentro ou fora
   de onda, com ou sem CI verde. O output de uma onda "pronta" é o resumo e o
   pedido de aprovação — nunca o comando de merge. (`git merge` numa branch de
   controle — `integration/*`, `wave/*` — é a única exceção, e é do
   coordenador, nunca do worker. Política em `docs/guard-destructive.md`, que é
   a fonte; esta linha é ponteiro, não cópia.)
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

Disparar uma onda é criar **uma árvore de trabalho por ticket** e colocar **um
agente** em cada uma. Planejar é barato; disparar toca o disco, gasta contexto de
verdade e cada erro aqui custa a onda inteira.

**Uma onda por vez.** O humano nomeia qual. Nunca dispare a onda seguinte junto,
nem "as duas primeiras porque a segunda é pequena": a onda seguinte depende de
**merge**, e merge é humano.

**Não existe driver automático em host nenhum.** O disparo é um procedimento
manual em todos eles, e é este. Os passos 1, 2a, 3 e o template do prompt valem
igual nos dois hosts; o que muda é só como a árvore nasce e como o agente entra
nela (passo 2).

### Onde o disparo é possível

`node ~/.claude/hooks/session-context.mjs --json` traz o campo `dispatch`:

| `host` | `dispatch` | Como a árvore nasce |
|---|---|---|
| `maestri` | `available: false`, driver `null` | Topologia nativa: um `floor create` por ticket e um `recruit --floor` em cada, de dentro do terminal do app — e só depois de confirmar **no texto da resposta** que o floor saiu isolado (skill `maestri-orchestration`) |
| `plain` | `available: false`, driver `null` | `git worktree add` por ticket, e o agente aberto à mão em cada árvore |

`available: false` nos dois quer dizer **"não há driver automático"**, não "não dá
para disparar daqui". O que distingue os hosts é a `reason`, e ela nomeia o
procedimento manual daquele host. No dia em que um driver existir, este campo é o
primeiro a mudar — e esta seção junto.

No Maestri o floor **não** é improviso: é isolamento nativo, um clone por ticket.
Mas ele pode sair **simples**, compartilhando o diretório do térreo, e aí a
premissa desta skill (uma árvore por frente) deixa de valer — nesse caso serializa
as frentes num agente só, nunca N agentes sobre o mesmo diretório. Como distinguir
os dois é da `maestri-orchestration`.

### 0 — Resolver o contexto uma vez

O que todo ticket da onda vai precisar, resolvido de uma vez:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
node ~/.claude/hooks/session-context.mjs --json
```

`REPO_ROOT` é de onde as árvores são cortadas e onde o `prompt.md` de cada ticket
é escrito. Do `--json` só o `host` decide alguma coisa, e ele decide **apenas** o
passo 2.

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

### 2 — Uma árvore por ticket

O objetivo é o mesmo nos dois hosts: um checkout próprio por ticket, cortado de
`origin/main`, com **um** agente dentro. Muda o comando.

**`host: maestri` — um floor por ticket.**

```bash
"$MAESTRI_CLI" floor create "w1-issue-3" --branch w1-issue-3
"$MAESTRI_CLI" recruit "W1-3" --preset <preset> --floor "w1-issue-3"
```

Três coisas não se negociam aqui, e as três estão na `maestri-orchestration`:

- **O exit code do `"$MAESTRI_CLI"` não é detector de falha.** Verbo inválido já
  foi medido saindo com **0**. Decida pelo texto da resposta, nunca por `$?`, e
  não rode este trecho sob `set -e` achando que ele protege.
- **Confirme o isolamento no texto**, com os dois marcadores: `isolated clone at`
  no `floor create` e `isolated clone on branch '` no `recruit --floor`. Veio
  `without git isolation` ou `on the ground level`, o floor saiu simples e **não**
  se recruta assim mesmo.
- **`floor create` é irreversível pela CLI** — `floor` é `create|list`, não existe
  verbo de remoção. Uma onda de N tickets deixa N floors que só o humano apaga na
  interface do app, então confirme a onda com ele **antes** do primeiro `create`.

**`host: plain` — um worktree por ticket.**

```bash
git worktree add "../w1-issue-3" -b w1-issue-3 origin/main
```

Aqui não existe linhagem, terminal gerenciado nem vínculo automático com o ticket
— era isso que um gerenciador de worktree dava, e ele não está mais no fluxo. Os
dois substitutos são explícitos e obrigatórios: o **marcador do passo 2a**, que é
o vínculo com o ticket que o guard lê, e a **tabela do passo 4**, que é a linhagem
que sobra. O agente você abre à mão dentro da árvore, com o prompt do passo 3.

**Nunca dois agentes na mesma árvore**, em host nenhum: dois agentes no mesmo
checkout brigam pelos mesmos arquivos e pelo mesmo índice do git.

### 2a — Marcar a árvore como worker, ANTES de subir o agente

**É este passo que impede o worker de mergear. Tirar ele reabre o buraco.**

```bash
WT_PATH=../w1-issue-3   # no Maestri, o caminho do clone que o `floor create` devolveu
BRANCH=w1-issue-3
mkdir -p "$WT_PATH/.wave"
jq -n --arg ticket 3 --arg branch "$BRANCH" --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{ticket: $ticket, branch: $branch, createdAt: $createdAt}' > "$WT_PATH/.wave/worker.json"
```

**Passo obrigatório, imediatamente depois do `jq -n`: confirme o marcador a
partir da árvore-alvo.** `$WT_PATH` é caminho **transcrito à mão** — no Maestri,
lido da prosa de um `floor create` que já foi medido saindo com **0 em falha** —,
e transcrição errada não produz erro nenhum na tela: `mkdir -p` cria o que faltar
e o `jq` escreve feliz num lugar que não é a árvore onde o recruta vai rodar.

```bash
WT_ROOT="$(git -C "$WT_PATH" rev-parse --show-toplevel)" \
  && jq -e . "$WT_ROOT/.wave/worker.json" \
  && echo "MARCADOR CONFIRMADO EM: $WT_ROOT" \
  || echo "PARE: marcador NAO confirmado em $WT_PATH"
```

São duas provas distintas, e nenhuma delas é opcional:

1. **`rev-parse --show-toplevel` prova que `$WT_PATH` é raiz de árvore git — e
   imprime qual.** O comando falha se o caminho não existir ou não estiver num
   repo; se `$WT_PATH` cair dentro de outra árvore, ele imprime a raiz *dela*.
   Por isso o caminho impresso não é enfeite: **`$WT_ROOT` é o que vai para o
   `--floor`/`cd` que sobe o agente e para a tabela do passo 4.** Se o que
   apareceu não for a árvore que você vai abrir, pare — o marcador está numa
   árvore e o agente nasceria noutra. Ao contrário do `"$MAESTRI_CLI"`, **o exit
   code do `git` é detector confiável**, e é por isso que a confirmação se faz com
   `git` e não relendo o texto do `floor create`.
2. **`jq -e` prova que o marcador está lá dentro e é JSON válido**, lido do
   caminho canônico que o `git` acabou de imprimir — não do caminho que você
   digitou. É exatamente o que o hook vai procurar, checado do mesmo jeito.

**Falhou qualquer uma das duas, o agente NÃO sobe.** Conserte `$WT_PATH` (releia
o output do `floor create`, ou `"$MAESTRI_CLI" floor list`), reescreva o marcador,
rode a confirmação de novo. Subir mesmo assim é subir um worker sem guard: sem
marcador na árvore em que ele roda, `detectWorkerContext` devolve `other` e o hook
**não emite veredito nenhum** — `guard-destructive.mjs:74`, `if (context ===
CONTEXT_OTHER) return;`. O `gh pr merge` cai no caminho normal de permissão, que
sob `--dangerously-skip-permissions` é execução direta.

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

Os dois comandos — escrita **e** confirmação — rodam **antes** de o agente subir:
depois de a árvore existir e antes do `recruit --floor` ou de você abrir o agente
no worktree. É a vantagem que o disparo manual tem sobre o driver que existia
antes: a janela entre a árvore nascer e o marcador existir não chega a abrir. Não
a reabra invertendo a ordem — nem pulando a confirmação, que é o que transforma
"escrevi o marcador" em "o marcador está onde o guard vai procurar".

### 3 — O prompt vai em ARQUIVO, sempre

Escreva `.wave/<ticket>/prompt.md` e entregue ao agente o **conteúdo do arquivo**,
sempre lido dele: `"$(cat .wave/<ticket>/prompt.md)"`. **Nunca cole o markdown
direto na linha de comando nem numa mensagem de chat.**

O prompt de um ticket bom tem vários KB de markdown: crase, `$`, `!`, aspas,
bloco de código, comentário HTML. Inline, o shell come parte disso antes de o
comando ver — e o modo de falha não é erro, é um prompt **truncado ou
adulterado** que o agente obedece achando que está completo.

No Maestri o veículo muda e a regra não: no `ask` vai a **instrução curta** mais o
nome da nota (ou o caminho do arquivo) onde está o conteúdo longo, porque o canal
do canvas já foi medido engolindo texto grande sem submeter
(`maestri-orchestration`, "O canal é frágil: instrução curta, conteúdo longo em
nota").

O arquivo também é o que torna o disparo reexecutável: se o agente morrer, o
prompt continua no disco e o reenvio é reler o mesmo arquivo — não remontar o
texto de memória, que é como um reenvio entrega uma spec diferente da primeira.

**Confira o `prompt.md` antes de subir o agente.** São três itens, e são
exatamente os pontos que não têm camada automática atrás:

1. O **"abra o PR contra `main` e PARE, você não mergeia o PR nunca"** da seção
   `## Ao terminar` do template está lá, explícito. Sob bypass não existe prompt
   de permissão para barrar nada.
2. O **vínculo do PR com o ticket** está lá, na forma exata (`Closes #<n>`,
   repetida por issue). Nem deny, nem guard, nem CI enxerga um PR que não
   referencia o ticket.
3. O **`<COMANDO DE SINAL>`** está preenchido com o `ask` real — **ou** o bloco
   do sinal saiu **inteiro**, porque nesta onda não há canal de volta. Inteiro é
   de "**Sinalizar é a última ação deste despacho**" até "**não desista do PR**",
   inclusive; o parágrafo seguinte, "**Você não mergeia o PR. Nunca.**", **fica**
   — e o `git merge` liberado logo abaixo dele também. Cortar menos que isso
   deixa de pé a contenção do sinal apontando para um comando que não está mais
   no prompt. Nada fora do bloco fala em sinalizar, então a remoção não deixa
   palavra órfã na abertura de `## Ao terminar`. Onda plain não ganha canal
   inventado; ganha uma remoção declarada.

**O prompt precisa ser autocontido.** A spec inteira do ticket vai dentro dele —
os 12 campos, ou o que existir deles. O agente da árvore não deve precisar
reabrir o GitHub para saber o que construir: ele nasce sem contexto, e cada ida
ao tracker é uma rodada perdida e um ponto onde ele pode ler o ticket errado.

Se o ticket consome código de um irmão recém-mergeado, diga com todas as letras,
dentro do prompt:

```text
`origin/main` já contém o leitor de issues do GitHub entregue em #12, em
`scripts/waves/tickets-github.mjs`. REUSE — não reimplemente.
```

Sem essa frase o agente encontra o arquivo, não sabe se pode confiar nele, e
reescreve por segurança.

### 4 — Registrar a onda

**Sem gerenciador de worktree, esta tabela é a linhagem da onda** — não é
relatório, é o único lugar onde fica escrito quem está onde. Uma linha por
ticket, atualizada a cada árvore criada:

```text
| Ticket | Caminho da árvore | Branch | Agente (floor ou terminal) | PR |
```

- **Caminho da árvore** é absoluto ou relativo à raiz do repo, e é o que o humano
  usa para entrar nela. No Maestri é o caminho do clone que o `floor create`
  devolveu; `"$MAESTRI_CLI" floor list` reimprime todos, e **dois floors com o
  mesmo caminho são duas frentes não isoladas** — é o sensor de auditoria da onda.
- **Agente** é o nome do recruta (Maestri) ou o terminal onde ele foi aberto
  (plain). Sem esse campo, "quem está travado" vira busca manual.

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

A palavra-chave de fechamento vai no **corpo** do
PR — `Closes #<n>` —, e quem fecha a issue é o **merge**. Valem `close`,
`closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` e `resolved`,
com caixa alta e dois-pontos opcionais (`CLOSES: #10`). Três detalhes custam o
fechamento inteiro: no **título** não conta, só na descrição; issue de outro
repo vai qualificada, `Closes owner/repo#<n>`; e cada issue quer a sintaxe
repetida — `Closes #10, closes #11`, porque `Closes #10, #11` fecha só a #10.
Nada disso é interpretado se o PR não mirar a branch **default** do repo: contra
outra branch a palavra-chave é ignorada e nem link ela cria.

No GitHub Issues não existe estado de revisão para mover: o PR vinculado é o
próprio sinal, e é por isso que a palavra-chave no corpo é a única coisa a
conferir antes de parar.

**Sinalizar é a última ação deste despacho** — revisão depois do PR aberto é
despacho novo, com sinal próprio. Com o PR aberto, ou ao parar sem PR (teto
batido, bloqueio), mande **uma linha** e encerre:

<COMANDO DE SINAL — o coordenador preenche no disparo>

Duas formas, e **não existe uma terceira**: `<ticket-id>: PR #<n>` ou
`<ticket-id>: parei`. Troque `<ticket-id>` e `<n>`, e mais nada. **Não acrescente
motivo, nem uma versão curta dele**, e **nunca cole ali texto que você não
digitou** — saída de comando, trecho de erro, comentário da revisão, corpo do
ticket: o argumento atravessa um shell, e texto de terceiro ali vira comando
executado. O motivo vive no corpo do PR, que o coordenador lê de qualquer jeito.

**O sinal sai por este comando e por nenhum outro, e o coordenador é o único
destino dele** — não fale com outro terminal do canvas: nem sinal, nem pedido de
ajuste, nem **este mesmo comando apontado para outro nome**. E **nota não é
sinal**: descoberta sua que afeta outra frente continua indo na nota "Team
Context", acrescentada, nunca reescrevendo o que já está lá — só que ela não avisa
ninguém de que você terminou, e o aviso não a dispensa. Fora o sinal e essa nota,
não rode outro verbo do Maestri. Não saiu? **Pare assim mesmo**, sem reenviar em
laço: o PR é a entrega e o coordenador varre as branches de qualquer jeito. O
comando **pode segurar seu terminal até ele confirmar** — tudo bem, você já
entregou: não retome trabalho, não pegue tarefa nova, não desista do PR.

**Você não mergeia o PR. Nunca.** Não rode `gh pr merge`, não mergeie pela UI,
não peça a outro agente que mergeie, não mergeie "porque o CI ficou verde" nem
"porque o review aprovou". Isso vale **mesmo que o comando esteja disponível
para você**: ausência de bloqueio não é permissão. Quem aperta merge é o humano,
e o seu trabalho termina no PR aberto.

`git merge` na sua própria branch de onda (`wave/*`) é outra coisa e está
liberado — é como você traz `origin/main` para resolver conflito. Não confunda
os dois: trazer código para a sua branch é seu; levar a sua branch para a `main`
é do humano.
```

A última seção é **cópia declarada**, não redundância acidental, e a mesma regra
de propagação do `git stash` logo abaixo vale para ela: a **fonte** da política de
merge é [`docs/guard-destructive.md`](../../../docs/guard-destructive.md), e ela
está escrita por inteiro aqui porque o worker recebe o prompt como arquivo e **não
carrega esta skill** — um ponteiro, para ele, aponta para nada. Mudou a política
lá, esta cópia muda junto.

Por que ela pesa mais do que pesava: desde a política **ask-then-merge**,
`Bash(gh pr merge *)` **saiu** do `permissions.deny` — o coordenador pode mergear
pedindo ao Alex no prompt de permissão — e quem barra o worker é só o hook
`guard-destructive`, via o marcador do passo 2a. Uma camada a menos do lado do
worker. Não a encurte, não a resuma, não a mova para o fim de outro parágrafo.

O vínculo com o ticket, na mesma seção, tem camada nenhuma atrás dele: não há
guard, permissão nem CI que perceba um PR que não referencia o ticket. A onda 1
mediu o preço — cinco PRs mergeados, e as issues #4, #5 e #6 continuaram abertas
porque só dois corpos de PR traziam a palavra-chave (L-014 em
[`docs/lessons.md`](../../../docs/lessons.md)). Ele está escrito em **três
lugares**: a seção `## Ao terminar` do template acima (a única que o worker de
fato lê), a conferência do `prompt.md` no passo 3, que é o que o coordenador
checa antes de subir o agente, e o item 5 de "As cinco decisões que custaram
caro" em `docs/waves.md`, para quem lê o fluxo de fora. Mesma regra de propagação
do `git stash` abaixo, e pelo mesmo motivo.

O bloco do sinal só entra onde existe canal de volta, e quem o recebe é o mesmo
recruta que recebe o role de `maestri-orchestration` ("Bypass de permissão"):
dois textos, um leitor só. Mudou a gramática aqui, mude lá — cópia que diverge em
silêncio é pior que cópia nenhuma. A frase da nota dentro do bloco é a mesma
propagação em miniatura: a fonte do que a "Team Context" carrega, e de que o
recruta só acrescenta nela, é o "Protocolo das notas" de `maestri-orchestration`
— o bloco a repete porque o worker não carrega skill nenhuma, ele só lê o prompt.

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

A seção `## Sensor de discriminação` segue a mesma economia, e tem **uma** fonte
fora do template, que é onde mora o racional completo:

| Seção do template | Fonte | O que a cópia é |
|---|---|---|
| `## Sensor de discriminação` | `ticket-contract`, seção "O sensor de discriminação" | Lá o sensor é definido como parte do artefato de prova que o ticket declara; aqui é a instrução operacional de quem executa |

`## Teto de iteração por achado` é a exceção: desde que a revisão de duas lentes
saiu do harness, o teto não tem fonte fora — o template **é** a fonte, e não há
cópia para propagar.

A regra de propagação é a do item 6, pelo mesmo motivo mecânico: **o worker não
carrega skill nenhuma**. O que não estiver no `prompt.md` não existe para ele.
Mudou na fonte, propague para o template; não vale encurtar a cópia até virar um
ponteiro para um arquivo que ele não vai abrir.

### Agente não-default: Codex, ou um modelo específico

No disparo manual o argv do agente é **seu**, então trocar de agente ou de modelo
é só mudar o comando que você digita. No Maestri, `recruit` aceita `--preset` (o
caminho documentado, com os nomes vindo de `preset list`) e `--command`, que leva
o argv inteiro:

```text
codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5 -c model_reasoning_effort="xhigh"
```

Nome de preset e de modelo **se listam, não se adivinham** — citar de memória é
como o persona antigo carregou um verbo inexistente por meses
(`maestri-orchestration`, "Recrutar, retargetar, dispensar").

**Se o CLI local rejeitar o modelo, pare e mostre o erro exato.** Não caia em
outro modelo em silêncio — o humano pediu aquele modelo por um motivo, e um
worker rodando o modelo errado entrega um resultado que ninguém consegue
explicar depois.

### Bypass de permissão: ligado por padrão, e o que isso obriga

O worker roda com `--dangerously-skip-permissions` por padrão. O motivo é
operacional: numa onda de N árvores ninguém está olhando o terminal de cada
agente, e agente parado num prompt de permissão é agente bloqueado que só é
descoberto horas depois. É **opt-out**, não opt-in.

**E agora quem liga isso é você.** Não há mais gerenciador injetando o argv por
setting: o bypass entra na linha que sobe o agente — no `--command` do `recruit`,
ou no `claude` que você digita dentro do worktree. Desligar num ticket é só não
escrever a flag; ligar é responsabilidade de quem monta a linha, e esquecer é um
worker que trava no primeiro prompt de permissão sem ninguém olhando.

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

- **Nunca mergeia o PR.** No worker, o hook `guard-destructive` nega
  `gh pr merge` literal e envelopado, desde que o marcador do passo 2a exista
  **na árvore em que o worker roda** — o que só a confirmação do passo 2a prova
  — e é a única camada automática que sobrou ali, porque `Bash(gh pr merge *)`
  saiu do `permissions.deny`. A instrução no prompt do worker continua lá mesmo
  assim, por defesa em camadas. Não existe caminho nesta skill que tente
  `gh pr merge`, nem instrução ao worker para apertá-lo. Política completa (e o
  que o worker **pode** fazer com `git merge` na própria branch):
  [`docs/guard-destructive.md`](../../../docs/guard-destructive.md).
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
