# Guard de comandos destrutivos

Hook `PreToolUse` no matcher `Bash` que controla quatro operacoes — `gh pr merge`, `git merge`,
`git push --force`, `git commit --no-verify` — **inclusive quando elas vem envelopadas** em
`bash -c`, `sh -c` ou num pipe para shell.

> **Este doc e o dono da politica de merge.** Agente, skill, comando e prompt de worker
> apontam para ca em vez de reescrever a regra. Onde um deles precisa ser auto-suficiente
> — o prompt do worker, que roda sem carregar skill — a copia e declarada como copia e
> aponta para ca como fonte. Mudou aqui, os pontos de copia mudam junto.

As quatro nao sao controladas igual:

| Regra | Worker de onda | Qualquer outro contexto |
|---|---|---|
| `gh pr merge` | negado | **o guard fica calado** — cai no prompt de permissao normal |
| `git merge` | depende do **destino**, nao do worker: liberado em `integration/*` e `wave/*`, negado em `main`, `master`, `prod`, `staging` | idem |
| `git push --force` | negado | negado |
| `git commit --no-verify` | negado | negado |

Arquivos: `.claude/hooks/guard-destructive.mjs` (o hook Claude Code),
`.claude/hooks/lib/destructive.mjs` (a classificacao pura do comando),
`.claude/hooks/lib/worker-context.mjs` (a deteccao de worker),
`.claude/hooks/lib/merge-destination.mjs` (a resolucao da branch de destino) e
`.opencode/plugin/guard-destructive.js` (o mesmo classificador via
`tool.execute.before` no OpenCode). Testes ao lado de cada um, em
`.claude/hooks/lib/*.test.mjs`; o buraco do `permission.bash` sozinho no OpenCode
esta em `scripts/opencode-bash-c-hole.test.mjs`.

## Por que existe

A medicao da issue #2 respondeu a pergunta que estava aberta e abriu outra:

- `permissions.deny` **sobrevive** ao `--dangerously-skip-permissions`. Os quatro comandos
  negados foram barrados sob bypass. A promessa de `docs/installation.md` se sustenta.
- Mas o `deny` e **casamento de string** contra o comando como foi escrito, e o bypass remove o
  portao de aprovacao que era o backstop dele. Sob bypass, `Bash(gh pr merge *)` barra a forma
  literal e **nao** barra `bash -c "gh pr merge 3"`.

O dispatch de ondas roda os workers com o bypass ligado por padrao (ver `docs/waves.md`), entao
esse furo nao e teorico: e o modo normal de operacao de N agentes sem ninguem olhando o
terminal. Um hook `PreToolUse` devolvendo `permissionDecision: "deny"` continua sendo avaliado
sob bypass — foi medido, nao inferido — e e ele que fecha o envelope.

## Premissa: agente distraido, nao atacante

Isto e uma rede local contra o erro honesto: o agente que resolveu "desbloquear" o proprio
trabalho com um `bash -c`. **Nao** e defesa contra alguem que queira burlar. Base64, `$(...)`,
um one-liner de python — tudo isso passa, de proposito. Perseguir o adversario custaria
precisao, e precisao e o que importa aqui:

> **Falso positivo e pior que falso negativo.** Um guard que barra `gh pr merge --help` ou a
> string dentro de um doc trava trabalho legitimo, todo dia. Um falso negativo custa um comando
> que a branch protection do GitHub ainda recusa.

## Ask-then-merge: a politica de hoje

O Alex decidiu que **o coordenador pode mergear desde que peca a ele**, e que **um worker de onda
nunca pode, aconteca o que acontecer**. Isso obrigou duas mudancas que andam juntas:

1. `Bash(gh pr merge *)` **saiu** do `permissions.deny`. Sem isso o comando morre antes de chegar
   ao prompt, e "pedir ao Alex" nao existe como caminho.
2. O guard passou a distinguir **worker** de **qualquer outro contexto**, e so para a regra de
   merge. Num worker ele nega, como sempre negou. Fora dele **nao imprime decisao nenhuma** e o
   comando segue para o prompt de permissao, onde o Alex aprova ou recusa.

`git push --force` e `git commit --no-verify` **nao mudaram**: seguem negados em todo contexto,
inclusive no do Alex. A politica que mudou foi so a do merge.

### Isto remove uma camada da sessao interativa

Antes, um `gh pr merge` na sessao interativa batia em duas camadas. Agora bate em **zero
automaticas**: o guard se cala e o que resta e o **prompt de permissao** — ou seja, uma decisao
humana em tempo real, no lugar de um bloqueio declarado em arquivo. E menos garantia, e e o preco
combinado da politica. Duas consequencias praticas:

