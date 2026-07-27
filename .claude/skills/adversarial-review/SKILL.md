---
name: adversarial-review
description: >-
  Revisão adversarial de um diff por duas lentes independentes. Use quando o
  usuário pedir "revisão adversarial", "revisa direito", "duas lentes", "quero
  dois revisores", e antes de abrir um PR não trivial. Spawna o agente
  `reviewer` duas vezes em paralelo, cada um com uma lente distinta e contexto
  fresco, e confronta os dois laudos.
---

# Revisão adversarial

Dois revisores de contexto fresco olham o mesmo diff por lentes diferentes, sem
saber o que o implementador achou do próprio trabalho.

Quando as duas lentes chegam ao mesmo achado por caminhos diferentes, isso é o
sinal mais forte que uma revisão produz — muito mais forte que dois revisores
redundantes concordando. Esse sinal só existe enquanto a independência entre os
dois for preservada; todo o protocolo abaixo existe para protegê-la.

## Protocolo

1. **Fixe o escopo.** O comando de diff exato (`git diff <base>...HEAD`) e o
   requisito original, copiado literalmente — issue, ticket, ou o pedido do
   usuário. Se o requisito não estiver escrito em lugar nenhum, escreva-o antes
   de spawnar: revisor sem requisito revisa o próprio gosto.
2. **Escolha duas lentes distintas** (ver catálogo abaixo).
3. **Confira o baseline** antes de propor qualquer gate (ver seção própria).
4. **Spawne os dois `reviewer` em paralelo, numa única mensagem.** Duas chamadas
   Agent na mesma resposta — é a única forma de ter concorrência real, e de
   garantir que nenhum dos dois viu o resultado do outro.
5. **Confronte os dois laudos** (ver "Leitura do resultado").
6. **Reporte ao humano** no formato de saída do fim deste arquivo.

### O que cada revisor recebe

Apenas duas coisas: **a lente** e **o comando de diff + o requisito original**.

Não passe, em hipótese alguma:

- o relatório do implementador;
- o plano que gerou a mudança;
- a sua própria suspeita sobre onde está o bug;
- o laudo do outro revisor.

Cada um desses transmite a narrativa de quem escreveu o código. Contaminado, o
revisor converge por contágio e não por evidência — e convergência contaminada
tem exatamente o mesmo formato da convergência real, com nenhum do valor. Depois
de misturados, não há como separar os dois.

## Escolha das lentes

| Lente | A pergunta que ela faz |
|---|---|
| Correção | O código faz o que o requisito pede, no caminho feliz e nas bordas? |
| Segurança | O que um input hostil consegue atravessar? Onde está o limite de confiança? |
| Integridade de dados e reversibilidade | O que isso grava? Dá para desfazer? Se rodar errado uma vez, o dado errado fica? |
| Ativação no dado real | Isso dispara no dado real? Com que frequência, em que volume, sobre qual registro de produção? |
| Regressão | O que já funcionava e passa a depender disso? Quem chamava o caminho antigo? |
| Manutenibilidade | O próximo a mexer aqui entende, ou precisa reconstruir o raciocínio? |
| Operação | Quando falhar às 3h da manhã, dá para descobrir por quê com o que ficou registrado? |

**Regra da distinção.** Antes de spawnar, imagine um bug que a lente A pega e a B
não vê, **e** outro que a B pega e a A não vê. Se você não consegue imaginar os
dois, as lentes são a mesma com dois nomes — troque uma. Diversidade pega modo de
falha que redundância não pega.

**Ancore uma lente no raio de dano da mudança:**

- grava ou migra dado → integridade de dados e reversibilidade;
- integração nova ou dependência externa → ativação no dado real;
- toca autenticação, permissão ou input de terceiro → segurança;
- muda caminho quente ou fluxo de erro → operação.

**A segunda lente é a que você não teria escolhido sozinho.** Duas lentes que
você já considera "as óbvias para este diff" costumam olhar para o mesmo lugar.

## Baseline primeiro

Antes de ligar qualquer gate — CI obrigatório, hook de commit, required check —
exija a suíte **verde**. Gate ligado sobre suíte vermelha trava todas as frentes
por um vermelho que não é de nenhuma delas.

Se a suíte estiver vermelha por motivo alheio ao diff, **isso é o primeiro achado
do relatório**, não uma nota de rodapé sobre ambiente. Suíte quebrada há semanas
sem ninguém saber é o achado, e a mudança em revisão não é responsável por ela —
diga as duas coisas.

## Exija número, não raciocínio

Achado sobre performance, janela, timeout, retry/backoff, limite ou cota vale o
**número medido**, não o argumento.

- Não decide nada: "o backoff parece curto para essa janela".
- Decide: "o backoff cobre 6s contra uma janela mínima de 25 min — insuficiente
  por fator 250".

Decisão documentada com número sobrevive a auditoria; com raciocínio, não. Se o
número não foi medido nesta passada, o achado sai rotulado como **HIPÓTESE**,
acompanhado da medição que o decide.

## Antes de "como consertar", pergunte "isso deve existir?"

Para todo achado crítico em código novo ou pouco usado, a primeira pergunta é se
o código deveria existir, não como corrigi-lo. Deleção é correção válida e
costuma ser a mais barata — reescrever o miolo de algo que não deveria estar lá é
trabalho caro para preservar um erro.

## Leitura do resultado

**Convergência** — os dois chegaram ao mesmo achado por caminhos diferentes:
prioridade máxima, trate como bloqueante até prova em contrário. É este o produto
do protocolo; não o dilua misturando com os achados isolados.

**Divergência** — um aponta, o outro não vê problema: **não decida em silêncio.**
Leve as duas posições ao humano, cada uma com o trecho de código que a sustenta.
Escolher um lado sozinho joga fora exatamente a informação que a segunda lente
custou a produzir.

**Silêncio dos dois** — não é prova de ausência. Quem reporta "nada encontrado"
reporta junto a **cobertura**: que arquivos leu e o que a lente não alcança. Laudo
limpo sem cobertura declarada é laudo vazio.

## Formato de saída

```
## Convergente (as duas lentes — prioridade)
- `path:line` — achado. Como cada lente chegou nele.

## Divergente (decisão do humano)
- `path:line` — o que a lente A afirma; o que a lente B afirma; o trecho em disputa.

## Isolado (uma lente só)
- `path:line` — achado, e por qual lente.

## Cobertura
- Lente A: o que olhou, o que não olhou.
- Lente B: o que olhou, o que não olhou.
- Baseline: estado da suíte antes da revisão.
```
