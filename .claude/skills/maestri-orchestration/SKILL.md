---
name: maestri-orchestration
description: >-
  Orquestração de time dentro do Maestri: recrutar uma frente por recruta,
  isolar cada uma num floor, delegar por `"$MAESTRI_CLI" ask`, manter as notas
  compartilhadas, agendar o pulso com `routine` e provar a entrega num portal.
  Use quando a sessão roda num terminal do Maestri (`host` `maestri` em
  `session-context.mjs`) e o pedido for montar um time, tocar várias frentes em
  paralelo, "modo maestro", "recruta alguém", "delega isso pro time". Escreve só
  o que muda por estar no Maestri; as regras de execução moram nas skills que já
  são donas delas.
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
| Sintaxe completa de cada verbo — flags, ids curtos, o que é destrutivo | as skills que o app instala (`maestri`, `maestri-manager`, `maestri-routines`, `maestri-workspace`, `maestri-portal`, `maestri-portal-devices`) e `"$MAESTRI_CLI" help` |
| Freio da revisão adversarial (só correção ou requisito declarado), aplicado na consolidação dos dois laudos | `adversarial-review`, "Freio de escopo: o que não entra no laudo" |
| Teto de 3 iterações por achado, e o que escalar entrega | `adversarial-review`, "Teto de iteração por achado" |
| `git stash` proibido com mais de uma árvore ativa | `wave-orchestration`, item 6 das "Regras invioláveis" |
| Baseline antes de mexer, hipótese rotulada, achado fora de escopo vira PR próprio, verificar antes de reportar pronto | `wave-orchestration`, "O prompt padrão do worker" |
| Verificação que sabe falhar (sensor de discriminação) | `ticket-contract`, "O sensor de discriminação" |
| O que conta como prova de uma entrega, e que uma falha invalida a corrida inteira | agente `qa`; a linha `Artefato de prova:` do ticket é do `ticket-contract` |
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

**A superfície citada aqui saiu de `"$MAESTRI_CLI" help`, lido num terminal
real.** Verbo e flag daqui são portanto **documentados, não medidos**: ninguém
rodou `floor create`, `routine create` ou `portal` neste harness, e cada seção
marca isso onde importa. E antes de escrever que um verbo não existe, leia o
`help` inteiro — foi a leitura que faltou quando esta skill afirmou que o Maestri
não tinha isolamento (L-012 em [`docs/lessons.md`](../../../docs/lessons.md)).

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

O segundo envio — o que só aperta Enter — tem verbo próprio:
`"$MAESTRI_CLI" ask "Nome" --raw "\n"` escreve direto no terminal do recruta e
devolve o texto resultante, sem reenviar a mensagem. Escapes, do `help`: `\n`
Enter, `\t` Tab, `\e` ESC, `\xNN` byte (`\x03` = Ctrl-C, que é como se interrompe
recruta preso), e tecla especial vai como sequência ESC (`\e[A` seta para cima,
`\e[Z` Shift-Tab). Documentado; não medido contra o bloco travado.

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

Bloqueio que não pode esperar o Alex voltar ao canvas: `"$MAESTRI_CLI" notify
"mensagem"` (só Maestro) dispara notificação de sistema. É o **aviso**, não o
canal — o conteúdo continua no chat ou na nota, e notificação que vira log de
progresso deixa de ser lida.

## Recrutar, retargetar, dispensar

`maestri-manager` é dona dos verbos e da regra de reusar antes de recrutar
(`list` primeiro). O que é fácil errar vindo do persona:

- **Não existe `maestri reassign`.** Trocar o papel de um recruta vivo é
  `"$MAESTRI_CLI" role assign "Nome" "Role"` — é este o verbo que o `help`
  descreve como *"Reassign a recruit's role"*, e é daí que vem a confusão.
- **Recruta inchado ou travado reinicia com `role assign "Nome" --none` e
  reatribuição.** Reatribuir o **mesmo** role é no-op e não reinicia o processo.
