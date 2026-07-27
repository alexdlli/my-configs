# Deteccao de ambiente (Orca / Maestri)

Uma sessao Claude Code pode rodar dentro do [Orca](https://stably.ai), dentro de um terminal do Maestri, ou num terminal comum. O que muda entre eles e acionavel (caminho do worktree, como invocar o CLI do Maestri), mas descobrir isso custa turno de agente. `.claude/hooks/lib/context.mjs` resolve por variavel de ambiente, sem spawnar processo.

Consumo em dois modos:

- **Hook `SessionStart`** — `.claude/hooks/session-context.mjs` injeta no maximo 4 linhas com host + o que e acionavel nele. Em terminal comum nao injeta nada.
- **CLI** — `node ~/.claude/hooks/session-context.mjs --json` imprime o objeto cru, para as skills lerem sem gastar turno. `--verify-account` acrescenta a checagem de conta por identidade git (1 subprocess).

Opt-out da injecao automatica: `CLAUDE_SETUP_SKIP_SESSION_CONTEXT=1`. A invocacao explicita com `--json` continua respondendo — a chave silencia a sessao sem quebrar as skills.

## Sinais

Todos confirmados ao vivo nesta maquina. Nada aqui e inferido de documentacao.

### Orca

| Variavel | Formato | Status |
|---|---|---|
| `TERM_PROGRAM` | `Orca` | confirmado |
| `ORCA_TERMINAL_HANDLE` | `term_<uuid>` | confirmado |
| `ORCA_WORKTREE_ID` | `<repoId>::<absPath>` | confirmado |
| `ORCA_WORKSPACE_ID` | uuid | confirmado |
| `ORCA_AGENT_LAUNCH_TOKEN` | opaco | confirmado |
| `__CFBundleIdentifier` | `com.stablyai.orca` | confirmado |

`ORCA_WORKTREE_ID` da o repo e o caminho do worktree de graca, sem `git rev-parse`. O split e no **primeiro** `::`: o repo id e um uuid e nunca contem o separador, mas um caminho absoluto pode conter. Sem separador, `repoId` e `worktreePath` ficam `null` e o valor cru fica em `worktreeId` — nao se adivinha.

### Maestri

| Variavel | Formato | Status |
|---|---|---|
| `MAESTRI_TERMINAL_ID` | id por terminal | confirmado |
| `MAESTRI_SOCKET` | `$TMPDIR/maestri-<hash>/maestri.sock` | confirmado |
| `MAESTRI_CLI` | `$TMPDIR/maestri-<hash>/maestri` | confirmado |

Sao **so estas tres**. O binario do app carrega outros nomes `MAESTRI_*`, mas eles nao chegam ao terminal.

## Ordem de checagem

1. `MAESTRI_TERMINAL_ID` → `maestri`
2. `ORCA_TERMINAL_HANDLE` ou `TERM_PROGRAM === 'Orca'` → `orca`
3. nenhum → `plain`

Maestri vem primeiro: a var dele e por-terminal (o marcador mais especifico), e um terminal do Maestri pode ser aberto de dentro do Orca, herdando as `ORCA_*`.

## Armadilha: app aberto != estar dentro dele

O socket `$TMPDIR/maestri-*/maestri.sock` existe enquanto o app Maestri estiver vivo — inclusive quando a sessao esta no Orca ou num terminal comum. **Nunca** detectar por presenca de socket, de processo ou de app. So a variavel por-terminal e evidencia.

## Regra do `$MAESTRI_CLI`

`maestri` **nao esta no PATH**. O app injeta o bloco de PATH em `~/.profile` / `~/.bashrc` / config do fish, e o shell aqui e **zsh** — nenhum desses e lido. A mensagem do proprio CLI e canonica:

> Your shell resets PATH. Use `"$MAESTRI_CLI"` instead of `"maestri"`.

Toda invocacao vai por `"$MAESTRI_CLI"` (com aspas — o caminho staged fica sob `$TMPDIR`).

## Conta e tracker

`~/.gitconfig` tem exatamente um `includeIf`: `gitdir:~/work/`. A deteccao usa a mesma regra do git:

| cwd | account | tracker | trackerSource |
|---|---|---|---|
| sob `~/work/` (ou o proprio `~/work`) | `work` | `jira` | `cwd-work` |
| qualquer outro lugar | `unknown` | `null` | `unknown` |

Fora de `~/work/` a deteccao **nao** afirma "pessoal": ali vale a identidade default do git, que tambem cobre `/tmp`, `~/Desktop` e um repo de trabalho clonado no lugar errado. Afirmar `linear` exige evidencia, e ela custa um subprocess — por isso fica fora do caminho quente do hook, atras de `--verify-account`:

```bash
node ~/.claude/hooks/session-context.mjs --verify-account
```

Essa checagem compara o e-mail que o git realmente resolve no cwd (`git config --get user.email`) com a identidade default declarada em `~/.gitconfig` antes do bloco `includeIf`. Iguais → conta pessoal → `linear`; diferentes → conta de trabalho → `jira`; `trackerSource` vira `git-identity`. Nenhum e-mail fica hardcoded no repo.

## Formato retornado

```json
{
  "host": "orca",
  "hostDetail": {
    "terminalHandle": "term_<uuid>",
    "worktreeId": "<repoId>::<absPath>",
    "repoId": "<uuid>",
    "worktreePath": "/Users/alexdlli/Developer/my-configs"
  },
  "tracker": null,
  "trackerSource": "unknown",
  "account": "unknown",
  "repoRoot": "/Users/alexdlli/Developer/my-configs"
}
```

Em `maestri`, `hostDetail` traz `terminalId` e `cliPath`; em `plain` vem vazio. `repoRoot` sai de graca do `ORCA_WORKTREE_ID`; nos outros hosts e `null` (descobrir custaria um `git rev-parse`, que o caminho puro nao faz).

## Testes

```bash
node --test '.claude/hooks/lib/*.test.mjs'
```

`detectContext(env, cwd)` recebe env e cwd por parametro justamente para ser testavel sem mexer no processo.
