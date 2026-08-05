#!/usr/bin/env node
// lessons.mjs — the ledger behind the harness lessons loop.
//
// The reviewer supplies judgment: which failure happened, and how to phrase the
// lesson. This script owns everything mechanical — ids, distinct-ticket
// recurrence counting, candidate -> confirmed promotion, pruning and
// quarantine. Bookkeeping by hand is exactly what rots a lessons file, so it
// lives here and not in a prompt.
//
// docs/lessons.md is the whole store: machine-written, never hand-edited. The
// prose IS the state — a lesson's status is the section it sits under, and its
// recurrence is the length of its ticket list. Only `next-id` needs a marker,
// because it is the one value that stops being derivable once a lesson is
// pruned, and reusing a pruned id would repoint every citation of it.
//
// The promotion threshold and the window are code constants rendered into the
// file as prose. They are never read back, so the policy has exactly one source
// and a stale header cannot outvote the code.
//
// Usage:
//   node scripts/lessons.mjs record --signal <signal> --ticket <id> --note "<text>" [--evidence "<ref>"]
//   node scripts/lessons.mjs list [--confirmed|--candidates|--quarantine|--all]
//   node scripts/lessons.mjs promote
//   node scripts/lessons.mjs prune
//   node scripts/lessons.mjs quarantine --id L-001 --reason "<text>"
//
// Every command takes [--store <path>] to work against a file other than the
// repo's own docs/lessons.md.
//
// Exit codes:
//   0  ok
//   1  the store on disk could not be parsed
//   2  bad usage / rejected input
//
// Zero deps, Node stdlib only (repo convention).

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATUS_CANDIDATE = 'candidate';
export const STATUS_CONFIRMED = 'confirmed';
export const STATUS_QUARANTINED = 'quarantined';

// A lesson leaves observation once it has recurred in this many *distinct*
// tickets. Two occurrences inside one ticket are one incident seen twice, not a
// pattern, and promoting on them is how a coincidence becomes a project rule.
export const PROMOTE_THRESHOLD = 2;

// How long an uncorroborated candidate is kept before it is dropped. The two
// errors are not symmetric: a candidate pruned too early is a lesson we never
// learn and never notice, while a candidate kept too long costs one line in a
// file that is explicitly not loaded as guidance. So the window errs long.
export const WINDOW_DAYS = 60;

export const SIGNALS = {
  ac_uncovered:
    'Um critério de aceite do ticket não tem teste que possa falhar por ele.',
  surviving_mutant:
    'Mutar a implementação deixa a suíte verde: o teste existe, parece cobrir, e não discrimina.',
  vacuous_assertion:
    'A asserção não pode falhar por leitura: compara um valor com ele mesmo, ou os dois lados caem no mesmo default.',
  fixture_unreal:
    'O dado de teste não pode ocorrer em produção; o teste prova comportamento contra um payload que a fonte real nunca emite.',
  claim_unmeasured:
    'Afirmação apresentada como fato sem medição, ou escrita de forma que não pode ser falsificada.',
  guidance_drift:
    'A instrução escrita diverge do que o ticket pediu, ou cópias da mesma regra saem de sincronia.',
};

const STORE_REL = join('docs', 'lessons.md');
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const ID_PREFIX = 'L-';
const ID_DIGITS = 3;
const FIRST_ID = 1;
const MIN_NOTE_LENGTH = 12;
const MS_PER_DAY = 86400000;

const TICKET_SEPARATOR = ', ';
const FIELD_SIGNAL = 'sinal';
const FIELD_RECURRENCE = 'recorrência';
const FIELD_TICKETS = 'tickets';
const FIELD_EVIDENCE = 'evidência';
const FIELD_RECORDED = 'registrada';
const FIELD_LAST_SEEN = 'vista por último';
const FIELD_REASON = 'motivo da quarentena';

// Rendered from the ticket list on every write and never read back, so the
// number cannot drift away from the list it counts.
const DERIVED_FIELDS = new Set([FIELD_RECURRENCE]);