- **Trocar o agente (Claude por Codex) é `recruit "Novo" --preset P --replace
  "Antigo"`, nunca `dismiss` + `recruit`.** O `--replace` troca quem roda no
  teammate **em pé**, mantendo conexões, posição e routines (o processo
  reinicia). O próprio `help` do `dismiss` manda usar `--replace` *"so its notes
  and portals stay wired"*: `dismiss` apaga o nó, e nota ligada só àquele recruta
  fica órfã — só o Alex reconecta, na mão, no app.
- **Mas `--replace` não se combina com `--floor`** — e a topologia de onda daqui é
  toda `--floor`. Literal: *"--replace keeps the teammate's node in place and can't
  be combined with --floor. Recruit a fresh teammate with --floor if you need one
  there."* Numa frente isolada a troca de agente é recrutar um **novo** no mesmo
  floor, e aí o nó antigo continua em pé com as conexões dele: religue a nota no
  novo antes de dispensar o antigo, ou o `dismiss` deixa a órfã do item acima.
- **Nome de preset e de role se listam, não se adivinham:** `"$MAESTRI_CLI"
  preset list` e `role list`. `recruit` aceita `[--preset P] [--role R] [--floor
  F] [--command C] [--dir PATH]`; `--command` existe e leva o argv inteiro do
  agente, mas o preset é o caminho documentado, e nome de modelo citado de
  memória é exatamente como o persona antigo carregou um verbo inexistente por
  meses.

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
dele**. Escreva, explícito: *"abra o PR contra `main`, vincule o PR ao ticket e
PARE; você nunca mergeia, nem com CI verde, nem com review aprovado — quem
aperta merge é o Alex"*. O vínculo tem a mesma forma da seção `## Ao terminar`
de `wave-orchestration` — no GitHub, a palavra-chave no corpo do PR; no Linear,
`orca linear attach` mais `orca linear status set` — e cai no mesmo buraco: aqui
não sobra camada nenhuma atrás do texto.

## Onda no Maestri: o floor é a primitiva

O isolamento é nativo e tem o formato exato de uma onda — um clone por ticket, um
agente dentro dele:

```bash
"$MAESTRI_CLI" floor create "t-12" --branch feat/t-12    # clone git-isolado, na branch
"$MAESTRI_CLI" recruit "T-12" --preset P --floor "t-12"  # o recruta nasce lá dentro
"$MAESTRI_CLI" floor list                                # branch, caminho do clone, nós
```

`--branch` **falha se a branch já existe**, e em duas formas diferentes:
`' already exists.` (branch solta) e `' is already used by floor '` (a branch já é
de outro floor). Numa onda de N tickets é o **segundo** `floor create` que descobre
a segunda. Branch existente entra com `--existing-branch`. Integrar a branch de um
floor **não tem comando de CLI**: é o Alex na interface, o que casa com a política
de merge do harness. Ainda existem `--no-git` (floor simples de propósito) e
`--copy-ground` (começa com o layout do térreo).

### O floor pode sair simples — e aí a frente não está isolada

O clone só sai quando o workspace suporta: repo git **em volume APFS** e workspace
**local**. Sem isso o `floor create` não falha — devolve um floor simples que
**compartilha o diretório do térreo**. Isolamento é o default, não a garantia.

Não julgue a resposta, **grepe**. Os marcadores são literais do binário do app:

| Sensor | Isolado | Simples |
|---|---|---|
| `floor create` | `isolated clone at` | `without git isolation` |
| `recruit --floor` | `isolated clone on branch '` | `on the ground level` |

São dois porque respondem coisas diferentes: o primeiro diz o que o floor é, o
segundo reafirma o isolamento **onde o agente foi de fato colocado**. O texto do
floor simples ainda nomeia o motivo — `is not a git repository on an APFS volume`,
`because remote workspaces can't host isolated clones`, `(no git isolation
requested)` —, que é o que separa "consertável" de "esperado".

**HIPÓTESE, não medida:** o floor degradado sai com **exit 0**, porque as strings
de degradação vivem no bloco de sucesso e não no de erro — então `set -e` não pega
e um script segue achando que isolou. Decide um `floor create` real em diretório
não-APFS seguido de `echo $?`. Até lá o exit code não é sinal: leia o texto.

