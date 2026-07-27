---
description: Dispara UMA onda do plano — um worktree e um agente por ticket, cortados de origin/main atualizada. Nunca faz merge.
---

Carregue a skill `wave-orchestration` antes de rodar qualquer coisa — a seção
`## Dispatch` é dona do procedimento, do prompt padrão do worker e das regras
invioláveis.

Onda a disparar: `$ARGUMENTS` (número da onda, e o plano ou o escopo de onde ele
sai). Sem argumento, **pergunte qual onda** e não assuma que é a 1.

**Uma onda por invocação.** Nunca dispare a onda seguinte junto: ela depende de
**merge** do que veio antes, e merge é humano. Se o plano tiver cinco ondas, este
comando roda cinco vezes, com o humano entre elas.

## 1. Confirme que dá para disparar daqui

```bash
node ~/.claude/hooks/session-context.mjs --json
```

`dispatch.available: true` (driver `orca-cli`) → siga. `false` → diga o
`dispatch.reason` e **pare**: no Maestri não existe adaptador de onda, e num
terminal comum o disparo é manual. Não improvise com `git worktree` na mão.

## 2. Corte de `origin/main` atualizada

```bash
git fetch origin main
git log origin/main --oneline -1
```

**Obrigatório para toda onda depois da primeira.** Confira que o commit impresso
já contém o merge do bloqueador que liberou esta onda. Se não contiver, **pare e
me avise** — worktree cortado de uma main velha faz o agente reimplementar o que
o irmão já entregou, e isso só aparece no merge.

## 3. Contexto do Orca, uma vez

```bash
orca worktree current --json
```

Confira `.ok` e leia `.result.worktree.repoId` e `.result.worktree.path`. Os dois
são usados em todo ticket da onda: `--repo id:<repoId>` e
`--parent-worktree path:<path>`.

## 4. Um worktree por ticket

Para cada ticket da onda, escreva a spec inteira em `.wave/<ticket>/prompt.md`
junto com o prompt padrão do worker (a skill tem o template) e crie:

```bash
orca worktree create --repo "id:<repoId>" --name "w<N>-<ticket>" \
  --parent-worktree "path:<parent>" --base-branch origin/main --issue <n> \
  --agent claude --prompt "$(cat .wave/<ticket>/prompt.md)" --json
```

**Um comando, não dois.** O `--agent` sobe o agente na primeira aba (nada de
shell órfão) e o `--prompt` viaja no argv de lançamento (nada de `terminal wait`
nem `terminal send`, e portanto nada da corrida de `tui-idle`). O
`--dangerously-skip-permissions` do worker **não vem daqui**: vem do setting
`agentDefaultArgs` do Orca, que já traz o bypass por default de fábrica — é
opt-out, e desligar num ticket é o caminho de exceção da skill (passo 2b), não uma
flag deste comando. O handle sai de `.result.agentTerminalHandle`, com fallback
`.result.startupTerminal.handle`.

Como o bypass é o default, **as salvaguardas não podem depender só da camada de
permissão**: confira que o `prompt.md` de cada ticket contém, explícito, o "abra
o PR contra `main` e PARE, você não faz merge nunca" do template. O
`permissions.deny` sobrevive ao bypass (medido na issue #2) e o hook
`guard-destructive` cobre até a forma envelopada — o texto do prompt é a terceira
camada, não a única.

O prompt vai **em arquivo**, nunca colado inline: markdown de vários KB quebra no
escaping do shell, e o modo de falha é um prompt truncado que o agente obedece
como se estivesse completo. Se o ticket consome código de um irmão recém-mergeado,
escreva isso dentro do prompt com todas as letras ("`origin/main` já contém X de
#N — REUSE, não reimplemente").

## 5. Me devolva a tabela da onda

```text
| Ticket | Worktree id | Branch | Terminal handle | PR |
```

Worktree id inteiro (`<repoId>::<path>`).

Esqueceu a linhagem de algum ticket? Não recrie:
`orca worktree set --worktree "branch:<branch>" --parent-worktree "path:<parent>" --json`.

## Nunca

Não mergeie, não peça merge, não instrua o worker a mergear. Não dispare a onda
seguinte. Não commite na `main`. Não entre no worktree de um ticket para
"ajudar" o agente dele.

Depois do disparo, acompanhe com `/wave-status` — não fique lendo `gh` na mão.
