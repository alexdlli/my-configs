# Uso

Guia de consulta: o que o harness faz sozinho, o que você digita, e o que dispara sem
comando nenhum. Arquitetura e roster em [`agent-system.md`](agent-system.md); o fluxo de
ondas em detalhe em [`waves.md`](waves.md); instalação em [`installation.md`](installation.md).

## 1. Onde isso roda

O harness mora em `~/.claude/` por symlink (`~/.claude/{harness,agents,hooks,commands}`,
mais um link por skill). Logo: **vale em toda sessão do Claude Code, em qualquer pasta** —
não só dentro deste repo. O Maestri não instala nada e não é requisito; é só o terminal onde a
sessão nasceu.

O host é detectado por variável de ambiente, nunca por processo ou socket aberto
(`node ~/.claude/hooks/session-context.mjs --json` imprime o objeto cru). Sinais e formato em
[`integrations/session-context.md`](integrations/session-context.md).

| Host | Detectado por | O que muda |
|---|---|---|
| Maestri | `MAESTRI_TERMINAL_ID` | Injeta o aviso de que `maestri` **não está no PATH** em zsh: toda invocação vai por `"$MAESTRI_CLI"`. A onda tem topologia nativa (`floor create` + `recruit --floor`), e o `qa` prova a entrega num portal do canvas em vez do argent |
| Terminal comum | a variável ausente | Nada. A onda vira `git worktree` cortado à mão, e o `qa` usa o argent |

Agentes, skills, comandos e hooks são idênticos nos dois. **Nenhum dos dois tem dispatch de
onda automático** — `dispatch.available` é `false` em ambos e o driver não existe; o que o
campo carrega é a `reason`, que nomeia o procedimento manual daquele host.

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
| `/wave-plan` | `owner/repo` + milestone ou label | Tabela de ondas, mais os destaques que não cabem em célula: fan-in, bloqueado externamente, dado ruim |
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
3. `/wave-plan` lê os tickets do GitHub Issues via `gh`, monta o grafo pelo
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

- **Nenhum host dispara onda sozinho.** A detecção funciona e diz o procedimento; driver
  automático não existe em lugar nenhum. O disparo é manual em ambos: `floor create` +
  `recruit --floor` no Maestri, `git worktree add` no terminal comum. O que se perde sem
  gerenciador — linhagem e vínculo com o ticket — volta como marcador `.wave/worker.json` e
  tabela da onda, e os dois são obrigatórios, não opcionais.
- **`/wave-plan` não enxerga colisão de arquivo.** O grafo é feito só de dependência
  declarada (`blockedBy`). Dois tickets da mesma onda editando o mesmo arquivo entram em
  paralelo sem aviso nenhum — quem percebe isso é você, lendo o campo de arquivos afetados.
- **Floor do Maestri não tem verbo de remoção.** `floor` é `create|list`: uma onda de N
  tickets deixa N floors que só você apaga na interface do app. Confirme a onda antes do
  primeiro `create`.
- **Mensagem longa para agente já rodando cai no paste trap.** O texto fica no composer sem
  ser submetido, e o terminal fica indistinguível de um agente pensando. Daí a regra de
  instrução curta na mensagem e conteúdo longo em nota ou arquivo, e de **verificar** a
  entrega em vez de esperar por ela (skill `maestri-orchestration`).
