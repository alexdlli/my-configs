# Uso

Guia de consulta: o que o harness faz sozinho, o que você digita, e o que dispara sem
comando nenhum. Arquitetura e roster em [`agent-system.md`](agent-system.md); instalação em
[`installation.md`](installation.md).

## 1. Onde isso roda

O harness mora em `~/.claude/` por symlink (`~/.claude/{harness,agents,hooks}`,
mais um link por skill). Logo: **vale em toda sessão do Claude Code, em qualquer pasta** —
não só dentro deste repo. O Maestri não instala nada e não é requisito; é só o terminal onde a
sessão nasceu.

O host é detectado por variável de ambiente, nunca por processo ou socket aberto
(`node ~/.claude/hooks/session-context.mjs --json` imprime o objeto cru). Sinais e formato em
[`integrations/session-context.md`](integrations/session-context.md).

| Host | Detectado por | O que muda |
|---|---|---|
| Maestri | `MAESTRI_TERMINAL_ID` | Injeta o aviso de que `maestri` **não está no PATH** em zsh: toda invocação vai por `"$MAESTRI_CLI"`. Frentes paralelas têm topologia nativa (`floor create` + `recruit --floor`), e o `qa` prova a entrega num portal do canvas em vez do argent |
| Terminal comum | a variável ausente | Nada. Frente paralela vira `git worktree` cortado à mão, e o `qa` usa o argent |

Agentes, skills e hooks são idênticos nos dois. **Nenhum dos dois tem dispatch
automático** — `dispatch.available` é `false` em ambos e o driver não existe; o que o campo
carrega é a `reason`, que nomeia o procedimento manual daquele host.

## 2. O que acontece sem eu pedir

Quatro hooks, ligados por `.claude/settings.json`. Nenhum bloqueia a sessão: todo caminho de
falha sai com 0.

| Hook | Evento | O que faz | Desligar |
|---|---|---|---|
| `.claude/hooks/auto-update.mjs` | SessionStart (`startup`/`resume`/`clear`) | Fast-forward do checkout do harness. Throttle de 6h por cache; só age em `main`, com árvore limpa, e só fast-forward. Se o diff tocou skills, `settings.json` ou o installer, **sugere** re-rodar o installer — nunca roda | `CLAUDE_SETUP_SKIP_AUTOUPDATE=1` (também se auto-pula quando `CI` está setado) |
| `.claude/hooks/session-context.mjs` | SessionStart (mesmos gatilhos) | Injeta no máximo 4 linhas: host, o que é acionável nele, tracker. Em terminal comum não injeta nada | `CLAUDE_SETUP_SKIP_SESSION_CONTEXT=1` (o `--json` explícito continua respondendo) |
| `.claude/hooks/preserve-orchestrator.mjs` | PreCompact (`auto` e `manual`) | Preserva a identidade de orquestrador através da compactação, que costuma comer o enquadramento de coordenador | `CLAUDE_SETUP_SKIP_ORCH_REMINDER=1` |
| `.claude/hooks/guard-destructive.mjs` | PreToolUse (matcher `Bash`) | Nega comandos destrutivos, inclusive embrulhados em `bash -c` ou canalizados para shell — que é o que `permissions.deny` não enxerga | `CLAUDE_SETUP_SKIP_GUARD_DESTRUCTIVE=1` |

O guard não trata os três comandos igual:

| Comando | Onde é negado |
|---|---|
| `git push --force` | Em todo contexto, sem exceção — e em duas camadas: `permissions.deny` e o hook |
| `git commit --no-verify` | Em todo contexto, sem exceção — mesmas duas camadas |
| `gh pr merge` | **Só em worker**, identificado pelo marcador `.wave/worker.json`. Fora dele o hook fica calado e o comando cai no prompt de permissão, que é onde você aprova o merge — **mas com `--dangerously-skip-permissions` não existe prompt nenhum atrás**, e aí "calado" quer dizer "executou" |

Leia a linha do `gh pr merge` inteira antes de confiar nela: ele **saiu** do `permissions.deny`
pela política ask-then-merge, então a única coisa que o nega é o hook, e só em worker. Nenhum
procedimento do harness escreve `.wave/worker.json` hoje — quem dispara um worker escreve na
mão. Sob bypass e fora de worker, `gh pr merge` roda sem camada nenhuma; a garantia que não
depende deste cliente continua sendo branch protection no GitHub.

Ele falha aberto em erro interno (guard que nega por bug próprio mata o Bash da sessão). A
exceção deliberada é não conseguir dizer se a sessão é worker: aí nega. Detalhes e o que ele
de propósito **não** pega em [`guard-destructive.md`](guard-destructive.md).

## 3. O que eu digito

**Nenhum slash command.** O harness tinha três (`/sync-harness`, `/ticket-new`,
`/pr-babysit`) e nenhum deles foi invocado uma única vez em 259 transcripts de sessão
medidos, então saíram — estão na tag `pre-lean-cut`. O que eles faziam continua acessível:

