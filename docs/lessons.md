# Lições

<!-- lessons:state next-id=12 -->

> **Escrito por `scripts/lessons.mjs`. Nunca edite este arquivo à mão.**
> A próxima escrita do script sobrescreve qualquer edição manual, e uma edição
> que quebre o formato faz a leitura falhar em vez de perder lições em silêncio.
>
> O revisor fornece o julgamento — qual falha aconteceu e como enunciar a lição.
> O script é dono de tudo que é mecânico: ids, contagem de recorrência por ticket
> distinto, promoção, poda e quarentena. Escrituração na mão é exatamente o que
> apodrece um arquivo de lições, então ela mora aqui e não num prompt.

## A política

- **Promoção:** uma candidata vira confirmada ao recorrer em **2 tickets distintos**.
  Duas ocorrências dentro do mesmo ticket contam **uma**. Lição é padrão, não incidente.
- **Janela:** uma candidata que passa **60 dias** sem recorrer é podada.
  Confirmadas e em quarentena nunca expiram.
- **Só confirmadas são carregadas como guidance.** Candidata não se aplica, se observa.
- **`list` nunca escreve.** Ler o arquivo não pode sujar a árvore de trabalho de
  quem está no meio de outra coisa; quem expira candidata é `prune`.
- **Ids nunca são reaproveitados.** Podar `L-004` não libera o número: o contador
  vive no cabeçalho, então uma citação a `L-004` num PR antigo nunca passa a
  apontar para outra lição.

## Os sinais

| Sinal | O que ele classifica |
| --- | --- |
| `ac_uncovered` | Um critério de aceite do ticket não tem teste que possa falhar por ele. |
| `surviving_mutant` | Mutar a implementação deixa a suíte verde: o teste existe, parece cobrir, e não discrimina. |
| `vacuous_assertion` | A asserção não pode falhar por leitura: compara um valor com ele mesmo, ou os dois lados caem no mesmo default. |
| `fixture_unreal` | O dado de teste não pode ocorrer em produção; o teste prova comportamento contra um payload que a fonte real nunca emite. |
| `claim_unmeasured` | Afirmação apresentada como fato sem medição, ou escrita de forma que não pode ser falsificada. |
| `guidance_drift` | A instrução escrita diverge do que o ticket pediu, ou cópias da mesma regra saem de sincronia. |

## Confirmadas — carregue estas como guidance

Corroboradas em tickets distintos. É seguro aplicar.

_nenhuma_

## Candidatas — NÃO carregar como guidance ainda

Vistas uma vez, ou repetidas dentro de um único ticket. Sob observação, não confiáveis. Uma candidata carregada cedo vira superstição: a próxima sessão obedece a um padrão que nunca se provou padrão.

### L-001 — um critério de aceite só está coberto se existir um caso em que ele possa falhar

- sinal: `ac_uncovered`
- recorrência: 1 ticket distinto
- tickets: pr-10
- evidência: PR 10, Critical 1: as quatro fixtures de reply têm um único root inline, então 'agrupada na thread certa' é indistinguível de 'agrupada na única thread'
- registrada: 2026-07-28T01:34:51.460Z
- vista por último: 2026-07-28T01:34:51.460Z

### L-002 — contrato de três estados precisa de asserção para cada estado, inclusive o mais comum em produção

- sinal: `ac_uncovered`
- recorrência: 1 ticket distinto
- tickets: pr-10
- evidência: PR 10, Critical 3: isResolved false tem zero ocorrências na suíte; null coberto 2x, true 1x
- registrada: 2026-07-28T01:34:51.486Z
- vista por último: 2026-07-28T01:34:51.486Z

### L-003 — asserção de ordenação precisa de um caso em que as duas chaves candidatas discordam

- sinal: `surviving_mutant`
- recorrência: 1 ticket distinto
- tickets: pr-10
- evidência: PR 10, Critical 2: trocar createdAt por updatedAt em scripts/waves/fetch-pr-threads.mjs deixa 21/21 verde
- registrada: 2026-07-28T01:34:51.514Z
- vista por último: 2026-07-28T01:34:51.514Z

### L-004 — asserção que compara uma função pura com ela mesma não pode falhar

- sinal: `vacuous_assertion`
- recorrência: 1 ticket distinto
- tickets: pr-10
- evidência: PR 10, Suggestion linha 139: assert.equal(computeFingerprint({}), empty) onde empty é o próprio computeFingerprint({})
- registrada: 2026-07-28T01:34:51.543Z
- vista por último: 2026-07-28T01:34:51.543Z

### L-005 — fixture tem que ser derivada de um payload real medido, não inventada a partir do formato

- sinal: `fixture_unreal`
- recorrência: 1 ticket distinto
- tickets: pr-10
- evidência: PR 10, Critical 2: updated_at menor que created_at; medido em cli/cli#13400 a raiz tem created 12:39:58Z e updated 12:39:59Z
- evidência: PR 10, Suggestion: in_reply_to_id null em comentário-raiz; 3 de 4 comentários reais omitem a chave inteira
- evidência: PR 10, Warning: a factory fixa type User; o payload real traz login Copilot com type Bot, e 4 de 4 comentários em issues/13390 são github-actions[bot]
- registrada: 2026-07-28T01:34:59.383Z
- vista por último: 2026-07-28T01:34:59.442Z

