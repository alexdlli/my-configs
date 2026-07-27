---
name: ticket-contract
description: >-
  Contrato de ticket para trabalho executado por agente autônomo. Use ao escrever,
  revisar ou quebrar tickets, ao montar um projeto no tracker, e ao decidir se um
  ticket existente já serve como prompt de agente sem contexto implícito. Dispara
  em "criar tickets", "quebrar esse escopo", "esse ticket tá bom?", "montar o
  projeto", "transformar essa spec em tickets", "revisar o backlog antes de soltar
  os agentes". Trackers pessoais: Linear via CLI `orca linear` e GitHub Issues via
  CLI `gh`, com leitura e escrita. Tracker de trabalho: Jira via agente `atlassian`
  (somente leitura).
---

# Contrato de ticket

## Premissa

**O ticket É o prompt.** Quem executa é um agente autônomo em contexto limpo: ele
não esteve na reunião, não leu a thread do Slack, não sabe o que "a gente já tinha
combinado". Tudo que não estiver escrito no ticket não existe.

Teste único e definitivo: *se eu colar só o corpo deste ticket numa sessão nova, o
agente entrega a coisa certa?* Um ticket como "adicionar suporte a transações
recorrentes" reprova — não diz o que é recorrência aqui, onde o código mora, o que
fica de fora, nem como saber que funcionou.

## O que já está resolvido em `to-tickets` (referencie, não reescreva)

A skill `to-tickets` (`~/.claude/skills/to-tickets/SKILL.md`) cobre a mecânica de
decomposição. Carregue-a junto e reaproveite:

| Assunto | Onde |
|---|---|
| Fatia vertical / tracer bullet (regras do que é uma fatia completa) | `to-tickets/SKILL.md:29-36` |
| Wide refactor por expand → migrate → contract | `to-tickets/SKILL.md:40` |
| Quiz ao usuário sobre granularidade e arestas de bloqueio | `to-tickets/SKILL.md:42-56` |
| Publicar em ordem de dependência e trabalhar a frontier | `to-tickets/SKILL.md:58-67` |

Este contrato cobre o que falta: **o que vai dentro de cada ticket** e **quando o
projeto está pronto para ser executado por agente**.

## Divergência deliberada: paths e snippets são obrigatórios

`to-tickets/SKILL.md:105` manda evitar file paths e code snippets no ticket, porque
"they go stale fast". **Aqui a política é a oposta e não há hesitação a resolver:**
os campos 5 e 6 deste contrato exigem detalhes técnicos, módulos, funções e arquivos
afetados.

Racional: lá o consumidor é um humano que pode abrir o ticket seis meses depois, com
o código já movido de lugar. Aqui o consumidor é um agente que executa o ticket na
mesma semana, sem memória do codebase, e cujo custo de descobrir sozinho onde mexer é
alto e propenso a erro. Path desatualizado em uma semana é barato de corrigir; agente
reimplementando no módulo errado, não.

Quando as duas skills estiverem carregadas, **este contrato vence** nesse ponto
específico. Todo o resto de `to-tickets` continua valendo.

## Os 12 campos

Todo ticket carrega os 12. Campo que não se aplica é declarado como "não se aplica" —
nunca omitido em silêncio, porque a omissão não distingue "irrelevante" de
"esquecido". Os campos 11 e 12 têm uma saída de escala quando o projeto inteiro os
dispensa: veja "Declaração de perfil do projeto", logo abaixo da tabela. O campo 10 não
tem essa saída — nenhuma declaração de projeto responde por ele.