- **Sob `--dangerously-skip-permissions` nao existe prompt.** Numa sessao interativa com o bypass
  ligado, `gh pr merge` fora de um worker simplesmente **roda**. E por isso que o worker — que
  roda com bypass por padrao — e o unico contexto onde o guard continua negando a seco.
- **A garantia que nao depende de cliente nenhum continua sendo branch protection no GitHub.**
  Isso ja valia antes e vale mais agora: tudo nesta pagina roda dentro do cliente, e quem controla
  o cliente desliga.

## As camadas, depois da mudanca

| Camada | O que garante | Onde falha |
|---|---|---|
| `permissions.deny` (`.claude/settings.json`) | barra a forma literal de `git push --force` e `git commit --no-verify`, inclusive sob bypass. **Nao cobre mais merge** | e string: nao ve envelope |
| Guard `PreToolUse` (este doc) | force-push e `--no-verify` em qualquer contexto; `gh pr merge` **so no worker**; `git merge` conforme a branch de destino — literal **e** envelope, sob bypass, com mensagem acionavel | roda no cliente: quem controla o cliente desliga |
| Prompt de permissao | merge fora do worker vira decisao do Alex na hora | **nao existe sob bypass** |
| Instrucao no prompt do worker (`## Ao terminar`) | nao depende de camada de cliente nenhuma | e texto: um agente pode ignorar |
| **Branch protection no GitHub** | **a unica garantia que nao depende do cliente** | — |

A recomendacao continua sendo a ultima linha.

## Autonomia de merge: `git merge` sim, `gh pr merge` nao

O agente **pode** mergear sozinho numa branch de controle. A separacao nao e de confianca, e de
**o que da para verificar sem rede**:

- `git merge` **nao tem argumento de destino**: ele sempre aterrissa no `HEAD` atual. O guard le a
  branch do checkout — duas leituras de arquivo, zero rede — e decide.
- `gh pr merge` nomeia um PR cuja base mora no GitHub. Saber o destino exigiria uma chamada de
  rede dentro de um hook `PreToolUse`, em **todo** comando Bash. Por isso ele continua sempre
  humano, e por nenhum outro motivo.

| Destino do `git merge` | Decisao |
|---|---|
| `integration/*`, `wave/*` | **liberado** — o hook emite `permissionDecision: "allow"` |
| `main`, `master`, `prod`, `staging` | **negado**, por nome |
| qualquer outra branch | guard calado — cai no prompt de permissao |
| destino ilegivel (HEAD destacado, sem ancora, `.git` quebrado) | **negado** |
| `git -C`, `--git-dir`, `--work-tree` | **negado**: apontam para outro repo, e o destino deixa de ser o que esta sessao consegue ler |

**A lista de protegidas e explicita de proposito, nao por omissao.** Uma allowlist que nega `main`
apenas por nao mencionar ela vira permissiva em silencio no dia em que alguem acrescentar um
prefixo — e a branch que um agente nunca pode mergear seria justamente a que parou de ser
nomeada. `PROTECTED_BRANCHES` existe para quebrar um teste quando isso acontecer.

Por que uma branch de controle e diferente: ela existe **para** ser mergeada. Um merge errado ali
se desfaz com um `git reset --hard` numa branch que mais ninguem puxou. O merge para `main`
continua sendo do Alex, e o PR continua sendo o caminho.

`git merge --abort`, `--continue` e `--quit` nao sao merge nenhum: terminam ou desfazem um merge ja
em andamento. Barra-los prenderia um agente no meio de um conflito que o proprio guard deixou
comecar.

### As duas camadas concordam, por caminhos diferentes

No Claude Code o hook **concede**: numa branch de controle ele imprime `permissionDecision: "allow"`,
porque ficar calado ainda custaria um prompt ao Alex e o objetivo da allowlist e exatamente nao
custar.

No OpenCode um plugin **so sabe negar ou sair da frente** — nao existe conceder. Entao a autonomia
vem da camada de permissao ficar quieta: `permission.bash` **nao tem** entrada para `git merge`, e
o `"*": "allow"` cobre o caso. Acrescentar `"git merge *": "ask"` ali passaria a perguntar tambem
nas branches de controle e desfaria a politica — tem teste fixando essa ausencia.

## Como o guard sabe que e um worker

Por um **marcador explicito**, nunca por nome de pasta. O dispatch de ondas escreve
`.wave/worker.json` na raiz de cada worktree de worker (passo 2a da skill
`wave-orchestration`), e o guard sobe procurando por ele. `w1-issue-3` e convencao do dispatch
de hoje e vai mudar; o marcador e o contrato.

