# Uso

Guia de consulta: o que o harness faz sozinho, o que você digita, e o que dispara sem
comando nenhum. Arquitetura e roster em [`agent-system.md`](agent-system.md); o fluxo de
ondas em detalhe em [`waves.md`](waves.md); instalação em [`installation.md`](installation.md).

## 1. Onde isso roda

O harness mora em `~/.claude/` por symlink (`~/.claude/{harness,agents,hooks,commands}`,
mais um link por skill). Logo: **vale em toda sessão do Claude Code, em qualquer pasta** —
não só dentro deste repo. Orca e Maestri não instalam nada e não são requisito; são só o
terminal onde a sessão nasceu.

O host é detectado por variável de ambiente, nunca por processo ou socket aberto
(`node ~/.claude/hooks/session-context.mjs --json` imprime o objeto cru).

| Host | Detectado por | O que muda |
|---|---|---|
| Orca | `ORCA_TERMINAL_HANDLE` ou `TERM_PROGRAM=Orca` | Único com **dispatch de onda automático** (`dispatch.driver: orca-cli`): um worktree e um agente por ticket. O caminho do worktree e o repo id saem de graça da env |
| Maestri | `MAESTRI_TERMINAL_ID` | Injeta o aviso de que `maestri` **não está no PATH** em zsh: toda invocação vai por `"$MAESTRI_CLI"`. **Sem dispatch automático** — o driver não existe, mas a onda tem topologia nativa (`floor create` + `recruit --floor`) e dispara à mão |
| Terminal comum | nenhuma das duas | Tudo menos o dispatch. `/wave-plan` imprime o plano e o humano abre os worktrees na mão |

Agentes, skills, comandos e hooks são idênticos nos três. Só o dispatch depende do host.
Maestri é checado antes de Orca: a variável dele é por-terminal, e um terminal do Maestri
pode nascer dentro do Orca herdando as `ORCA_*`.

## 2. O que acontece sem eu pedir

Cinco hooks, ligados por `.claude/settings.json`. Nenhum bloqueia a sessão: todo caminho de
falha sai com 0.

| Hook | Evento | O que faz | Desligar |
|---|---|---|---|
| `.claude/hooks/auto-update.mjs` | SessionStart (`startup`/`resume`/`clear`) | Fast-forward do checkout do harness. Throttle de 6h por cache; só age em `main`, com árvore limpa, e só fast-forward. Se o diff tocou skills, `settings.json` ou o installer, **sugere** re-rodar o installer — nunca roda | `CLAUDE_SETUP_SKIP_AUTOUPDATE=1` (também se auto-pula quando `CI` está setado) |
| `.claude/hooks/session-context.mjs` | SessionStart (mesmos gatilhos) | Injeta no máximo 4 linhas: host, o que é acionável nele, tracker. Em terminal comum não injeta nada | `CLAUDE_SETUP_SKIP_SESSION_CONTEXT=1` (o `--json` explícito continua respondendo) |
| `.claude/hooks/orchestrator-reminder.mjs` | UserPromptSubmit | Reinjeta as regras de delegação a cada prompt, para o orquestrador não voltar a executar sozinho em sessão longa | `CLAUDE_SETUP_SKIP_ORCH_REMINDER=1` |
| `.claude/hooks/preserve-orchestrator.mjs` | PreCompact (`auto` e `manual`) | Preserva a identidade de orquestrador através da compactação, que costuma comer o enquadramento de coordenador | mesma chave acima |
| `.claude/hooks/guard-destructive.mjs` | PreToolUse (matcher `Bash`) | Nega comandos destrutivos, inclusive embrulhados em `bash -c` ou canalizados para shell — que é o que `permissions.deny` não enxerga | `CLAUDE_SETUP_SKIP_GUARD_DESTRUCTIVE=1` |

O guard não trata os três comandos igual:

| Comando | Onde é negado |
|---|---|
| `git push --force` | Em todo contexto, sem exceção |
| `git commit --no-verify` | Em todo contexto, sem exceção |
| `gh pr merge` | **Só em worker de onda**, identificado pelo marcador `.wave/worker.json`. Fora dele o comando cai no prompt de permissão — que é exatamente onde você aprova o merge |

Ele falha aberto em erro interno (guard que nega por bug próprio mata o Bash da sessão). A
exceção deliberada é não conseguir dizer se a sessão é worker: aí nega. Detalhes e o que ele
de propósito **não** pega em [`guard-destructive.md`](guard-destructive.md).

## 3. O que eu digito

| Comando | Recebe | Devolve |
|---|---|---|
| `/sync-harness` | nada | Atualiza o harness agora, ignorando só o throttle de 6h. Todas as outras checagens continuam valendo. Output verbatim |
| `/ticket-new` | escopo, spec ou discussão (vazio: a conversa atual) | Spawna o `pm` com a skill `ticket-contract`. Apresenta a quebra e **espera aprovação** antes de publicar no tracker |
| `/review-adversarial` | commit, branch ou tag base (vazio: `main`) | Spawna `reviewer` duas vezes em paralelo, cada um com uma lente distinta. Reporta achados convergentes, depois divergências, depois a cobertura de cada lente |
| `/wave-plan` | projeto do Linear (URL ou nome), ou `owner/repo` + milestone/label | Tabela de ondas, mais os destaques que não cabem em célula: fan-in, bloqueado externamente, dado ruim |
| `/wave-status` | número da onda, ou a lista de branches/tickets | Spawna o `wave-monitor` (`haiku`, contexto próprio) e devolve uma tabela compacta. Só reporta |
| `/pr-babysit` | número, URL ou branch (vazio: o PR da branch atual) | Leva o PR a review-ready, rastreando CI e feedback como dois estados independentes |