| # | Campo | O que precisa estar lá |
|---|---|---|
| 1 | Título imperativo e específico | Verbo no imperativo + objeto concreto. O título sozinho já diz o que muda no produto. |
| 2 | Problema e por que resolver | O sintoma real e o custo de não fazer. Dá ao agente critério para escolher entre dois caminhos válidos. |
| 3 | Escopo e o que está FORA | O que entra e, explicitamente, o que **não** entra — com o ticket vizinho que cobre o resto, quando existir. |
| 4 | Comportamento esperado | O fluxo do ponto de vista de quem usa: entrada, saída, estados de erro, casos de borda conhecidos. |
| 5 | Detalhes técnicos relevantes | Decisões já tomadas: contrato de API, shape de dados, biblioteca a usar, invariante a preservar. Não é implementação passo a passo. |
| 6 | Módulos, funções e arquivos afetados | Onde mexer, com `path` e símbolo. Marque o que é ponto de partida verificado vs. palpite a confirmar. |
| 7 | Acceptance criteria | Lista verificável, uma condição por item, cada uma testável sem interpretação. |
| 8 | Cenários de teste | Os casos que provam o AC: caminho feliz, borda, falha. Diz o que testar, não o arquivo de teste a criar. |
| 9 | Dependências em `blockedBy` | Só arestas reais, declaradas explicitamente. Nunca inferidas de título, numeração ou ordem de escrita. A **ausência** de aresta também é declarada, com o motivo. |
| 10 | Rollout e kill switch | Quando há risco: flag, plano de rollback, quem/como desliga. Ticket sem risco declara "sem rollout especial". |
| 11 | Eventos e métricas | Como se sabe, em produção, que a feature funciona — evento emitido, métrica, log estruturado. |
| 12 | i18n, LGPD e factories | Chaves de tradução, dado pessoal tocado (base legal, retenção, anonimização) e factories/fixtures a criar ou estender. |

## Declaração de perfil do projeto

Os campos 11 e 12 pressupõem um produto com telemetria e dado de usuário. Num repo que é só
markdown e script stdlib, os dois saem "não se aplica" quase sempre: no primeiro projeto real
deste harness, 5 dos 6 tickets em cada um dos dois, gastando corpo para não dizer nada. Pior
que o desperdício: "não se aplica" repetido tantas vezes deixa de ser lido exatamente onde
importaria.

**O campo 10 fica de fora da dispensa.** Ele pressupõe risco, e risco existe até em repo de
markdown: nos mesmos 6 tickets, os 6 trouxeram risco concreto mais a contenção contra ele —
`$HOME` falso e remote descartável no experimento de permissões, "diff vazio no corpo das
funções extraídas" na refatoração, desabilitar o workflow pela aba Actions no primeiro CI.
Quando uma declaração diz que o rollback padrão é `git revert`, ela descreve o rollback
**padrão**; não afirma que o ticket não tem risco a declarar. Essa resposta é por ticket, e
nenhuma declaração de projeto a antecipa.

A saída não é omitir. É declarar uma vez, no nível do projeto.

**Onde a declaração mora:** no arquivo canônico de instrução do repo — `CLAUDE.md` na raiz,
ou `AGENTS.md` quando é ele o canônico — numa seção `## Perfil de risco do projeto`. Esse
arquivo entra sozinho no contexto de toda sessão de agente, então o que está lá **está no
prompt**: a premissa "o ticket é o prompt" continua de pé. É por isso que memória de sessão,
thread de conversa ou combinação verbal não servem como declaração — nada disso chega ao
agente que vai executar.

Uma declaração deste repo, por exemplo:

> Este harness não tem runtime em produção, não emite telemetria e não toca dado pessoal.
> Os artefatos são markdown e scripts Node stdlib instalados por symlink, e o rollback
> padrão de qualquer mudança é `git revert` do PR.

Com a declaração escrita:

- Cada campo coberto vira **uma linha** no ticket, citando a declaração. O campo não some e
  não vira parágrafo. O formato exato está em "Como renderizar os 12 campos".
- **A exceção volta ao normal, por ticket.** Ticket que faz o que a declaração não cobre —
  passa a tocar dado pessoal, adiciona texto de interface, emite um sinal observável de
  verdade — preenche o campo por extenso e diz qual premissa da declaração ele quebra.
  A declaração cobre o repo, não absolve o ticket. Nos mesmos 6 tickets a exceção caiu duas
  vezes: o campo 11 da #6, em que o status do check de CI é a própria métrica, e o campo 12
  da #3, em que fixture de payload de PR obriga dado sintético.

