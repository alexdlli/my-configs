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
  --parent-worktree "path:<parent>" --base-branch origin/main --issue <n> --json
orca terminal create --worktree "id:<worktreeId>" --title "w<N>-<ticket>" \
  --command 'claude --dangerously-skip-permissions' --json
orca terminal wait --terminal "<handle>" --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal "<handle>" --text "$(cat .wave/<ticket>/prompt.md)" --enter --json
```

São dois passos porque `--agent` não aceita argv extra e o worker roda com
`--dangerously-skip-permissions` **por padrão** — agente parado num prompt de
permissão é agente bloqueado que ninguém está olhando. Para desligar num ticket,
eu peço; é opt-out. O handle sai de `orca terminal list --worktree "id:<worktreeId>" --json`
filtrado pelo `--title`.

Como o bypass é o default, **as salvaguardas não podem depender da camada de
permissão**: confira que o `prompt.md` de cada ticket contém, explícito, o "abra
o PR contra `main` e PARE, você não faz merge nunca" do template. É ele a
garantia, não o `permissions.deny`.

O prompt vai **em arquivo**, nunca colado inline: markdown de vários KB quebra no
escaping do shell, e o modo de falha é um prompt truncado que o agente obedece
como se estivesse completo. Se o ticket consome código de um irmão recém-mergeado,
escreva isso dentro do prompt com todas as letras ("`origin/main` já contém X de
#N — REUSE, não reimplemente").

## 5. Me devolva a tabela da onda

```text
| Ticket | Worktree id | Branch | Terminal handle | PR |
```

Worktree id inteiro (`<repoId>::<path>`). O handle vem do `orca terminal list`
filtrado pelo `--title`; no caminho curto com `--agent`, de
`.result.agentTerminalHandle` com fallback `.result.startupTerminal.handle`.

Esqueceu a linhagem de algum ticket? Não recrie:
`orca worktree set --worktree "branch:<branch>" --parent-worktree "path:<parent>" --json`.

## Nunca

Não mergeie, não peça merge, não instrua o worker a mergear. Não dispare a onda
seguinte. Não commite na `main`. Não entre no worktree de um ticket para
"ajudar" o agente dele.

Depois do disparo, acompanhe com `/wave-status` — não fique lendo `gh` na mão.