### L-006 — afirmação sobre o que um comando captura só entra no doc depois de medida

- sinal: `claim_unmeasured`
- recorrência: 1 ticket distinto
- tickets: pr-11
- evidência: PR 11, Critical 2: o texto dizia que o commit wip guarda tudo 'por construção'; medido, git commit -am captura 2 de 3 estados sujos e perde o arquivo não rastreado
- registrada: 2026-07-28T01:35:08.832Z
- vista por último: 2026-07-28T01:35:08.832Z

### L-007 — promessa de auditabilidade precisa de registro falsificável com path e linha, não de um agregado

- sinal: `claim_unmeasured`
- recorrência: 1 ticket distinto
- tickets: pr-11
- evidência: PR 11, Warning: '3 achados cortados, nenhuma porta aberta' é infalsificável; o canal onde morre o achado isolado é o não auditável
- registrada: 2026-07-28T01:35:08.862Z
- vista por último: 2026-07-28T01:35:08.862Z

### L-008 — regra de escopo tem que ser escrita por causação, não por localização

- sinal: `guidance_drift`
- recorrência: 1 ticket distinto
- tickets: pr-11
- evidência: PR 11, Critical 1: a issue dizia 'bug preexistente encontrado de passagem' e o texto virou 'localizado fora do diff', o que suprime a lente de Regressão inteira
- registrada: 2026-07-28T01:35:08.892Z
- vista por último: 2026-07-28T01:35:08.892Z

### L-009 — mudar uma regra exige atualizar todas as cópias dela no mesmo commit

- sinal: `guidance_drift`
- recorrência: 1 ticket distinto
- tickets: pr-11
- evidência: PR 11, Warning: o item 6 mudou o mecanismo do stash e as duas cópias não acompanharam; a regra nova de propagação falhou no próprio primeiro uso
- registrada: 2026-07-28T01:35:08.920Z
- vista por último: 2026-07-28T01:35:08.920Z

### L-010 — verbo de CLI citado em documento de processo tem que ser conferido contra a ferramenta instalada antes de virar instrucao

- sinal: `claim_unmeasured`
- recorrência: 1 ticket distinto
- tickets: harness-maestri-port
- evidência: O persona do Maestro instruia 'maestri reassign' por meses. O verbo nao existe: o real e 'maestri role assign Nome Role'. Conferido contra as quatro skills instaladas do Maestri durante o port. Seis outros comandos citados pelo persona (/goal /loop /schedule /usage /workflows /handoff) tambem nao aparecem em nenhuma delas.
- registrada: 2026-07-28T02:18:30.515Z
- vista por último: 2026-07-28T02:18:30.515Z

### L-011 — identificador de exemplo em documentacao colide com o namespace real do repo conforme ele cresce

- sinal: `fixture_unreal`
- recorrência: 1 ticket distinto
- tickets: pr-7
- evidência: O exemplo do marcador em pm.md usa #12. Uma lente calculou 5 numeros de folga e previu que ao passar de #12 a copia vazada viraria aresta legivel sem aviso. O repo chegou em #12 no mesmo dia. Nao explodiu porque #12 saiu PR e nao issue, e a guarda de PR pegou — sorte com camadas, nao desenho.
- registrada: 2026-07-28T02:18:30.546Z
- vista por último: 2026-07-28T02:18:30.546Z

## Quarentena — falharam quando aplicadas

Foram seguidas e o resultado piorou. Não aplique. Ficam registradas para eu revisar; só saem daqui por decisão minha.

_nenhuma_

## A fiação (ainda não implementada)

Hoje o loop só roda por CLI, na mão. O passo que falta é o revisor emitir o
sinal sozinho, no momento em que escreve o achado. Como vai ser:

1. **Quem emite.** A revisão adversarial, ao escrever cada Critical/Warning no
   laudo. O achado já traz o que o `record` precisa: a classe da falha vira
   `--signal`, o ticket em revisão vira `--ticket`, a correção proposta vira a
   frase do `--note`, e o `path:line` medido vira `--evidence`.
2. **A chamada.** Uma linha por achado, depois de publicar o laudo:

   ```
   node scripts/lessons.mjs record \
     --signal surviving_mutant \
     --ticket w1-issue-42 \
     --note "asserção de ordenação precisa de um caso onde as duas chaves discordam" \
     --evidence "PR 10, Critical 2"
   ```

3. **Quem consome.** Quem for implementar roda `list --confirmed` antes de
   escrever código, e trata cada linha como restrição. Nunca `--candidates`.
4. **O retorno.** Quando uma lição confirmada for seguida e o resultado piorar,
   `quarantine --id <id> --reason "<o que deu errado>"`. É isso que impede o
   arquivo de virar dogma: uma lição que falhou sai de circulação.

O que segura a fiação agora: os arquivos do revisor e do orquestrador estão em
PR aberto. Ligar o gatilho no meio disso encavalaria as mudanças. O script
funciona sozinho por CLI até lá — a fiação é acréscimo, não reescrita.