Sem declaração escrita, os dois campos são obrigatórios em todo ticket, como sempre foram. E
declaração é afirmação verificável: se ninguém consegue confirmá-la olhando o repo, ela não
existe — pergunte ao usuário em vez de escrever uma por conta própria.

## Como renderizar os 12 campos

O formato é prescrito, não escolha de cada rodada. Auditar um backlog em lote — "todo ticket
tem o campo 3?", "algum campo 6 sem path?" — só é barato quando os doze corpos têm a mesma
forma e o mesmo endereço para cada campo. Sem prescrição, cada rodada inventa um layout e a
auditoria vira leitura manual, ticket por ticket.

**Padrão: um heading `##` por campo, numerado, na ordem do contrato, com o nome do campo.**

```markdown
## 1. Título
## 2. Problema e por que resolver
## 3. Escopo e o que está FORA
## 4. Comportamento esperado
## 5. Detalhes técnicos relevantes
## 6. Módulos, funções e arquivos afetados
## 7. Acceptance criteria
## 8. Cenários de teste
## 9. Dependências em `blockedBy`
## 10. Rollout e kill switch
## 11. Eventos e métricas
## 12. i18n, LGPD e factories
```

Por que este e não outro:

- O número dá endereço estável. `grep '^## 7\.'` acha o acceptance criteria de qualquer
  ticket, em qualquer tracker, sem parser e sem convenção paralela.
- Heading é o que sobrevive à renderização do GitHub e do Linear; tabela e lista de
  definição, não.
- **O campo 1 é repetido no corpo de propósito**, mesmo com o tracker tendo campo de título
  próprio: o teste que define este contrato é colar **só o corpo** numa sessão nova, e sem
  essa seção a coisa a fazer se perde. O preço é conhecido — mudou o título, muda nos dois
  lugares.

Dentro de cada seção, prosa e bullets. Campo 7 em checkbox (`- [ ]`), uma condição por
linha. Campo 8, um bullet por cenário, rotulado pelo tipo (caminho feliz, borda, falha).

O custo desse formato é corpo de 100-130 linhas. Isso se paga nos campos 3 a 8, que carregam
o trabalho — e não se paga em campo coberto pela declaração de perfil do projeto, que fica em
**uma linha sob o heading**, sem parágrafo de justificativa:

```markdown
## 11. Eventos e métricas

Coberto pela declaração de perfil do projeto (`CLAUDE.md`, "Perfil de risco do projeto"): o
repo não emite telemetria.
```

## Bom vs ruim nos quatro campos mais errados

**1 — Título**

- Ruim: `Melhorias no fluxo de pagamento` — não diz o que muda nem onde.
- Bom: `Bloquear checkout quando o cartão salvo estiver expirado`.

**3 — Fora do escopo**

- Ruim: campo ausente. O agente decide sozinho e entrega meia feature a mais.
- Bom: `FORA: retry automático do pagamento (fica em PAY-42); notificação por e-mail; mudança na tela de gestão de cartões`.

**6 — Módulos, funções e arquivos afetados**

- Ruim: `Mexer no serviço de pagamentos`.
- Bom: `src/payments/checkout.ts → validateCard() (ponto de entrada, verificado); src/payments/types.ts → CardStatus (adicionar 'expired'); provável ajuste em src/ui/CheckoutButton.tsx (confirmar)`.

**9 — `blockedBy`**

- Ruim: `blockedBy: PAY-11` porque PAY-11 tem número menor e "parece vir antes".
- Bom: `blockedBy: PAY-11 — este ticket consome o campo CardStatus.expired que PAY-11 cria no schema`. Sem uma frase dessas, a aresta não existe.
- Ruim: campo vazio, ou "nenhuma". Ausência sem motivo não distingue grafo plano de aresta esquecida.
- Bom (sem aresta): `Nenhuma — pode começar agora. PAY-13 edita o mesmo arquivo, mas os símbolos são disjuntos: lá é o parser, aqui é o formatador de saída.`