**Veio simples? Não recrute assim mesmo.** Duas saídas, as mesmas de sempre:

1. **Serializa** — as frentes que dividiriam o diretório viram uma fila num
   recruta só, uma depois da outra, planejadas com `wave-orchestration` (seções 1
   e 2) e disparadas à mão.
2. **Leva a onda pro Orca**, onde o dispatch existe e é testado.

**Nunca N recrutas sobre o mesmo diretório**: sem clone eles dividem os arquivos e
o index do git — a condição que a regra inviolável 6 de `wave-orchestration` existe
para evitar, aqui sem nem a árvore separada para amortecer.

Duas armadilhas em volta disso:

- **Manager remoto é recusado mesmo com o floor isolado.** O `recruit --floor`
  responde *"The recruit would inherit that connection and couldn't reach the
  clone. Recruit onto that floor from a local manager instead."* Onda isolada quer
  manager local.
- **`Floor management isn't ready yet. Try again in a moment, or pass --no-git for
  a plain floor.`** é transitório — e o remédio que o próprio CLI sugere **destrói
  o isolamento**. Nesse erro se repete o comando; nunca se aceita o `--no-git`.

**`floor list` é a auditoria da onda**, não linha decorativa do bloco acima: dois
floors com o **mesmo caminho** são duas frentes não isoladas — um sensor depois de
criar todos, em vez de reler N respostas individuais.

**Nada disso foi executado.** Os literais saíram do binário; o comportamento, não.
O primeiro `floor create` real confere o que o clone traz e onde ele fica **antes**
de virar receita de onda.

O que continua não existindo é o **adaptador automático**: `session-context.mjs`
responde `dispatch.available: false` no Maestri, e nenhum driver corta a onda
inteira como o `orca-cli` corta (`wave-orchestration`, "Onde o disparo é
possível"). O que muda é a conclusão — o disparo aqui é **manual e possível
enquanto o floor sair isolado**: um `floor create` e um `recruit --floor` por
ticket, os dois marcadores conferidos, instrução curta no `ask` e o requisito longo
em nota. Saiu simples, valem as duas saídas acima. Planejamento e regras
invioláveis seguem em
`wave-orchestration` (seções 1 e 2); o que a onda ganha aqui é a topologia, não a
automação.

## Pulso: o mesmo `PULSO_DE_COORDENACAO`, outro instrumento

O pulso, o intervalo e o motivo dele são do `orchestrator.md`. No Maestri muda o
**instrumento**, e ele não é leitura de terminal:

- `ask --batch '{"A": "prompt", "B": "prompt"}'` fala com **todas** as frentes em
  paralelo e devolve um array JSON quando a última termina. É a varredura inteira
  do `PULSO_DE_COORDENACAO` em **uma chamada**, não uma pergunta por recruta.
- `check "Nome"` lê o terminal sem gastar uma rodada do recruta — é o que
  responde "parou ou está trabalhando?".

### O pulso que sobrevive a você: `routine`

`routine create "Nome" --command "..." <agenda>` agenda um comando ou um prompt
num terminal do canvas. Agendas, exatamente uma por routine: `--every 30m`,
`--daily 09:00`, `--weekly mon,fri@09:00`, `--once "2026-06-20 15:00"`. Três
opções mudam o desenho — `--terminal "Nome"` (em quem cai; omitido, cai em você),
`--reminder` (notificação, sem terminal) e `--count N` / `--until DATE` (pulso que
termina sozinho). `maestri-routines` é dona dos verbos e do resto das flags.

**`--pre-run` é o que faz o pulso valer o token**: a saída dele entra onde o
`--command` contiver `{{output}}`, então o dado chega junto com a pergunta em vez
de o recruta ir buscá-lo.

```bash
"$MAESTRI_CLI" routine create "Pulso das frentes" --every 2h \
  --pre-run "git -C /caminho/do/repo for-each-ref --format='%(refname:short) %(committerdate:relative)' refs/heads" \
  --command "Estado das branches:\n{{output}}\nQual frente não se moveu desde o pulso anterior?"
```

Sem `{{output}}` no comando o script roda e a saída se perde. E **calibre o
intervalo pela taxa real de mudança da frente**: frente rápida, pulso curto;
frente longa, pulso espaçado. Pulso curto demais só queima token — e `--count` ou
`--until` evita a routine que sobrevive à onda que ela acompanhava.

## Tipo de laço: o que o recruta roda

Cada recruta é uma sessão do Claude Code, então o laço não é verbo do Maestri — é
o que você manda ele rodar dentro da sessão dele:

| Trabalho | Laço | O que o recruta roda |
|---|---|---|
| Exploratório, decisão de design | Por turno | Prompt específico por `ask`; ele reporta e para |
| Tem critério de pronto verificável | Por objetivo | `/goal <condição verificável>` (`/goal clear` encerra antes) |
| Depende de sistema externo (PR, CI, fila) | Por tempo | `/loop <intervalo> <prompt ou /comando>`; para CI, `Monitor` (skill `pr-babysitting`) |
| Recorrente e bem definido | Proativo | `"$MAESTRI_CLI" routine`, a seção acima |

`/goal` e `/loop` são do **Claude Code**, não do Maestri — não aparecem no `help`
dele. Conferidos por busca de string no binário instalado (2.1.220), onde `/loop`
se descreve como *"Run a prompt or slash command on a recurring interval (e.g.
`/loop 5m /foo`)"*; **nenhum dos dois foi executado**, e teto de tentativas não
apareceu como sintaxe — o teto vai escrito dentro da própria condição.