So a **presenca** e o fato de **ser JSON valido** contam. Os campos (`ticket`, `branch`,
`createdAt`) sao para o humano que abre o worktree — cada campo que o guard exigisse seria mais
uma forma de ele nao saber responder.

**A busca parte de dois ancoras, e um deles carrega o peso:**

| Sinal | Estavel? | Medido |
|---|---|---|
| `CLAUDE_PROJECT_DIR` (env do processo do hook) | **sim** | continuou no diretorio de abertura da sessao depois de um `cd` |
| `cwd` do payload | nao | acompanha o shell persistente do Bash: um `cd ..` numa chamada move o `cwd` da chamada seguinte |
| `process.cwd()` do hook, `PWD` | nao | mesmo comportamento do `cwd` do payload |

Por isso o ancora load-bearing e o `CLAUDE_PROJECT_DIR`: se a deteccao dependesse so do `cwd`,
um worker que rodasse `cd .. && gh pr merge 3` sairia da propria worktree e deixaria o marcador
para tras. Os dois ancoras sao pesquisados e **qualquer veredito de worker vence**, entao o
`cwd` do payload so consegue adicionar negacoes, nunca remover uma.

De cada ancora, a busca sobe diretorio por diretorio ate a **raiz do repo** (o diretorio que
contem `.git` — diretorio no checkout normal, arquivo numa worktree ligada), inclusive. As
worktrees de onda ficam **dentro** do checkout do coordenador, e subir nunca as alcanca: por isso
o coordenador nao vira worker por ter cinco delas ao lado.

### Falha fechada, e e o inverso do resto do hook

O resto do guard **falha aberto**: qualquer erro dele deixa o comando passar, porque um guard que
nega por causa do proprio bug transforma um typo em Bash morto pela sessao inteira. A deteccao de
worker faz o **oposto**. Quando ela nao consegue responder, o veredito e `indeterminate` e o
merge e **negado**.

Conta como "nao sei", e portanto nega:

- nenhum ancora utilizavel (nem `CLAUDE_PROJECT_DIR` nem `cwd` do payload)
- marcador que existe mas nao pode ser lido
- marcador que existe e nao e JSON valido (inclusive arquivo vazio — escrita truncada)
- qualquer erro inesperado dentro da propria deteccao

**A assimetria e deliberada, nao um descuido a ser "consertado" depois.** Errar para o lado de
bloquear um merge custa uma mensagem ao Alex; errar para o lado de permitir custa um merge que
ninguem aprovou. E e tambem por isso que a deteccao captura os proprios erros em vez de deixa-los
chegar ao `try/catch` de falha-aberta do hook: se ela lancasse, o hook engoliria e liberaria o
merge, que e exatamente o resultado que a regra existe para evitar.

## O que ele pega

Formas cobertas das quatro regras:

- literal: `gh pr merge 3`, `git push -f origin x`, `git commit --no-verify -m x`
- envelope de shell: `bash -c '...'`, `sh -c`, `zsh -c`, `dash`, `ksh`, `fish`, cluster de flags
  (`bash -lc`, `sh -ec`), caminho absoluto (`/bin/bash -c`)
- prefixo de ambiente: `env FOO=1 bash -c '...'`, `CI=1 bash -c '...'`
- pipe para shell: `echo 'git push --force' | bash`, `printf '%s' '...' | zsh`
- encadeamento: `git status && gh pr merge 3`, `gh pr view 3; gh pr merge 3`
- opcoes globais do git: `git -C /tmp/repo push --force`, `/usr/bin/git commit --no-verify`
- forma curta equivalente: `-f` para push, `-n` para commit (sinonimos exatos, nao ampliacao)

Para `gh pr merge`, **todas** essas formas so viram negacao quando o contexto e worker (ou
indeterminado). Para `git merge`, quando o destino e protegido (ou ilegivel). A classificacao do
comando e a mesma nos dois casos; o que muda e o que se faz com ela.

`git merge-base` e `git merge-file` nao sao `git merge`: a regra casa em token exato, entao eles
passam liso.

## O que ele deliberadamente NAO pega

Cada linha aqui e escolha, nao esquecimento:

| Nao pega | Por que |
|---|---|
| `$(gh pr merge 3)` e crase | substituicao de comando exige avaliar shell; agente distraido nao escreve isso |
| corpo de heredoc (`cat <<'EOF' ... EOF`) | corpo de heredoc e dado. Este repo escreve docs cheios dessas strings — barrar ali e o falso positivo mais provavel que existe |
| `python -c`, `perl -e`, `xargs` | interpretador que nao e shell; a lista seria infinita |
| `curl url \| bash` | o conteudo nao esta na linha de comando; nao ha o que classificar |
| `git push --force-with-lease` | recusa sobrescrever trabalho que voce nao viu, e e como um agente conserta a propria branch de onda |
| `--help` de qualquer regra | pedir ajuda nao e executar. Com `Bash(gh pr merge *)` fora do `deny`, `gh pr merge --help` agora passa liso — antes o deny o barrava por ser grosseiro demais |
| a string dentro de outro comando | `echo "gh pr merge"`, `grep -rn 'git push --force' docs/`, `git commit -m "por que --no-verify e proibido"` — o comando e `echo`/`grep`/`commit`, e a regra so casa em token exato |
| `env -i bash -c` | `env` seguido de flag propria; `env VAR=1` e o caso real |
| aninhamento acima de 3 envelopes | quem escreve `bash -c "bash -c \"bash -c ...\""` nao esta distraido |

## Comportamento

- **Sempre `exit 0`.** A decisao vai no payload, nunca no codigo de saida.
- **Falha aberta, com uma excecao nomeada.** Se o proprio guard quebrar, ele escreve o erro em
  stderr, nao imprime decisao nenhuma, e o comando cai de volta na camada de permissao. Negar em
  erro transformaria um bug do guard em Bash morto na sessao inteira. A excecao e a deteccao de
  worker, que falha **fechada** — ver a secao acima.
- **Silencio e uma decisao.** Merge fora de worker nao produz saida nenhuma: e assim que ele
  chega ao prompt de permissao. Nao confunda com o guard estar desligado.
- **Mensagem acionavel.** A negacao diz qual regra bateu, se veio envelopada, e o que fazer no
  lugar (abrir o PR e parar; pedir ao Alex; consertar o que o hook reportou). Quando a negacao
  vem de indeterminacao, a mensagem diz isso em vez de afirmar que a sessao e um worker.
- **A mensagem nao menciona o opt-out.** O agente que esta sendo barrado nao e quem decide que o
  guard devia estar desligado.

## Como desligar

```bash
export CLAUDE_SETUP_SKIP_GUARD_DESTRUCTIVE=1
```

Mesmo padrao dos outros hooks do harness (`CLAUDE_SETUP_SKIP_ORCH_REMINDER`,
`CLAUDE_SETUP_SKIP_SESSION_CONTEXT`). Vale para a sessao onde foi exportado.

## Registro

```json
"PreToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      { "type": "command", "command": "node .claude/hooks/guard-destructive.mjs", "timeout": 5 }
    ]
  }
]
```

Para registrar o hook o installer nunca precisou de mudanca: ele deriva os eventos do proprio
`.claude/settings.json` do harness e reescreve o comando para caminho absoluto. Rodar
`node scripts/install.mjs` e o que ativa o guard em `~/.claude/settings.json`.

**Tirar `Bash(gh pr merge *)` do `deny`, porem, exigiu.** O merge de permissoes so sabia
acrescentar, entao a entrada removida do harness continuava instalada para sempre em qualquer
maquina com instalacao anterior — e enquanto ela estivesse la o comando morria antes do prompt e
a politica nao existia na pratica. O installer agora **retrai** as entradas que ele proprio
registrou em `~/.claude/.my-configs-managed.json` e que o harness nao declara mais. Uma regra que
o Alex escreveu a mao nunca e tocada, mesmo escrita igualzinha a uma das nossas: o criterio e a
metadata, nao o texto da entrada.

Depois de qualquer mudanca no `deny`, rode `node scripts/install.mjs` e confira:

```bash
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json","utf8")).permissions.deny)'
```

## Verificacao

Medido em Claude Code 2.1.220, Node 24.15.0, macOS, 2026-07-27, com
`claude -p --dangerously-skip-permissions --output-format stream-json` num repo descartavel
criado por `mktemp -d`, **sem remote nenhum** — mais uma worktree de verdade
(`git worktree add`) para o contexto de worker. O `tool_result` literal observado:

**Contexto de worker** (`.wave/worker.json` presente na raiz da worktree):