## Campo 9 no GitHub: as duas armadilhas do marcador

No GitHub uma das duas fontes de aresta é um marcador no corpo da issue: um comentário
HTML ancorado, de miolo `blocked-by: #12, owner/repo#34`. O leitor
(`scripts/waves/tickets-github.mjs`) procura esse padrão em **qualquer** corpo de issue e
não distingue "issue que declara uma aresta" de "issue que fala sobre a convenção". Daí
duas regras que não são estilo, são corretude do grafo.

**1. Ticket que documenta o marcador não pode conter o marcador.** O literal no corpo cria
aresta fantasma para as issues do exemplo; se o exemplo for cross-repo, ainda dispara uma
leitura de bloqueador externo que falha. Para falar do marcador sem disparar o leitor, use
uma das duas formas seguras — nunca o literal:

- **Cite só o miolo:** "comentário HTML ancorado, de miolo `blocked-by: #12`". Sem a
  abertura e o fechamento do comentário não existe casamento.
- **Cite a forma byte a byte por referência:** o regex `/<!--\s*blocked-by\s*:([\s\S]*?)-->/gi`
  em `scripts/waves/tickets-github.mjs:117`, e o exemplo renderizado em `docs/waves.md:205`.
  Colar o regex é seguro: ele exige `blocked-by` logo depois da abertura, e no texto dele o
  que vem ali é `\s*`, que não é espaço em branco.

O precedente é a issue #5 deste repo: a primeira versão do corpo trazia seis literais e
teria criado arestas para `#12` e para um `owner/repo#34` inexistente. Só não entrou porque
o parser real foi rodado contra os corpos antes de publicar — faça o mesmo sempre que um
ticket falar do marcador, e confira que o resultado é zero marcador:

```bash
node -e "import('$HOME/.claude/harness/scripts/waves/tickets-github.mjs').then(m=>console.log(m.parseBlockedByMarkers(require('fs').readFileSync(process.argv[1],'utf8'),'owner/repo')))" corpo.md
# { ids: [], malformed: [], markers: 0 }
```

**2. "Sem bloqueador" se declara em prosa, nunca em marcador vazio.** Miolo vazio é
classificado como malformado: o leitor emite `! bad data:` e sai com código 8, derrubando o
plano de ondas inteiro por um ticket que só queria dizer que não depende de nada. O mesmo
vale para miolo em texto (`blocked-by: nenhum`, `blocked-by: n/a`), que não é referência de
issue. Ticket sem bloqueador **não leva marcador nenhum**: o campo 9 diz em prosa que não há
aresta e por quê — o "por quê" é obrigatório, veja a checagem de prontidão.

## Regras de criação de projeto

- **Ticket só de teste depende de o código já existir** — são dois casos com custos
  opostos, e a regra antiga tratava os dois como o mesmo erro.
  - **Planejando trabalho novo, nunca.** Quebrar uma feature em "implementar X" +
    "testar X" é fatia horizontal: o teste é entregável do ticket que cria o
    comportamento, e um ticket "escrever testes de X" é um ticket que aceitou X
    incompleto. Aqui a dívida ainda nem existe — é o plano que a está criando.
  - **Cobertura faltando de código já mergeado é dívida, e o ticket que a paga é
    legítimo.** O comportamento já está em `main`, definido e em uso; criar o ticket
    não causa a dívida, quita. Recusá-lo não faz teste nenhum aparecer, só mantém o
    buraco sem dono.

  O teste que separa os dois: **o comportamento a ser testado já está mergeado?** Se
  sim, é dívida — e então o ticket nomeia os símbolos que cobre, não muda
  comportamento (se precisar mudar para ficar testável, é ticket de refatoração, e o
  teste vai dentro dele) e obedece às mesmas regras dos outros. Se o comportamento
  nasce neste mesmo plano, o teste pertence ao ticket que o cria, sem exceção.
