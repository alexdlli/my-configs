---
name: maestri-orchestration
description: >-
  Orquestração de time dentro do Maestri: recrutar uma frente por recruta,
  delegar por `"$MAESTRI_CLI" ask`, manter as notas compartilhadas e
  desbloquear quem parou. Use quando a sessão roda num terminal do Maestri
  (`host` `maestri` em `session-context.mjs`) e o pedido for montar um time,
  tocar várias frentes em paralelo, "modo maestro", "recruta alguém", "delega
  isso pro time". Escreve só o que muda por estar no Maestri; as regras de
  execução moram nas skills que já são donas delas.
---

# Orquestração no Maestri

O Maestri é um canvas: agentes, notas e portais ligados por cordas. Esta skill
cobre **só o que muda por estar nele** — toda regra que vale nos dois ambientes já
tem dona, e cópia que diverge em silêncio é pior que cópia nenhuma.

Vale quando `node ~/.claude/hooks/session-context.mjs --json` responde `host`
igual a `maestri`. Aí `hostDetail` traz `terminalId` (`MAESTRI_TERMINAL_ID`) e
`cliPath` (`MAESTRI_CLI`).

## O que NÃO está escrito aqui, e onde está

| Regra | Dona |
|---|---|
| Freio da revisão adversarial (só correção ou requisito declarado), aplicado na consolidação dos dois laudos | `adversarial-review`, "Freio de escopo: o que não entra no laudo" |
| Teto de 3 iterações por achado, e o que escalar entrega | `adversarial-review`, "Teto de iteração por achado" |
| `git stash` proibido com mais de uma árvore ativa | `wave-orchestration`, item 6 das "Regras invioláveis" |
| Baseline antes de mexer, hipótese rotulada, achado fora de escopo vira PR próprio, verificar antes de reportar pronto | `wave-orchestration`, "O prompt padrão do worker" |
| Verificação que sabe falhar (sensor de discriminação) | `ticket-contract`, "O sensor de discriminação" |
| "Melhore o sistema, não só o caso" | `scripts/lessons.mjs` e [`docs/lessons.md`](../../../docs/lessons.md): achado que recorre em 2 tickets distintos vira guidance carregada antes do código nascer |
| Pulso de coordenação em todas as frentes, e por que 3 rodadas | `orchestrator.md`, `PULSO_DE_COORDENACAO` |
| Instrução curta, conteúdo longo fora da mensagem | `orchestrator.md`, "Despacho: instrução curta, conteúdo longo em arquivo" |
| Merge é sempre humano | `wave-orchestration`, regra inviolável 1, e [`docs/guard-destructive.md`](../../../docs/guard-destructive.md) |
| Planejar antes de codar, e o contrato de 12 campos | `to-spec`, depois `ticket-contract` — que **supersede** `to-tickets` (12 campos contra 4). Os nomes `/to-prd` e `/to-issues` não existem |

Mudou uma dessas? Muda na dona, não aqui.

## `"$MAESTRI_CLI"`, nunca `maestri`

**Toda** invocação, com aspas — o caminho staged fica sob `$TMPDIR`. Medido: o
app injeta o bloco de PATH em `~/.profile`, `~/.bashrc` e na config do fish;
**zsh não está na lista**, e o shell aqui é zsh. A mensagem é do próprio CLI:

> Your shell resets PATH. Use `$MAESTRI_CLI` instead of `maestri`.

**Num terminal do Maestri existem exatamente três variáveis**: `MAESTRI_SOCKET`,
`MAESTRI_TERMINAL_ID` e `MAESTRI_CLI`. Nome de workspace, branch, pasta e nome de
terminal **não** vêm do ambiente — saem de `git`, da cwd e de
`"$MAESTRI_CLI" list`. Inventar um `$MAESTRI_WORKSPACE_*` é como esta regra falha
na prática: a variável expande vazia e o comando roda no alvo errado. A exceção é
o script de `routine --pre-run`, que recebe as próprias (skill `maestri-routines`).

## O canal é frágil: instrução curta, conteúdo longo em nota

**Medido hoje em duas ferramentas.** Mensagem longa não é entregue: vira um bloco
não submetido (`paste again to expand`) e exige um segundo envio só com Enter. Da
tela, o recruta parece um agente pensando. Caminho de imagem colado num `ask`
trava o recruta do mesmo jeito, e ainda incha o contexto dele.

A correção do persona é a certa, e aqui ela é inviolável:

- **No canal vai a instrução curta**: objetivo, critério de pronto, escopo e o que
  está fora, e onde reportar.
- **O conteúdo longo vai numa nota durável que o recruta lê** — spec, contrato,
  requisito, diff. Passe o **nome da nota** e diga o que ler lá.
- Medida e valor vão como **texto**, nunca imagem. Se imagem for mesmo necessária,
  recruta fresco e poucos paths.

É o despacho do `orchestrator.md` com outro veículo: lá o conteúdo longo vai em
arquivo, aqui vai na nota, que é o que o recruta alcança pela CLI.

`ask` estourou o timeout? **Nunca reenvie às cegas** — `"$MAESTRI_CLI" check
"Nome"` (skill `maestri`) diz se ele ainda está trabalhando.