O que separa as duas últimas linhas é sobrevivência: laço é da sessão e morre com
ela — medido aqui que `Monitor` não volta nem com `--resume` (`pr-babysitting`,
"Monitorar sem queimar contexto"). `routine` é objeto do canvas, disparado pelo
app de fora do recruta. Espera que pode durar mais que a sessão vira `routine`.

## Portal: o instrumento de prova dentro do canvas

O que conta como prova de uma entrega é do agente `qa`, e a linha `Artefato de
prova:` do ticket é do `ticket-contract`. No Maestri muda o **instrumento**: em
vez de argent ou de um MCP de Chrome, o produto roda num **portal** — nó do canvas
dirigido pela mesma CLI, o que o põe dentro do `Bash` que o `qa` já tem no
allowlist.

- **Web:** `portal create URL ["Nome"] [--size WxH]`, e daí navegar, clicar,
  preencher, screenshot, `resize W H` (viewport exato, QA responsivo) e `ua`
  (troca de user agent). Skill `maestri-portal`.
- **Simulador:** `portal devices` lista os dispositivos com runtime, estado de
  boot e qual portal já ocupa cada um; `portal create --simulator UDID` abre um.
  Valem os mesmos verbos, mais botão de hardware e `launch "com.bundle.id"`.
  Coordenada de árvore e de `info` vem em **screen points, não pixels** — num
  device 3x confundir os dois erra o toque por um fator 3. Skill
  `maestri-portal-devices`.

Duas regras que não mudam de ambiente. **Coordenada não sai de screenshot:**
`snapshot` devolve ref e é por ref que se clica, a mesma descoberta-antes-do-toque
que o `qa` aplica no argent. Quando o `snapshot` do simulador vem **imagem em vez
de árvore**, a linha `accessibility:` do header nomeia o motivo, e o conserto é
`portal launch` do bundle — que traz o app para debaixo do Maestri e devolve a
árvore. A regra tem **exceção documentada**: nesse modo se toca por pixel lido da
imagem devolvida, que vem capturada na resolução que o toque espera
(`maestri-portal-devices`). Exceção com marcador próprio e resolução casada — não
é licença para adivinhar pixel quando a árvore existe. E **artefato que existiu só
no terminal não é artefato:** o screenshot vai para disco ou para uma nota,
legendado com o passo que ele prova.