- **Migration e schema ficam no mesmo ticket** que usa o schema. Migration solta
  entrega banco alterado e zero comportamento — não é fatia vertical.
- **Não existe ticket de "foundation"** cheio de funções para uso futuro. Código sem
  chamador não é revisável nem verificável. A base entra junto com o primeiro uso real.
- **Cada ticket produz UM PR revisável.** Se a entrega natural são dois PRs, são dois
  tickets.
- **Ticket acima de 5 pontos é quebrado.** Sem exceção por "é só grandinho".
- **O alvo é manter PR não-trivial abaixo de ~400 linhas.** É alvo, não trava: um
  rename mecânico pode passar disso legitimamente. Um PR de lógica que passa disso é
  sinal de ticket mal quebrado.
- **Feature arriscada já nasce com rollback e observabilidade** — campos 10 e 11
  preenchidos no ato da criação, não num ticket de follow-up que ninguém pega.

## Checagem: este ticket já é um prompt de agente?

Rode item a item. Qualquer `não` reprova o ticket — corrija antes de publicar ou de
soltar o agente.

- [ ] Os 12 campos estão presentes: preenchidos, marcados como "não se aplica", ou — só os campos 11 e 12 — resolvidos na linha única que cita a declaração de perfil do projeto.
- [ ] O campo 10 não usa essa linha única: ou traz o risco deste ticket com a contenção contra ele, ou diz por que este ticket não tem risco. Declaração de projeto não responde por ele.
- [ ] O título, sozinho, diz o que muda no produto.
- [ ] Existe pelo menos um item explícito FORA do escopo.
- [ ] Todo termo de domínio usado aparece definido no ticket ou é vocabulário do codebase.
- [ ] Cada acceptance criterion é verificável sem interpretação (dois revisores dariam o mesmo veredito).
- [ ] Existe pelo menos um `path` concreto no campo 6, e ele existe no repo hoje.
- [ ] Cada `blockedBy` tem uma frase dizendo **o que** este ticket consome do bloqueador.
- [ ] Nenhum `blockedBy` foi inferido de ordem, numeração ou título.
- [ ] Ticket **sem** `blockedBy` diz, em uma frase, por que não depende de nada. Ausência sem justificativa é indistinguível de aresta esquecida, e aresta esquecida vira a onda 1 gigante contra a qual a `wave-orchestration` alerta.
- [ ] Quando dois tickets tocam o mesmo arquivo e nenhum bloqueia o outro, essa frase diz por que as regiões são disjuntas — é onde qualquer revisor desconfia de aresta faltando.
- [ ] Nada no corpo depende de contexto de conversa ("como discutimos", "o de sempre", "igual ao outro").
- [ ] A estimativa é ≤ 5 pontos.
- [ ] A estimativa vem com uma frase dizendo o que a sustenta: quantos arquivos, se há mecanismo novo a construir, que incerteza sobra depois do campo 5. Número sozinho é palpite com dígito.
- [ ] Essa frase justifica o número **contra o vizinho**: por que este é 3 e aquele é 1. Dois tickets com o mesmo número no mesmo projeto custam o mesmo trabalho, ou um dos dois está errado.
- [ ] A entrega cabe em um PR revisável.
- [ ] Se há risco: rollout, kill switch e métrica de sucesso estão escritos.
- [ ] Se toca dado pessoal ou texto de UI: LGPD e i18n resolvidos no campo 12.

Quando um campo não puder ser preenchido com honestidade, **pergunte ao usuário**.
Ticket inventado custa mais caro que ticket atrasado.

## Adaptador de tracker

As fases seguintes do fluxo consomem tickets num formato normalizado, independente do
tracker:

```
{ id, key, title, url, estimate, status, blockedBy: [id], body }
```

