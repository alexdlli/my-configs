# Guard de comandos destrutivos

Hook `PreToolUse` no matcher `Bash` que nega as tres operacoes que o harness reserva para o
humano — `gh pr merge`, `git push --force`, `git commit --no-verify` — **inclusive quando elas
vem envelopadas** em `bash -c`, `sh -c` ou num pipe para shell.

Arquivos: `.claude/hooks/guard-destructive.mjs` (o hook) e `.claude/hooks/lib/destructive.mjs`
(a classificacao pura, testada em `.claude/hooks/lib/destructive.test.mjs`).

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

## As tres camadas

| Camada | O que garante | Onde falha |
|---|---|---|
| `permissions.deny` (`.claude/settings.json`) | barra a forma literal, inclusive sob bypass | e string: nao ve envelope. E grosseira: `Bash(gh pr merge *)` tambem barra `gh pr merge --help` |
| Guard `PreToolUse` (este doc) | barra literal **e** envelope, sob bypass, com mensagem acionavel | roda no cliente: quem controla o cliente desliga |
| **Branch protection no GitHub** | **a unica garantia que nao depende do cliente** | — |

A recomendacao continua sendo a terceira linha: enquanto merge e force-push forem impedidos
apenas por configuracao local, a garantia vale so ate alguem rodar outro cliente. As duas
primeiras camadas existem para que o agente distraido pare antes, com uma explicacao.

## O que ele pega

Formas cobertas das tres regras:

- literal: `gh pr merge 3`, `git push -f origin x`, `git commit --no-verify -m x`
- envelope de shell: `bash -c '...'`, `sh -c`, `zsh -c`, `dash`, `ksh`, `fish`, cluster de flags
  (`bash -lc`, `sh -ec`), caminho absoluto (`/bin/bash -c`)
- prefixo de ambiente: `env FOO=1 bash -c '...'`, `CI=1 bash -c '...'`
- pipe para shell: `echo 'git push --force' | bash`, `printf '%s' '...' | zsh`
- encadeamento: `git status && gh pr merge 3`, `gh pr view 3; gh pr merge 3`
- opcoes globais do git: `git -C /tmp/repo push --force`, `/usr/bin/git commit --no-verify`
- forma curta equivalente: `-f` para push, `-n` para commit (sinonimos exatos, nao ampliacao)

## O que ele deliberadamente NAO pega

Cada linha aqui e escolha, nao esquecimento:

| Nao pega | Por que |
|---|---|
| `$(gh pr merge 3)` e crase | substituicao de comando exige avaliar shell; agente distraido nao escreve isso |
| corpo de heredoc (`cat <<'EOF' ... EOF`) | corpo de heredoc e dado. Este repo escreve docs cheios dessas strings — barrar ali e o falso positivo mais provavel que existe |
| `python -c`, `perl -e`, `xargs` | interpretador que nao e shell; a lista seria infinita |
| `curl url \| bash` | o conteudo nao esta na linha de comando; nao ha o que classificar |
| `git push --force-with-lease` | recusa sobrescrever trabalho que voce nao viu, e e como um agente conserta a propria branch de onda |
| `--help` de qualquer regra | pedir ajuda nao e executar. O `deny` ainda barra `gh pr merge --help`; o guard, nao |
| a string dentro de outro comando | `echo "gh pr merge"`, `grep -rn 'git push --force' docs/`, `git commit -m "por que --no-verify e proibido"` — o comando e `echo`/`grep`/`commit`, e a regra so casa em token exato |
| `env -i bash -c` | `env` seguido de flag propria; `env VAR=1` e o caso real |
| aninhamento acima de 3 envelopes | quem escreve `bash -c "bash -c \"bash -c ...\""` nao esta distraido |

## Comportamento

- **Sempre `exit 0`.** A decisao vai no payload, nunca no codigo de saida.
- **Falha aberta.** Se o proprio guard quebrar, ele escreve o erro em stderr, nao imprime
  decisao nenhuma, e o comando cai de volta na camada de permissao. Negar em erro transformaria
  um bug do guard em Bash morto na sessao inteira.
- **Mensagem acionavel.** A negacao diz qual regra bateu, se veio envelopada, e o que fazer no
  lugar (abrir o PR e parar; pedir ao Alex; consertar o que o hook reportou).
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

O installer nao precisou de mudanca: ele deriva os eventos de hook do proprio
`.claude/settings.json` do harness e reescreve o comando para caminho absoluto. Rodar
`node scripts/install.mjs` e o que ativa o guard em `~/.claude/settings.json`.

## Verificacao

Medido em Claude Code 2.1.220, Node 24.15.0, macOS, 2026-07-27, com
`claude -p --dangerously-skip-permissions --output-format stream-json` num diretorio
descartavel (sem remote, sem trabalho real). O `tool_result` observado:

| Comando tentado | Resultado |
|---|---|
| `git push --force origin scratch-guard-test` | `guard-destructive: blocked "git push --force" (called directly). ...` |
| `bash -c "git push --force origin scratch-guard-test"` | `guard-destructive: blocked "git push --force" (wrapped in a shell). ...` |
| `bash -c "git commit --no-verify -m guard-test"` | `guard-destructive: blocked "git commit --no-verify" (wrapped in a shell). ...` |
| `bash -c "gh pr merge 999999"` | `guard-destructive: blocked "gh pr merge" ...` |
| `git commit -m "docs: explain why --no-verify is banned"` | executou: `1 file changed, 1 insertion(+)` |
| `echo "gh pr merge ..."` | executou, saida normal |
| `gh pr merge --help` | negado pela camada `permissions.deny` (`Permission to use Bash ... has been denied`), **nao** pelo guard — o guard nao imprime decisao para essa forma |

Nenhum comando destrutivo chegou a rodar: o ponto e que o guard barra antes.

## Testes

```bash
node --test '.claude/hooks/lib/*.test.mjs'
```

`classifyCommand(command)` recebe a linha de comando e devolve o veredito — puro, sem processo
e sem disco, exatamente para ser testavel sem sessao. A tabela de "o que nao pega" tem teste
proprio: quando uma dessas linhas mudar de ideia, o teste que a fixa quebra junto.