| Comando tentado | `tool_result` |
|---|---|
| `gh pr merge 999999` | `guard-destructive: blocked "gh pr merge" (called directly). A wave worker never merges...` |
| `bash -c "gh pr merge 999999"` | `guard-destructive: blocked "gh pr merge" (wrapped in a shell). A wave worker never merges...` |
| `git push --force origin main` | `guard-destructive: blocked "git push --force" (called directly). ...` |
| `bash -c "git push --force origin main"` | `guard-destructive: blocked "git push --force" (wrapped in a shell). ...` |
| `git commit --no-verify -m x` | `guard-destructive: blocked "git commit --no-verify" (called directly). ...` |
| `bash -c "git commit --no-verify -m x"` | `guard-destructive: blocked "git commit --no-verify" (wrapped in a shell). ...` |

**Contexto normal** (mesmo repo, sem marcador):

| Comando tentado | `tool_result` |
|---|---|
| `gh pr merge 999999` | `Exit code 1 / no git remotes found` — **o `gh` respondeu**, ou seja o guard nao negou e o `deny` tambem nao |
| `bash -c "gh pr merge 999999"` | `Exit code 1 / no git remotes found` — idem, envelopado |
| `git push --force origin main` | `guard-destructive: blocked "git push --force" (called directly). ...` |
| `bash -c "git push --force origin main"` | `guard-destructive: blocked "git push --force" (wrapped in a shell). ...` |
| `git commit --no-verify -m x` | `guard-destructive: blocked "git commit --no-verify" (called directly). ...` |
| `bash -c "git commit --no-verify -m x"` | `guard-destructive: blocked "git commit --no-verify" (wrapped in a shell). ...` |

As duas linhas de merge do contexto normal sao o ponto da mudanca: o comando chegou ao `gh`, que
falhou por conta propria. Sob `-p` nao da para exercitar o prompt de permissao, entao o que se
prova ali e que **o guard nao emite `permissionDecision: "deny"`** — confirmado tambem alimentando
o payload direto no hook: stdout vazio, `exit 0`.

**Contexto indeterminado**, com o marcador truncado (`{"ticket":"9",`) e com payload sem ancora
nenhuma, alimentado direto no hook instalado:

```text
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"guard-destructive: blocked \"gh pr merge\" (called directly).
 The guard could not tell whether this session is a wave worker, and it denies the merge
 when it cannot tell. Report it and let Alex merge."}}
```

Nenhum comando destrutivo chegou a rodar.

## Testes

```bash
node --test '.claude/hooks/lib/*.test.mjs'
```

`classifyCommand(command)` recebe a linha de comando e devolve o veredito — puro, sem processo
e sem disco, exatamente para ser testavel sem sessao. A tabela de "o que nao pega" tem teste
proprio: quando uma dessas linhas mudar de ideia, o teste que a fixa quebra junto.

`detectWorkerContext(env, cwd)` toca o disco por definicao, entao o teste dela monta arvores
reais em `mkdtemp`: worktree com marcador, marcador truncado, marcador ilegivel, marcador acima
da raiz do repo, e o caso do worker que deu `cd` para fora. Os tres vereditos — `worker`,
`other`, `indeterminate` — tem teste cada um, porque confundir `indeterminate` com `other` e
exatamente o bug que liberaria um merge.

`classifyMergeDestination(env, cwd)` idem, e o teste dela monta a arvore que importa: worktrees
ligadas de verdade, cada uma com o proprio `HEAD` sob `.git/worktrees/<nome>`. E o caso que decide
se o guard le a branch do worker ou a do checkout de onde ele foi cortado — ler a errada
liberaria um merge para `main` achando que era `wave/3`. Tem teste tambem para HEAD destacado e
para ancoras que discordam entre si.

`guard-destructive.test.mjs` roda o **hook como processo**, do jeito que o Claude Code roda, porque
a decisao que **concede** permissao nao existe dentro de nenhuma funcao pura: so aparece no
stdout do hook. Um teste de unidade nunca a veria.

### O CI nao afirma a garantia, ele a executa

O step de install de `.github/workflows/ci.yml` instala o harness num `$HOME` descartavel, confere
que `guard-destructive.mjs` esta registrado no `PreToolUse` do `settings.json` **instalado**, e
entao roda **o hook instalado** com um payload de `gh pr merge` em dois repos de mentira — um com
`.wave/worker.json`, outro sem — exigindo `permissionDecision: "deny"` no primeiro e **silencio** no
segundo.

Isso substitui a assercao antiga de que `Bash(gh pr merge *)` estava no `deny`, que virou falsa com
a ask-then-merge e deixava o CI vermelho. A garantia mudou de camada e a verificacao mecanica foi
junto: os dois vereditos sao checados porque um guard que negasse em todo contexto passaria num
teste de "ele nega?" enquanto matava o prompt de permissao em que a politica se apoia.