- `id` — identificador interno estável do tracker.
- `key` — identificador legível (`ENG-123`).
- `blockedBy` — lista de `id` de tickets que bloqueiam este. Vazia significa
  "pode começar agora".
- `body` — o corpo com os 12 campos.

Detecte o tracker com `node ~/.claude/hooks/session-context.mjs --json` e leia
`tracker` / `trackerSource`. Nunca assuma pelo nome do repo. A detecção só responde
`linear`, `jira` ou `null` — GitHub Issues é resposta legítima da pergunta que você faz ao
usuário quando vem `null`, não um valor que o hook devolve.

**Linear (pessoal) — leitura e escrita.** Use a CLI `orca linear`. Carregue o guia
casado com o binário antes de rodar qualquer comando: `orca skills get orca-linear`
(a skill `orca-linear` deste harness é só o stub de descoberta). Não invente flag a
partir de memória.

**Jira (trabalho) — somente leitura.** Delegue ao agente `atlassian`, que é o único
com acesso ao MCP da Atlassian. No trabalho os tickets chegam prontos: o papel aqui é
ler, normalizar e **auditar contra este contrato**, apontando ao usuário quais campos
faltam. Não crie nem edite ticket no Jira por conta própria.

**GitHub Issues (pessoal) — leitura e escrita.** A leitura é o mesmo script que alimenta o
plano de ondas:

```bash
node ~/.claude/harness/scripts/waves/tickets-github.mjs --repo <owner>/<repo> [--milestone <n>] [--label <l>] [--json]
```

- **Recorte.** No GitHub não existe "projeto". O recorte é `--milestone` ou `--label`
  (repetível). Escolha um **antes** de criar o primeiro ticket e aplique em todos: sem
  recorte o escopo é o repo inteiro em todos os estados, e o leitor grita isso em caixa alta
  no stderr.
- **`blockedBy` sai da união de duas fontes**, deduplicadas: a dependência nativa da issue
  (a "blocked by" da barra lateral, escrita com `gh issue edit --add-blocked-by`) e o
  marcador ancorado no corpo. Criando em lote, os números só existem depois da criação:
  publique em ordem de dependência, bloqueadores primeiro, colete os números e declare a
  aresta nos dependentes. O marcador aceita `#12` (assume o repo alvo) e `owner/repo#12`, e
  vários marcadores no mesmo corpo são unidos. Antes de escrever qualquer um, leia "Campo 9
  no GitHub" acima — as duas armadilhas de lá custam o plano de ondas inteiro.
- **Estimativa é a label `est:<n>`** — `est:3`, `est: 0.5`, `EST:2`, decimal vale. Sem label,
  `estimate` fica `null`. Duas labels `est:` com valores diferentes é dado ruim reportado,
  nunca escolha silenciosa. A label precisa existir no repo antes (`gh label create`).
- **Escrita é `gh issue create` com `--body-file`**, nunca `--body` inline: um corpo de doze
  seções de markdown não sobrevive à citação do shell.
- **Verifique com o leitor antes de dizer que terminou.** Rode-o sobre o recorte que você
  criou: saída 0 e as arestas na tabela. Código 8 significa "as issues existem, mas o que
  escrevi nelas está malformado" — corrija o corpo, não recrie as issues.

A sintaxe é do parser, não sua: `scripts/waves/tickets-github.mjs:116-121` (referência,
separador, marcador, label) e `docs/waves.md:198-232`. Não invente variação.

A assimetria é deliberada: Linear e GitHub têm escrita, Jira não. Não trate "criar ticket"
como capacidade disponível quando o tracker é Jira, sob nenhuma formulação do pedido.

## Autoria

Nada gerado a partir de um ticket leva assinatura de IA: commit, mensagem de PR,
título de PR, comentário em ticket ou em PR. Sem `Co-Authored-By` de qualquer
assistente, sem "Generated with", sem marca equivalente. O autor é o usuário; o
agente executa.

Isso inverte o que a skill de origem deste fluxo recomenda. A regra local vence.