Comando novo fica vivo assim que o checkout é atualizado — o diretório inteiro é
symlinkado. Skill nova exige re-rodar o installer, porque skills são linkadas uma a uma.

## 4. O que roda sozinho por descrição

Não existe tabela de rotas. O `description:` do frontmatter de cada agente e de cada skill é
o que o Claude lê para decidir quem acordar. Falar a frase certa basta.

| Frase | O que acorda |
|---|---|
| "quebra esse escopo em tickets" / "esse ticket tá bom?" / "monta o projeto" | Skill `ticket-contract` e o agente `pm` |
| "quantas frentes dá pra tocar em paralelo?" / "monta o grafo desse projeto" / "o que dá pra começar agora" | Skill `wave-orchestration` (planejamento; o disparo é manual) |
| "revisa direito, com duas lentes" / "quero dois revisores" | Skill `adversarial-review`, que spawna `reviewer` duas vezes em paralelo |
| "o CI falhou" / "por que o check está vermelho" / "responder o review" | Skill `pr-babysitting`, que delega a classificação das threads ao agente `pr-triage` |
| "onde está definido X?" / "o que chama Y?" / "mapeia esse diretório" | Agente `cavecrew-investigator` (tabela `file:line`, saída comprimida) |
| "valida essa task contra PROJ-123" / qualquer URL `*.atlassian.net` | Agente `atlassian` — o único com acesso MCP, e só em sinal explícito |
| "como está a onda 2?" / "quais tickets estão verdes?" | Agente `wave-monitor` |

Se o agente errado (ou nenhum) acordar, o conserto é editar o `description:` dele, não
inventar um roteador.

## 5. Do "tenho uma ideia" ao merge

1. **Você** descreve o escopo. `/ticket-new` → o `pm` quebra em tickets com os 12 campos do
   contrato. O ticket **é** o prompt: o que não estiver escrito não existe para quem executa.
2. **Você aprova** a quebra. Só então ela é publicada no tracker.
3. `/wave-plan` lê os tickets (Linear via `orca linear`, GitHub via `gh`), monta o grafo pelo
   `blockedBy` declarado e imprime as ondas. Plano de uma onda só costuma significar
   `blockedBy` não preenchido, não projeto plano.
4. **Você escolhe** a onda. O disparo é manual: um worktree (ou floor) por ticket, cortado de
   uma `origin/main` recém-buscada, com um agente em cada e o prompt vindo de arquivo.
5. Cada worker executa no seu worktree: baseline antes de editar, `git stash` proibido (o
   stash é um ref único compartilhado entre worktrees), commit, push, PR contra `main` — e
   **para**.
6. `/wave-status` acompanha. `/pr-babysit <n>` leva cada PR até review-ready: CI verde e
   feedback respondido, rastreados separadamente.
7. `/review-adversarial` antes de aprovar o que não é trivial.
8. **Você mergeia.** Sempre. Nenhum agente do harness tem esse comando disponível dentro de
   uma onda, e o prompt do worker diz isso com todas as letras. A garantia que não depende do
   cliente é branch protection no GitHub.
9. **Você libera** a onda seguinte, voltando ao passo 4. A onda `n+1` depende de *merge*, não
   de aprovação.

## 6. Quanto custa

Números medidos aqui, não estimativa.

- **Uma onda de 5 tickets produziu 38 processos concorrentes e load ~5.** O fan-out é
  multiplicativo: cada worker nasce no `orchestrator` e delega, então 5 tickets não são 5
  agentes. Duas ou três frentes por vez é o número realista para uma máquina só — a largura
  técnica da onda (o grafo) e a largura que a máquina aguenta são coisas diferentes.
- **Revisão por lente: 60-70k tokens cada.** `/review-adversarial` são duas. Vale em mudança
  não trivial; não vale em correção de typo.
- `wave-monitor` e `cavecrew-*` rodam em `haiku` e em contexto próprio justamente porque o
  volume que eles geram (payload de PR, varredura de arquivo) morre com eles.

## 7. Limitações conhecidas

- **Maestri não dispara onda.** A detecção funciona e avisa; o adaptador não existe. Fora do
  Orca a entrega é o plano, e improvisar `git worktree` na mão perde linhagem, terminal
  gerenciado e vínculo com o ticket.
- **`/wave-plan` não enxerga colisão de arquivo.** O grafo é feito só de dependência
  declarada (`blockedBy`). Dois tickets da mesma onda editando o mesmo arquivo entram em
  paralelo sem aviso nenhum — quem percebe isso é você, lendo o campo de arquivos afetados.
- **Handle de terminal envelhece.** Handles são de escopo de runtime: se o Orca reiniciar, o
  handle antigo morre e precisa ser readquirido por `orca terminal list`.
- **Mensagem longa para agente já rodando cai no paste trap.** O texto fica no composer sem
  ser submetido, e o terminal fica indistinguível de um agente pensando. Depois de um
  `terminal send`, **verifique** com `orca terminal read`; se o texto ainda estiver lá, mande
  um `send --text "" --enter` e leia de novo. `terminal wait --for tui-idle` já voltou na hora
  sem esperar nada, então ele serve como aceleração, nunca como garantia.