| Em vez de | Digite |
|---|---|
| `/pr-babysit <n>` | "leva o PR `<n>` até review-ready" — a skill `pr-babysitting` carrega pelo nome ou pela situação |
| `/sync-harness` | `node ~/.claude/hooks/auto-update.mjs --force` — ignora só o throttle de 6h, todas as outras checagens continuam valendo |
| `/ticket-new` | nada: o pipeline de tickets saiu junto |

Skill nova exige re-rodar o installer, porque skills são linkadas uma a uma.

## 4. O que roda sozinho por descrição

Não existe tabela de rotas. O `description:` do frontmatter de cada agente e de cada skill é
o que o Claude lê para decidir quem acordar. Falar a frase certa basta.

| Frase | O que acorda |
|---|---|
| "o CI falhou" / "por que o check está vermelho" / "responder o review" | Skill `pr-babysitting`, que delega a classificação das threads ao agente `pr-triage` |
| "onde está definido X?" / "o que chama Y?" / "mapeia esse diretório" | Agente `cavecrew-investigator` (tabela `file:line`, saída comprimida) |
| "valida essa task contra PROJ-123" / qualquer URL `*.atlassian.net` | Agente `atlassian` — o único com acesso MCP, e só em sinal explícito |

Se o agente errado (ou nenhum) acordar, o conserto é editar o `description:` dele, não
inventar um roteador.

## 5. Do "tenho uma ideia" ao merge

O padrão é pedir a coisa: o orquestrador decompõe e delega na mesma resposta. Quando o
escopo é grande o bastante para virar várias frentes em paralelo, o caminho é este:

1. **Você escolhe** o que entra agora. O disparo é manual: um worktree (ou floor) por
   frente, cortado de uma `origin/main` recém-buscada, com um agente em cada e o conteúdo
   longo do briefing vindo de arquivo, não da mensagem.
2. Cada worker executa no seu worktree: baseline antes de editar, `git stash` proibido (o
   stash é um ref único compartilhado entre worktrees), commit, push, PR contra `main` — e
   **para**.
3. "Leva o PR `<n>` até review-ready" acorda a skill `pr-babysitting`: CI verde e feedback
   respondido, rastreados separadamente.
4. Revisor só se a mudança mexer em garantia declarada do repo — merge humano, guard de
   comando, permissão. Um agente, escopo restrito ao trecho que carrega a garantia, e nunca
   recebendo o relatório de quem escreveu o código.
5. **Você aperta o merge do PR.** Sempre. Um agente só mergeia sozinho com `git merge`
   dentro de uma branch de controle (`integration/*`, `wave/*`), nunca em `main`. A política
   é de [`guard-destructive.md`](guard-destructive.md); a garantia que não depende do
   cliente continua sendo branch protection no GitHub.

Dois pipelines que já moraram aqui saíram por falta de uso e estão preservados em tag: o de
ondas (grafo de dependências, `/wave-plan`, `/wave-status`) em `pre-wave-removal`, e o de
tickets (`pm`, `ticket-contract`, `/ticket-new`, o leitor de Issues) em `pre-lean-cut`.

## 6. Quanto custa

Números medidos aqui, não estimativa.

- **Cinco tickets em paralelo produziram 38 processos concorrentes e load ~5.** O fan-out é
  multiplicativo: cada worker nasce no `orchestrator` e delega, então 5 tickets não são 5
  agentes. Duas ou três frentes por vez é o número realista para uma máquina só — a largura
  que a dependência entre elas permite e a largura que a máquina aguenta são coisas
  diferentes.
- **Uma passada de revisão: 60-70k tokens.** Duas lentes sobre todo PR não trivial consumiram
  20x a quota em 4 dias — foi por isso que a revisão adversarial saiu do harness. Sobrou um
  revisor, e só onde a mudança mexe em garantia declarada.
- Os `cavecrew-*` rodam em `haiku` e em contexto próprio justamente porque o volume que eles
  geram (payload de PR, varredura de arquivo) morre com eles.

## 7. Limitações conhecidas

- **Nenhum host dispara frente sozinho.** A detecção funciona e diz o procedimento; driver
  automático não existe em lugar nenhum. O disparo é manual em ambos: `floor create` +
  `recruit --floor` no Maestri, `git worktree add` no terminal comum. O que se perde sem
  gerenciador — linhagem e vínculo com a entrega — volta como marcador `.wave/worker.json`,
  que quem dispara escreve na mão: sem ele o `guard-destructive` não reconhece a sessão como
  worker e não emite veredito nenhum sobre `gh pr merge`.
- **Ninguém enxerga colisão de arquivo.** Duas frentes que você julgou independentes editando
  o mesmo arquivo entram em paralelo sem aviso nenhum — quem percebe isso é você, ao cortar o
  escopo de cada uma.
- **Floor do Maestri não tem verbo de remoção.** `floor` é `create|list`: N tickets deixam N
  floors que só você apaga na interface do app. Confirme antes do primeiro `create`.
- **Mensagem longa para agente já rodando cai no paste trap.** O texto fica no composer sem
  ser submetido, e o terminal fica indistinguível de um agente pensando. Daí a regra de
  instrução curta na mensagem e conteúdo longo em nota ou arquivo, e de **verificar** a
  entrega em vez de esperar por ela (skill `maestri-orchestration`).
