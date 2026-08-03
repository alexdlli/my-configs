# Deteccao de ambiente (session-context)

Uma sessao Claude Code pode rodar dentro de um terminal do Maestri ou num terminal comum. O que muda entre eles e acionavel (como invocar o CLI do Maestri, o que da pra disparar dali), mas descobrir isso custa turno de agente. `.claude/hooks/lib/context.mjs` resolve por variavel de ambiente, sem spawnar processo.

Consumo em dois modos:

- **Hook `SessionStart`** — `.claude/hooks/session-context.mjs` injeta no maximo 3 linhas com host + o que e acionavel nele. Em terminal comum nao injeta nada.
- **CLI** — `node ~/.claude/hooks/session-context.mjs --json` imprime o objeto cru, para as skills lerem sem gastar turno. `--verify-account` acrescenta a checagem de conta por identidade git (1 subprocess).

Opt-out da injecao automatica: `CLAUDE_SETUP_SKIP_SESSION_CONTEXT=1`. A invocacao explicita com `--json` continua respondendo — a chave silencia a sessao sem quebrar as skills.

## Sinais

Todos confirmados ao vivo nesta maquina. Nada aqui e inferido de documentacao.

| Variavel | Formato | Status |
|---|---|---|
| `MAESTRI_TERMINAL_ID` | id por terminal | confirmado |
| `MAESTRI_SOCKET` | `$TMPDIR/maestri-<hash>/maestri.sock` | confirmado |
| `MAESTRI_CLI` | `$TMPDIR/maestri-<hash>/maestri` | confirmado |

Sao **so estas tres**. O binario do app carrega outros nomes `MAESTRI_*`, mas eles nao chegam ao terminal.

## Ordem de checagem

1. `MAESTRI_TERMINAL_ID` → `maestri`
2. nenhum → `plain`

A variavel e **por terminal**, que e a granularidade que uma sessao precisa: o app pode estar aberto com um terminal dele de um lado e a sessao do outro.

## Armadilha: app aberto != estar dentro dele

O socket `$TMPDIR/maestri-*/maestri.sock` existe enquanto o app Maestri estiver vivo — inclusive quando a sessao esta num terminal comum. **Nunca** detectar por presenca de socket, de processo ou de app. So a variavel por-terminal e evidencia.

A regra do `"$MAESTRI_CLI"` (o binario **nao** esta no PATH em zsh) mora em [`maestri.md`](maestri.md), junto com as outras correcoes conhecidas do persona.

## Conta e tracker

`~/.gitconfig` tem exatamente um `includeIf`: `gitdir:~/work/`. A deteccao usa a mesma regra do git:

| cwd | account | tracker | trackerSource |
|---|---|---|---|
| sob `~/work/` (ou o proprio `~/work`) | `work` | `jira` | `cwd-work` |
| qualquer outro lugar | `unknown` | `null` | `unknown` |

Fora de `~/work/` a deteccao **nao** afirma "pessoal": ali vale a identidade default do git, que tambem cobre `/tmp`, `~/Desktop` e um repo de trabalho clonado no lugar errado. Afirmar o tracker pessoal exige evidencia, e ela custa um subprocess — por isso fica fora do caminho quente do hook, atras de `--verify-account`:

```bash
node ~/.claude/hooks/session-context.mjs --verify-account
```

Essa checagem compara o e-mail que o git realmente resolve no cwd (`git config --get user.email`) com a identidade default declarada em `~/.gitconfig` antes do bloco `includeIf`. Iguais → conta pessoal → `github`; diferentes → conta de trabalho → `jira`. Nenhum e-mail fica hardcoded no repo.

**A resposta sai em `accountCheck`, aninhada — o topo nao muda.** `--verify-account` acrescenta a chave `accountCheck` e nao reescreve `tracker`, `trackerSource` nem `account`: fora de `~/work/` eles continuam `null`/`unknown` mesmo com a flag. Quem quer o tracker le `accountCheck.tracker` (e `accountCheck.trackerSource`, que ai sim vale `git-identity`); reler o `tracker` do topo depois da checagem devolve o mesmo `null` de antes, com um subprocess a mais. Sem e-mail resolvido no cwd ou sem identidade default legivel, `accountCheck.tracker` tambem vem `null` — e so nesse caso a pergunta vai pro usuario.

## Formato retornado

```json
{
  "host": "maestri",
  "hostDetail": {
    "terminalId": "<uuid por terminal>",
    "cliPath": "/var/folders/.../maestri-<hash>/maestri"
  },
  "dispatch": {
    "available": false,
    "driver": null,
    "reason": "<o procedimento manual que substitui o driver neste host>"
  },
  "tracker": null,
  "trackerSource": "unknown",
  "account": "unknown",
  "accountCheck": {
    "email": "<e-mail que o git resolve no cwd>",
    "account": "personal",
    "tracker": "github",
    "trackerSource": "git-identity"
  }
}
```

`accountCheck` **so aparece com `--verify-account`** — sem a flag a chave nao existe. No exemplo ela contradiz o topo de proposito: e exatamente o que sai num repo pessoal fora de `~/work/`, onde o caminho puro nao tem evidencia para afirmar `github` e a checagem tem. O topo nunca e reescrito, entao o valor bom e o de dentro do `accountCheck`.

Em `plain`, `hostDetail` vem vazio. O campo `dispatch` responde **so** "da pra disparar uma onda daqui?": hoje `available` e `false` em todo host, porque nenhum driver automatico existe, e o que muda e a `reason` — ela nomeia o procedimento manual daquele host. Ver [`../waves.md`](../waves.md).

## Testes

```bash
node --test '.claude/hooks/lib/*.test.mjs'
```

`detectContext(env, cwd)` recebe env e cwd por parametro justamente para ser testavel sem mexer no processo.