const SECTIONS = [
  {
    status: STATUS_CONFIRMED,
    heading: 'Confirmadas — carregue estas como guidance',
    note: 'Corroboradas em tickets distintos. É seguro aplicar.',
  },
  {
    status: STATUS_CANDIDATE,
    heading: 'Candidatas — NÃO carregar como guidance ainda',
    note: 'Vistas uma vez, ou repetidas dentro de um único ticket. Sob observação, não confiáveis. Uma candidata carregada cedo vira superstição: a próxima sessão obedece a um padrão que nunca se provou padrão.',
  },
  {
    status: STATUS_QUARANTINED,
    heading: 'Quarentena — falharam quando aplicadas',
    note: 'Foram seguidas e o resultado piorou. Não aplique. Ficam registradas para eu revisar; só saem daqui por decisão minha.',
  },
];

const STATUS_BY_HEADING = new Map(SECTIONS.map((section) => [section.heading, section.status]));

const STATE_MARKER = /<!--\s*lessons:state\s+next-id=(\d+)\s*-->/;
const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const LESSON_HEADING = /^###\s+(L-\d+)\s+—\s+(.+?)\s*$/;
const FIELD_LINE = /^-\s+([^:]+):\s*(.*?)\s*$/;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC = /[^a-z0-9\s]/g;
const WHITESPACE_RUN = /\s+/g;

// ---------------------------------------------------------------------------
// Pure logic — no I/O below this line until `readStore`.
// ---------------------------------------------------------------------------

export function formatId(number) {
  return `${ID_PREFIX}${String(number).padStart(ID_DIGITS, '0')}`;
}

/**
 * Collapse a value to a single line. Every field is written through this, so no
 * value can ever contain a newline, and therefore no value can forge the `- key:`
 * line that would let a lesson's text smuggle in a second field.
 *
 * @param {string} value
 */