## Protocolo das notas

**"Team Context"** — ligada a você e a **todo** recruta. Decisões de arquitetura e
convenções, o mapa das frentes (quem está em qual branch ou floor e a ordem de
integração), os problemas pré-existentes conhecidos, e a descoberta de um recruta
que afeta outra frente. Recruta **acrescenta** na seção de descobertas, nunca
reescreve o que já está lá; estrutura e curadoria são suas, e contexto que uma
frente ativa ainda usa não se apaga. Decisão que fica só numa conversa morre com
ela — registre na hora.

**"Todo for Alex"** — só ação que exige o Alex **agir no mundo**: credencial,
aprovação de cobrança, clique numa conta dele, aviso a alguém de fora. O teste,
antes de escrever: *"isso se resolve com o Alex te respondendo? então é chat, não
nota."* Decisão, dúvida, prioridade e trade-off vão no **seu chat** — você é o
único agente que fala com ele. **Nunca conecte esta nota a um recruta:** recruta
fala com você, e é você que decide entre perguntar no chat e escalar à nota.

```markdown
## For you to do
- [ ] <ação no mundo que não se resolve conversando>

## Status
- Frente A (recruta X): em andamento — <uma linha>
- Frente B (recruta Y): pronta
- Frente C (recruta Z): bloqueada pelo item acima
```

O nome de uma nota é derivado da primeira linha dela: depois de escrever, rode
`"$MAESTRI_CLI" list` para ver se ela foi renomeada (skill `maestri`).

## Recrutar, retargetar, dispensar

`maestri-manager` é dona dos verbos e da regra de reusar antes de recrutar
(`list` primeiro). O que é fácil errar vindo do persona:

- **Não existe `maestri reassign`.** Trocar o papel de um recruta vivo é
  `"$MAESTRI_CLI" role assign "Nome" "Role"`.
- **Recruta inchado ou travado reinicia com `role assign "Nome" --none` e
  reatribuição.** Reatribuir o **mesmo** role é no-op e não reinicia o processo.
- **Trocar o agente (Claude por Codex) é `recruit --replace`, nunca `dismiss` +
  `recruit`.** `dismiss` apaga o nó, e nota ligada só àquele recruta fica órfã —
  o que quebra o protocolo acima, e só o Alex reconecta, na mão, no app.
- **Modelo por recruta:** o caminho documentado é `--preset` (veja
  `"$MAESTRI_CLI" preset list`). `--command` aceita o argv inteiro, mas
  `maestri-manager` o marca como quase nunca necessário — e nome de modelo se
  confere antes de usar, nunca se cita de memória.
- **Isolamento é nativo:** `"$MAESTRI_CLI" floor create "Nome" --branch <b>` cria
  um clone do projeto numa branch própria, e `recruit --floor "Nome"` põe o agente
  lá dentro sem você sair do seu floor (skill `maestri-workspace`). Integrar a
  branch de um floor **não tem comando de CLI**: é o Alex, no app.

### Bypass de permissão: aqui não sobra camada nenhuma

Recrutar com `--dangerously-skip-permissions` mantém o recruta andando em vez de
parado num prompt que ninguém está olhando. A consequência mudou e o persona
antigo não a conhece: com a política ask-then-merge, quem barra `gh pr merge` é o
hook `guard-destructive`, que nega **só em worker de onda** — reconhecido pelo
marcador `.wave/worker.json` — e fica **calado** em qualquer outro contexto
([`docs/guard-destructive.md`](../../../docs/guard-destructive.md)). Um recruta do
Maestri não é worker de onda: o guard se cala, e sob bypass "calado" quer dizer
**executou**.

Logo, **a única camada do lado do recruta é o texto que você escreve no role
dele**. Escreva, explícito: *"abra o PR contra `main` e PARE; você nunca mergeia,
nem com CI verde, nem com review aprovado — quem aperta merge é o Alex"*.

## Pulso: o mesmo `PULSO_DE_COORDENACAO`, outro instrumento

O pulso, o intervalo e o motivo dele são do `orchestrator.md`. No Maestri muda o
**instrumento**: a varredura é `"$MAESTRI_CLI" ask` — ou `ask --batch`, que fala
com várias frentes numa chamada e só retorna quando a mais lenta termina — e
`check "Nome"` para ler estado sem gastar uma rodada do recruta. Não é leitura de
terminal. Para não depender da sua memória, agende:
`"$MAESTRI_CLI" routine create "Pulso" --command "..." --every 30m` (skill
`maestri-routines`), calibrado pela taxa real de mudança da frente — pulso curto
demais só queima token.

## Não existe dispatch de onda no Maestri

O campo `dispatch` do `session-context.mjs` vem `{available: false, driver: null}`
aqui, com o motivo escrito nele: não há adaptador de onda para o Maestri, e a CLI
só existe como `$MAESTRI_CLI` dentro do terminal do app. **Diga isso e não
improvise um substituto.** As duas saídas honestas:

1. Planejar com `wave-orchestration` (seções 1 e 2) e disparar à mão, uma frente
   por recruta, com o conteúdo longo em nota.
2. Rodar a onda no Orca, onde o dispatch existe e é testado.