export function sanitize(value) {
  return String(value).replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Identity of a lesson for merging recurrences: its signal plus its text with
 * casing, accents and punctuation folded away. Exact-after-folding only — there
 * is no semantic matching in the standard library, so recurrences merge only if
 * the reviewer phrases the lesson the same terse way twice.
 *
 * @param {string} signal
 * @param {string} text
 */
export function lessonKey(signal, text) {
  const folded = String(text)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  return `${signal}::${folded}`;
}

export function emptyStore() {
  return { nextId: FIRST_ID, lessons: [] };
}

/**
 * Read the store back out of the rendered markdown. Strict on purpose: a line
 * it does not recognise throws instead of being skipped, because silently
 * dropping a lesson is the one failure a ledger must not have.
 *
 * @param {string} text
 * @returns {{nextId: number, lessons: Array<object>}}
 */
export function parseStore(text) {
  const marker = STATE_MARKER.exec(text);
  if (!marker) throw new Error('store has no `lessons:state` marker — is it a lessons file?');

  const store = { nextId: Number(marker[1]), lessons: [] };
  let status = null;
  let lesson = null;
  let lineNumber = 0;

  for (const line of text.split('\n')) {
    lineNumber += 1;

    const section = SECTION_HEADING.exec(line);
    if (section) {
      status = STATUS_BY_HEADING.get(section[1]) ?? null;
      lesson = null;
      continue;
    }

    const heading = LESSON_HEADING.exec(line);
    if (heading) {
      if (!status) throw new Error(`line ${lineNumber}: lesson ${heading[1]} sits outside a known section`);
      lesson = {
        id: heading[1],
        text: heading[2],
        signal: null,
        tickets: [],
        evidence: [],
        status,
        reason: null,
        recorded: null,
        lastSeen: null,
      };
      store.lessons.push(lesson);
      continue;
    }

    if (!lesson) continue;
    const field = FIELD_LINE.exec(line);
    if (!field) continue;

    const [, key, value] = field;
    if (DERIVED_FIELDS.has(key)) continue;
    if (key === FIELD_SIGNAL) lesson.signal = value.replace(/`/g, '');
    else if (key === FIELD_TICKETS) lesson.tickets = value.split(',').map(sanitize).filter(Boolean);
    else if (key === FIELD_EVIDENCE) lesson.evidence.push(value);
    else if (key === FIELD_RECORDED) lesson.recorded = value;
    else if (key === FIELD_LAST_SEEN) lesson.lastSeen = value;
    else if (key === FIELD_REASON) lesson.reason = value;
    else throw new Error(`line ${lineNumber}: ${lesson.id} has unknown field "${key}"`);
  }

  return store;
}

/**
 * Fold one observation into the store. Returns the lesson it landed on and
 * whether that lesson is new, so the caller can report which of the two happened.
 *
 * @param {object} store
 * @param {{signal: string, ticket: string, note: string, evidence?: string|null, now: string}} occurrence
 */
export function recordOccurrence(store, { signal, ticket, note, evidence = null, now }) {
  const text = sanitize(note);
  const key = lessonKey(signal, text);
  const existing = store.lessons.find((lesson) => lessonKey(lesson.signal, lesson.text) === key);

  if (existing) {
    if (!existing.tickets.includes(ticket)) existing.tickets.push(ticket);
    if (evidence && !existing.evidence.includes(evidence)) existing.evidence.push(evidence);
    existing.lastSeen = now;
    return { lesson: existing, created: false };
  }

  const lesson = {
    id: formatId(store.nextId),
    text,
    signal,
    tickets: [ticket],
    evidence: evidence ? [evidence] : [],
    status: STATUS_CANDIDATE,
    reason: null,
    recorded: now,
    lastSeen: now,
  };
  store.nextId += 1;
  store.lessons.push(lesson);
  return { lesson, created: true };
}

/**
 * Promote every candidate that has recurred in enough distinct tickets.
 *
 * Runs inside `record`, and stands alone for the case a single run cannot
 * reach: two waves record the same lesson in different tickets on different
 * branches, and the merge produces a candidate with two tickets that no single
 * run ever saw. Re-deriving status from the ticket list repairs exactly that.
 *
 * @param {object} store
 * @returns {string[]} ids promoted
 */
export function promoteEligible(store) {
  const promoted = [];
  for (const lesson of store.lessons) {
    if (lesson.status !== STATUS_CANDIDATE) continue;
    if (lesson.tickets.length < PROMOTE_THRESHOLD) continue;
    lesson.status = STATUS_CONFIRMED;
    promoted.push(lesson.id);
  }
  return promoted;
}

export function ageInDays(from, now) {
  return (Date.parse(now) - Date.parse(from)) / MS_PER_DAY;
}

/**
 * Drop candidates that went the whole window without recurring. Confirmed and
 * quarantined lessons never expire. The threshold check keeps this safe to run
 * on its own: a candidate that has already earned promotion is never dropped,
 * whatever order the maintenance commands run in.
 *
 * @param {object} store
 * @param {string} now
 * @returns {string[]} ids dropped
 */
export function pruneStale(store, now) {
  const dropped = [];
  store.lessons = store.lessons.filter((lesson) => {
    if (lesson.status !== STATUS_CANDIDATE) return true;
    if (lesson.tickets.length >= PROMOTE_THRESHOLD) return true;
    if (ageInDays(lesson.lastSeen, now) <= WINDOW_DAYS) return true;
    dropped.push(lesson.id);
    return false;
  });
  return dropped;
}

/**
 * Park a lesson that made things worse when it was applied. One call is enough:
 * a confirmed lesson is loaded as guidance every session, so leaving a known
 * misfire in play to wait for a second strike costs more than parking it early.
 *
 * @param {object} store
 * @param {{id: string, reason: string}} penalty
 * @returns {object|null} the lesson, or null when the id is unknown
 */
export function quarantineLesson(store, { id, reason }) {
  const lesson = store.lessons.find((candidate) => candidate.id === id);
  if (!lesson) return null;
  lesson.status = STATUS_QUARANTINED;
  lesson.reason = sanitize(reason);
  return lesson;
}

export function lessonsByStatus(store, status) {
  return store.lessons
    .filter((lesson) => lesson.status === status)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function recurrencePhrase(lesson) {
  const count = lesson.tickets.length;
  return `${count} ticket${count === 1 ? '' : 's'} distinto${count === 1 ? '' : 's'}`;
}

function renderLesson(lesson) {
  const lines = [
    `### ${lesson.id} — ${lesson.text}`,
    '',
    `- ${FIELD_SIGNAL}: \`${lesson.signal}\``,
    `- ${FIELD_RECURRENCE}: ${recurrencePhrase(lesson)}`,
    `- ${FIELD_TICKETS}: ${lesson.tickets.join(TICKET_SEPARATOR)}`,
  ];
  for (const evidence of lesson.evidence) lines.push(`- ${FIELD_EVIDENCE}: ${evidence}`);
  lines.push(`- ${FIELD_RECORDED}: ${lesson.recorded}`);
  lines.push(`- ${FIELD_LAST_SEEN}: ${lesson.lastSeen}`);
  if (lesson.reason) lines.push(`- ${FIELD_REASON}: ${lesson.reason}`);
  lines.push('');
  return lines;
}

function renderSignalTable() {
  const lines = ['| Sinal | O que ele classifica |', '| --- | --- |'];
  for (const [name, description] of Object.entries(SIGNALS)) {
    lines.push(`| \`${name}\` | ${description} |`);
  }
  return lines;
}

const HEADER_NOTE = [
  '> **Escrito por `scripts/lessons.mjs`. Nunca edite este arquivo à mão.**',
  '> A próxima escrita do script sobrescreve qualquer edição manual, e uma edição',
  '> que quebre o formato faz a leitura falhar em vez de perder lições em silêncio.',
  '>',
  '> O revisor fornece o julgamento — qual falha aconteceu e como enunciar a lição.',
  '> O script é dono de tudo que é mecânico: ids, contagem de recorrência por ticket',
  '> distinto, promoção, poda e quarentena. Escrituração na mão é exatamente o que',
  '> apodrece um arquivo de lições, então ela mora aqui e não num prompt.',
];

const POLICY_HEADING = 'A política';
const SIGNALS_HEADING = 'Os sinais';
const WIRING_HEADING = 'A fiação (ainda não implementada)';

function policyBlock() {
  return [
    `## ${POLICY_HEADING}`,
    '',
    `- **Promoção:** uma candidata vira confirmada ao recorrer em **${PROMOTE_THRESHOLD} tickets distintos**.`,
    '  Duas ocorrências dentro do mesmo ticket contam **uma**. Lição é padrão, não incidente.',
    `- **Janela:** uma candidata que passa **${WINDOW_DAYS} dias** sem recorrer é podada.`,
    '  Confirmadas e em quarentena nunca expiram.',
    '- **Só confirmadas são carregadas como guidance.** Candidata não se aplica, se observa.',
    '- **`list` nunca escreve.** Ler o arquivo não pode sujar a árvore de trabalho de',
    '  quem está no meio de outra coisa; quem expira candidata é `prune`.',
    '- **Ids nunca são reaproveitados.** Podar `L-004` não libera o número: o contador',
    '  vive no cabeçalho, então uma citação a `L-004` num PR antigo nunca passa a',
    '  apontar para outra lição.',
    '',
  ];
}

function wiringBlock() {
  return [
    `## ${WIRING_HEADING}`,
    '',
    'Hoje o loop só roda por CLI, na mão. O passo que falta é o revisor emitir o',
    'sinal sozinho, no momento em que escreve o achado. Como vai ser:',
    '',
    '1. **Quem emite.** O revisor, ao escrever cada Critical/Warning no',
    '   laudo. O achado já traz o que o `record` precisa: a classe da falha vira',
    '   `--signal`, o ticket em revisão vira `--ticket`, a correção proposta vira a',
    '   frase do `--note`, e o `path:line` medido vira `--evidence`.',
    '2. **A chamada.** Uma linha por achado, depois de publicar o laudo:',
    '',
    '   ```',
    '   node scripts/lessons.mjs record \\',
    '     --signal surviving_mutant \\',
    '     --ticket w1-issue-42 \\',
    '     --note "asserção de ordenação precisa de um caso onde as duas chaves discordam" \\',
    '     --evidence "PR 10, Critical 2"',
    '   ```',
    '',
    '3. **Quem consome.** Quem for implementar roda `list --confirmed` antes de',
    '   escrever código, e trata cada linha como restrição. Nunca `--candidates`.',
    '4. **O retorno.** Quando uma lição confirmada for seguida e o resultado piorar,',
    '   `quarantine --id <id> --reason "<o que deu errado>"`. É isso que impede o',
    '   arquivo de virar dogma: uma lição que falhou sai de circulação.',
    '',
    'O que segura a fiação agora: os arquivos do revisor e do orquestrador estão em',
    'PR aberto. Ligar o gatilho no meio disso encavalaria as mudanças. O script',
    'funciona sozinho por CLI até lá — a fiação é acréscimo, não reescrita.',
    '',
  ];
}

/**
 * Render the whole file. Deterministic: same store in, same bytes out.
 *
 * @param {object} store
 */
export function renderStore(store) {
  const lines = [
    '# Lições',
    '',
    `<!-- lessons:state next-id=${store.nextId} -->`,
    '',
    ...HEADER_NOTE,
    '',
    ...policyBlock(),
    `## ${SIGNALS_HEADING}`,
    '',
    ...renderSignalTable(),
    '',
  ];

  for (const section of SECTIONS) {
    lines.push(`## ${section.heading}`, '', section.note, '');
    const entries = lessonsByStatus(store, section.status);
    if (entries.length === 0) {
      lines.push('_nenhuma_', '');
      continue;
    }
    for (const lesson of entries) lines.push(...renderLesson(lesson));
  }

  lines.push(...wiringBlock());
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export function readStore(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw error;
  }
  return parseStore(text);
}

export function writeStore(path, store) {
  writeFileSync(path, renderStore(store), 'utf8');
}

function die(exitCode, message) {
  process.stderr.write(`lessons: ${message}\n`);
  process.exit(exitCode);
}

const EXIT_OK = 0;
const EXIT_STORE_UNREADABLE = 1;
const EXIT_USAGE = 2;

const USAGE = `usage: lessons.mjs <command> [options]

  record --signal <signal> --ticket <id> --note "<text>" [--evidence "<ref>"]
  list [--confirmed|--candidates|--quarantine|--all]
  promote
  prune
  quarantine --id <id> --reason "<text>"

Every command takes [--store <path>]. Signals:
${Object.keys(SIGNALS)
  .map((name) => `  ${name}`)
  .join('\n')}`;

const FLAGS = new Set([
  '--signal',
  '--ticket',
  '--note',
  '--evidence',
  '--id',
  '--reason',
  '--store',
]);
const LIST_FILTERS = new Map([
  ['--confirmed', STATUS_CONFIRMED],
  ['--candidates', STATUS_CANDIDATE],
  ['--quarantine', STATUS_QUARANTINED],
  ['--all', null],
]);

export function parseArgs(argv) {
  const options = { command: null, values: {}, status: STATUS_CONFIRMED, help: false };
  let statusChosen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (FLAGS.has(arg)) {
      options.values[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (LIST_FILTERS.has(arg)) {
      options.status = LIST_FILTERS.get(arg);
      statusChosen = true;
    } else if (arg.startsWith('-')) {
      return { error: `unknown flag ${arg}` };
    } else if (options.command === null) {
      options.command = arg;
    } else {
      return { error: `unexpected argument ${arg}` };
    }
  }

  if (statusChosen && options.command !== 'list') {
    return { error: 'status filters only apply to `list`' };
  }
  return options;
}

function requireValue(values, flag) {
  const value = values[flag];
  if (value === undefined || String(value).trim() === '') {
    die(EXIT_USAGE, `--${flag} is required\n\n${USAGE}`);
  }
  return String(value).trim();
}

function loadStore(path) {
  try {
    return readStore(path);
  } catch (error) {
    die(EXIT_STORE_UNREADABLE, `cannot read ${path}: ${error.message}`);
  }
}

function describe(lesson) {
  return `${lesson.id} (${lesson.status}, ${recurrencePhrase(lesson)}) [${lesson.signal}]: ${lesson.text}`;
}

function cmdRecord(path, values) {
  const signal = requireValue(values, 'signal');
  if (!(signal in SIGNALS)) {
    die(EXIT_USAGE, `unknown signal "${signal}" — expected one of: ${Object.keys(SIGNALS).join(', ')}`);
  }
  const ticket = requireValue(values, 'ticket');
  if (ticket.includes(',')) die(EXIT_USAGE, 'a ticket id cannot contain a comma');
  const note = sanitize(requireValue(values, 'note'));
  if (note.length < MIN_NOTE_LENGTH) {
    die(EXIT_USAGE, `--note is too short — state the lesson as one terse, actionable sentence`);
  }
  const evidence = values.evidence ? sanitize(values.evidence) : null;

  const store = loadStore(path);
  const now = new Date().toISOString();
  const { lesson, created } = recordOccurrence(store, { signal, ticket, note, evidence, now });
  const promoted = promoteEligible(store).includes(lesson.id);
  const dropped = pruneStale(store, now);
  writeStore(path, store);

  const verb = created ? 'ADDED' : 'UPDATED';
  const promotion = promoted ? ' — PROMOTED to confirmed' : '';
  process.stdout.write(`${verb} ${describe(lesson)}${promotion}\n`);
  if (dropped.length > 0) process.stdout.write(`pruned ${dropped.join(', ')}\n`);
  return EXIT_OK;
}

function cmdList(path, status) {
  const store = loadStore(path);
  const entries = status === null ? [...store.lessons].sort((a, b) => a.id.localeCompare(b.id)) : lessonsByStatus(store, status);
  if (entries.length === 0) {
    process.stdout.write(`(no ${status ?? 'recorded'} lessons)\n`);
    return EXIT_OK;
  }
  for (const lesson of entries) process.stdout.write(`${describe(lesson)}\n`);
  return EXIT_OK;
}

function cmdPromote(path) {
  const store = loadStore(path);
  const promoted = promoteEligible(store);
  writeStore(path, store);
  process.stdout.write(`promoted ${promoted.length}: ${promoted.join(', ') || '—'}\n`);
  return EXIT_OK;
}

function cmdPrune(path) {
  const store = loadStore(path);
  const dropped = pruneStale(store, new Date().toISOString());
  writeStore(path, store);
  process.stdout.write(`pruned ${dropped.length}: ${dropped.join(', ') || '—'}\n`);
  return EXIT_OK;
}

function cmdQuarantine(path, values) {
  const id = requireValue(values, 'id').toUpperCase();
  const reason = requireValue(values, 'reason');
  const store = loadStore(path);
  const lesson = quarantineLesson(store, { id, reason });
  if (!lesson) die(EXIT_USAGE, `no lesson with id ${id}`);
  writeStore(path, store);
  process.stdout.write(`QUARANTINED ${describe(lesson)}\n`);
  return EXIT_OK;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.error) die(EXIT_USAGE, `${options.error}\n\n${USAGE}`);
  if (options.help || !options.command) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(EXIT_OK);
  }

  const path = options.values.store ? options.values.store : join(REPO_ROOT, STORE_REL);

  if (options.command === 'record') process.exit(cmdRecord(path, options.values));
  if (options.command === 'list') process.exit(cmdList(path, options.status));
  if (options.command === 'promote') process.exit(cmdPromote(path));
  if (options.command === 'prune') process.exit(cmdPrune(path));
  if (options.command === 'quarantine') process.exit(cmdQuarantine(path, options.values));
  die(EXIT_USAGE, `unknown command "${options.command}"\n\n${USAGE}`);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
