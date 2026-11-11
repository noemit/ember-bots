/**
 * Session names: "Frantic Mechanic", "Diligent Cartographer", "Spotted Fox".
 *
 * A new conversation has no title on Hearth (its metadata is absent until someone names it), and
 * Ember used to fall back to the numeric id — so every fresh session was "57458". This derives a
 * name locally, from the first message a person is about to send, at the moment the conversation is
 * created: no model call, no randomness, and it works offline.
 *
 * The shape is `<Adjective> <Noun>`, and **the noun is always a person or a creature**:
 *
 *   - **The message selects the noun from a fixed roster; it never contributes a word to it.** A
 *     matched role is a *kind of work* (fix → Mechanic, plan → Cartographer, research → Scout); when
 *     nothing matches, a seeded creature (Fox, Magpie, Otter…) carries it. The message decides
 *     *which* noun fits, but no token of the message ever reaches the name — which is what makes
 *     "What Gardener" or "Handle Way" structurally impossible rather than merely unlikely.
 *
 *     (Earlier revisions of this comment claimed the noun did not come "from the message" at all.
 *     That was wrong and misled two readers: the message absolutely *is* read, by `matchRole` and
 *     `detectTone`. What is forbidden is *quoting* it. See `sessionNames.ts` for the layer that does
 *     take a subject word from the human's own request.)
 *   - **The adjective is the message's tone, and it is most of what is drawn.** Breakage ("crash",
 *     "broken", "flapping", "drops", "blank", a pasted stack trace) gives *Frantic*, *Stretched*,
 *     *Harried*; a plan gives *Methodical*, *Deliberate*, *Diligent*; curiosity ("how", "why", "look
 *     into") gives *Curious*, *Inquisitive*, *Inquiring*; tidying something small gives *Brisk*,
 *     *Deft*, *Snappy*. No discernible tone → `neutral`, the widest and calmest row, and the only
 *     home of the slow and the dreamy.
 *
 *     **This is measured, not asserted.** 0.88.0 gave every tone a 22-word shared middle with its own
 *     words appended; the draw hashes over the whole row, so 65–80% of draws never reached a tone
 *     word and a crash came out "Gentle Beetle" or "Observant Mechanic". Each row is now ~95%
 *     tone-carrying with a single shared word, and `sessionNames.test.ts` measures the share rather
 *     than trusting the comment: at 200 seeds, ≥55% of breakage names are tone-carrying, no placid
 *     word is ever drawn for a crash, and a crash's and a plan's adjective sets are disjoint.
 *   - **Adjective and noun must not fight.** Every noun is a person or a creature, so the pool is
 *     chosen per *kind*: a creature on a bad day is *Skittish* or *Ruffled* — alarmed at the problem,
 *     never *Feverish* (a disease) and never *Gentle* (the pair the brief forbids) — and no pool
 *     holds an adjective that reads as a thing's state ("Broken", "Battered", "Halted") or as a
 *     judgement of the person ("Clumsy", "Lazy" on a bug report).
 *   - **Deterministic, and it does not repeat itself.** Everything is picked from one 32-bit hash
 *     of the seed — the conversation's own id when it exists, else the draft's key, which `App.tsx`
 *     builds as `instance|folder|message` so two identical first messages in different places
 *     differ. With no rail to avoid, the first draw wins. Against a `taken` list the walk prefers a
 *     **noun the rail does not already hold too often**, so a folder of "fix …" sessions is a band of
 *     colleagues rather than twenty-six Mechanics — the owner's "i have too many gardeners". The
 *     roster is 96 nouns wide (32 matched trades, 22 keyword-less crafts, 42 creatures) precisely so
 *     that a hundred sessions can nearly all be different people.
 *
 * The name is set once, at creation, and is editable exactly like any other title. Nothing here
 * ever renames an existing session.
 */

/**
 * One entry in the roster.
 *
 * `keywords` empty means the entry is a *stand-in* rather than a signal: a creature (a fallback used
 * when the message suggests no kind of work) or one of the calm crafts a creature-shaped tone
 * suggests. Those are only ever *offered* by a tone, never matched from the message.
 *
 * `kind` says what the noun is, which decides the adjectives it will take: a `wild` adjective needs a
 * creature, a `battered` one wants a trade.
 */
type Role = {
  name: string;
  /** Verbs and subjects that point at this role. Empty for the stand-ins. */
  keywords: readonly string[];
  kind: 'trade' | 'creature';
};

/**
 * The roster. A matched role is always a trade; the creatures follow and are the fallback.
 *
 * Matching prefers the longest keyword, so "unit test" beats "test" regardless of position. A
 * keyword is what the work *is*, not what a message merely mentions: "report", "ends" and "whole"
 * earn no role just to spend a name.
 */
export const ROLES: readonly Role[] = [
  // ---- Trades: matched from the first message ----
  { name: 'Engineer', kind: 'trade', keywords: ['build', 'implement', 'wire', 'code', 'add', 'endpoint', 'api', 'feature', 'integrate'] },
  { name: 'Mechanic', kind: 'trade', keywords: ['fix', 'bug', 'broken', 'crash', 'error', 'failing', 'repair', 'hotfix', 'regression', 'flaky'] },
  { name: 'Inspector', kind: 'trade', keywords: ['test', 'tests', 'verify', 'check', 'qa', 'coverage', 'screenshot', 'harness', 'assertion'] },
  { name: 'Auditor', kind: 'trade', keywords: ['review', 'audit', 'permission', 'auth', 'access', 'compliance', 'threat'] },
  { name: 'Editor', kind: 'trade', keywords: ['rename', 'copy', 'wording', 'proofread', 'polish', 'edit', 'title', 'label'] },
  { name: 'Scribe', kind: 'trade', keywords: ['docs', 'readme', 'changelog', 'document', 'write', 'draft', 'notes'] },
  { name: 'Architect', kind: 'trade', keywords: ['refactor', 'restructure', 'schema', 'module', 'architecture', 'interface'] },
  { name: 'Scout', kind: 'trade', keywords: ['research', 'explore', 'compare', 'investigate', 'survey', 'evaluate', 'look up', 'spike'] },
  { name: 'Cartographer', kind: 'trade', keywords: ['plan', 'roadmap', 'outline', 'strategy', 'milestone', 'map', 'design'] },
  { name: 'Curator', kind: 'trade', keywords: ['collect', 'shortlist', 'organise', 'organize', 'dataset', 'gather', 'curate'] },
  { name: 'Shipwright', kind: 'trade', keywords: ['deploy', 'release', 'pipeline', 'docker', 'ship', 'distribution', 'install', 'build script'] },
  { name: 'Analyst', kind: 'trade', keywords: ['measure', 'metrics', 'benchmark', 'usage', 'stats', 'performance', 'timing', 'profile'] },
  { name: 'Navigator', kind: 'trade', keywords: ['route', 'navigate', 'path', 'link', 'redirect', 'network', 'flow', 'reconnect', 'tailscale', 'tailnet', 'tunnel', 'listener', 'socket', 'dns', 'proxy', 'ssh'] },
  { name: 'Translator', kind: 'trade', keywords: ['translate', 'localise', 'localize', 'i18n', 'language', 'locale'] },
  { name: 'Librarian', kind: 'trade', keywords: ['search', 'catalogue', 'catalog', 'archive', 'files', 'folder'] },
  { name: 'Chronicler', kind: 'trade', keywords: ['log', 'history', 'timeline', 'activity', 'record', 'journal'] },
  { name: 'Designer', kind: 'trade', keywords: ['ui', 'ux', 'style', 'theme', 'colour', 'color', 'layout', 'typography'] },
  { name: 'Negotiator', kind: 'trade', keywords: ['decide', 'decision', 'tradeoff', 'choose', 'options', 'agree', 'prioritise', 'prioritize'] },
  { name: 'Accountant', kind: 'trade', keywords: ['cost', 'price', 'pricing', 'budget', 'spend', 'billing', 'tokens', 'invoice'] },
  { name: 'Sentinel', kind: 'trade', keywords: ['watch', 'monitor', 'alert', 'health', 'uptime', 'watchdog', 'probe', 'heartbeat'] },
  { name: 'Janitor', kind: 'trade', keywords: ['clean', 'tidy', 'prune', 'remove', 'delete', 'unused', 'stale', 'dedupe'] },
  { name: 'Porter', kind: 'trade', keywords: ['migrate', 'move', 'port', 'upgrade', 'convert'] },
  { name: 'Teacher', kind: 'trade', keywords: ['explain', 'teach', 'learn', 'what is', 'how does', 'why does', 'understand'] },
  { name: 'Interviewer', kind: 'trade', keywords: ['question', 'clarify', 'requirements', 'brief', 'spec'] },
  { name: 'Foreman', kind: 'trade', keywords: ['orchestrate', 'coordinate', 'delegate', 'crew', 'workers', 'parallel', 'spawn'] },
  { name: 'Courier', kind: 'trade', keywords: ['send', 'notify', 'email', 'message', 'ping', 'forward', 'webhook'] },
  { name: 'Sorter', kind: 'trade', keywords: ['sort', 'triage', 'order', 'merge', 'group', 'arrange'] },
  { name: 'Warden', kind: 'trade', keywords: ['policy', 'rules', 'limits', 'enforce', 'guardrail', 'sandbox', 'scope'] },
  { name: 'Scheduler', kind: 'trade', keywords: ['schedule', 'cron', 'daily', 'weekly', 'timer', 'recurring', 'reminder'] },
  { name: 'Estimator', kind: 'trade', keywords: ['estimate', 'forecast', 'predict', 'projection', 'effort'] },
  { name: 'Prototyper', kind: 'trade', keywords: ['prototype', 'experiment', 'try out', 'poc', 'scratch', 'playground'] },
  { name: 'Pilot', kind: 'trade', keywords: ['drive', 'run through', 'smoke', 'onboard', 'walkthrough', 'manual'] },

  // ---- Trades with no keyword: the calm crafts a quiet tone offers ----
  // These used to be the "playful fallback". They are person-nouns, so they stay in the roster, but
  // they are now reached only by *tone* and by a collision that has run out of the message's own
  // noun — never by a word of the message and never as the fallback, which is a creature's job.
  // Sized with the creatures on purpose: a folder of a hundred short sessions should rarely show
  // the same noun twice in a row (owner: "i have too many gardeners").
  { name: 'Gardener', kind: 'trade', keywords: [] },
  { name: 'Weaver', kind: 'trade', keywords: [] },
  { name: 'Botanist', kind: 'trade', keywords: [] },
  { name: 'Brewer', kind: 'trade', keywords: [] },
  { name: 'Calligrapher', kind: 'trade', keywords: [] },
  { name: 'Lamplighter', kind: 'trade', keywords: [] },
  { name: 'Basketmaker', kind: 'trade', keywords: [] },
  { name: 'Bookbinder', kind: 'trade', keywords: [] },
  { name: 'Potter', kind: 'trade', keywords: [] },
  { name: 'Carpenter', kind: 'trade', keywords: [] },
  { name: 'Miller', kind: 'trade', keywords: [] },
  { name: 'Fletcher', kind: 'trade', keywords: [] },
  { name: 'Cobbler', kind: 'trade', keywords: [] },
  { name: 'Thatcher', kind: 'trade', keywords: [] },
  { name: 'Mason', kind: 'trade', keywords: [] },
  { name: 'Wheelwright', kind: 'trade', keywords: [] },
  { name: 'Cooper', kind: 'trade', keywords: [] },
  { name: 'Chandler', kind: 'trade', keywords: [] },
  { name: 'Saddler', kind: 'trade', keywords: [] },
  { name: 'Glazier', kind: 'trade', keywords: [] },
  { name: 'Roper', kind: 'trade', keywords: [] },
  { name: 'Tanner', kind: 'trade', keywords: [] },

  // ---- Creatures: the fallback when the message suggests no kind of work ----
  // A generous list on purpose: a session with no discernible work should still sound like
  // *somebody*, and 22 was too few to give a long rail of idle sessions their own animal.
  { name: 'Fox', kind: 'creature', keywords: [] },
  { name: 'Magpie', kind: 'creature', keywords: [] },
  { name: 'Otter', kind: 'creature', keywords: [] },
  { name: 'Heron', kind: 'creature', keywords: [] },
  { name: 'Badger', kind: 'creature', keywords: [] },
  { name: 'Hare', kind: 'creature', keywords: [] },
  { name: 'Sparrow', kind: 'creature', keywords: [] },
  { name: 'Moth', kind: 'creature', keywords: [] },
  { name: 'Beetle', kind: 'creature', keywords: [] },
  { name: 'Raven', kind: 'creature', keywords: [] },
  { name: 'Lynx', kind: 'creature', keywords: [] },
  { name: 'Marmot', kind: 'creature', keywords: [] },
  { name: 'Ferret', kind: 'creature', keywords: [] },
  { name: 'Wren', kind: 'creature', keywords: [] },
  { name: 'Salmon', kind: 'creature', keywords: [] },
  { name: 'Hedgehog', kind: 'creature', keywords: [] },
  { name: 'Kingfisher', kind: 'creature', keywords: [] },
  { name: 'Newt', kind: 'creature', keywords: [] },
  { name: 'Owl', kind: 'creature', keywords: [] },
  { name: 'Robin', kind: 'creature', keywords: [] },
  { name: 'Stoat', kind: 'creature', keywords: [] },
  { name: 'Puffin', kind: 'creature', keywords: [] },
  { name: 'Pike', kind: 'creature', keywords: [] },
  { name: 'Kestrel', kind: 'creature', keywords: [] },
  { name: 'Cormorant', kind: 'creature', keywords: [] },
  { name: 'Warbler', kind: 'creature', keywords: [] },
  { name: 'Shrew', kind: 'creature', keywords: [] },
  { name: 'Mole', kind: 'creature', keywords: [] },
  { name: 'Marten', kind: 'creature', keywords: [] },
  { name: 'Dormouse', kind: 'creature', keywords: [] },
  { name: 'Curlew', kind: 'creature', keywords: [] },
  { name: 'Lapwing', kind: 'creature', keywords: [] },
  { name: 'Rook', kind: 'creature', keywords: [] },
  { name: 'Chough', kind: 'creature', keywords: [] },
  { name: 'Weasel', kind: 'creature', keywords: [] },
  { name: 'Gull', kind: 'creature', keywords: [] },
  { name: 'Plover', kind: 'creature', keywords: [] },
  { name: 'Swallow', kind: 'creature', keywords: [] },
  { name: 'Finch', kind: 'creature', keywords: [] },
  { name: 'Dunnock', kind: 'creature', keywords: [] },
  { name: 'Bittern', kind: 'creature', keywords: [] },
  { name: 'Linnet', kind: 'creature', keywords: [] },
];
/** Nouns used only if the roster's own default is exhausted (it never is in practice). */
const LAST_RESORT_ROLE = 'Fox';

/** Words that carry no topic: articles, fillers, pronouns and the "can you…" scaffolding. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been',
  'i', 'im', 'we', 'us', 'you', 'your', 'our', 'my', 'me', 'let', 'lets', 'can', 'could', 'would', 'should',
  'will', 'please', 'thanks', 'thank', 'hi', 'hey', 'hello', 'ok', 'okay', 'so', 'just', 'now', 'then',
  'and', 'or', 'but', 'for', 'with', 'from', 'into', 'onto', 'about', 'on', 'in', 'at', 'to', 'of', 'by',
  'as', 'if', 'when', 'where', 'what', 'how', 'why', 'who', 'which', 'some', 'any', 'all', 'more', 'most',
  'up', 'out', 'off', 'again', 'also', 'there', 'here', 'have', 'has', 'had', 'do', 'does', 'did', 'make',
  'sure', 'need', 'want', 'like', 'get', 'got', 'go', 'goes', 'one', 'two', 'new', 'very', 'really',
  'hmm', 'hm', 'um', 'ah', 'oh', 'yes', 'no', 'nah', 'maybe', 'continue', 'carry',
]);

/**
 * A vocabulary that would give the *old* naming bug away if it ever reached a name: question words,
 * scaffolding, and the words the owner reported ("What Gardener", "Handle Way", "Access …").
 *
 * It is only a test hook — the derivation has no path from a message token to a name — but it makes
 * `sessionNames.test.ts` able to ask a property question ("did any of this message's words survive
 * into the name?") instead of eyeballing strings. Kept here rather than in the test so the two agree
 * about what a "scaffolding" word is.
 */
export const MESSAGE_VOCABULARY = new Set([
  ...STOP_WORDS,
  'handle', 'handles', 'handled', 'way', 'ways', 'endpoint', 'endpoints', 'access', 'added', 'add',
  'whether', 'everything', 'thing', 'things', 'something', 'anything', 'file', 'files', 'test', 'tests',
  'code', 'bug', 'bugs', 'fix', 'fixes', 'plan', 'plans', 'build', 'change', 'changes', 'move', 'moved',
]);

/**
 * Deterministic 32-bit hash (FNV-1a), the same shape `blob/seed.ts` uses.
 *
 * The **raw** FNV value on purpose, with no finalizer: seeding is the whole job here, and
 * `pickFrom`/`nextSeed` below take the finalisation out of it in a way that makes stepping honest.
 * The historic shape stays because tests and one call site name it, and because a changed hash means
 * every existing behaviour's expected name changes too.
 */
export const hashSeed = (value: string): number => {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/**
 * A seeded draw from `[0, size)`, in two stages, because each stage alone has a known failure.
 *
 * FNV-1a is a fine spread of *long* inputs and a poor source of *small* offsets, and the obvious
 * repairs each break something else, so both are measured rather than assumed:
 *
 *   - `hash % size` gives near-identical inputs the same bucket (`short piece 0` … `short piece 5` —
 *     the shape of two idle sessions — landed on six identical names): FNV mixes each byte with its
 *     neighbours, so only the last few characters reach the bits a modulo can see.
 *   - A Murmur finalizer fixes that, but has an *anniversary* on short sequential ids, and then the
 *     low bits of its own output are narrow: 64 buckets filled only 27 of themselves from 200 seeds.
 *     (`conversation-1` … `conversation-200` came out as 257 names over 1000 seeds instead of ~500.)
 *   - Taking one *bucket* of the 32-bit range instead of a modulo fixed the second half of that
 *     (62–64 of 64 buckets) but is blind to small differences in the input unless the value is
 *     finalised first: on the raw hash it filled 32 of 64.
 *
 * So: **finalise, then bucket**. The multiply-xor-shift is MurmurHash3's `fmix` with a top shift
 * first, which has no anniversary on consecutive ids; the bucket division uses every bit the
 * finalizer produced rather than the few a modulo keeps. Measured: 200 distinct seeds fill 62–64 of
 * 64 noun buckets, and role-matched text no longer drowns the seed (the old code gave thirty
 * different "fix …" messages one name).
 */
const draw = (seed: number, size: number): number => {
  let hash = seed >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2c1b3c6d);
  hash ^= hash >>> 12;
  hash = Math.imul(hash, 0x297a2d39);
  hash ^= hash >>> 15;
  return Math.floor(((hash >>> 0) / 4294967296) * size);
};

/**
 * How many seeded draws a collision may walk.
 *
 * The walk has to be able to reach **every noun**, because "a different noun" is the whole answer to
 * a rail with too many gardeners in it. At the old 96, a third of the roster was unreachable from any
 * seed (measured: 26 nouns out of 64), so the walk kept drawing from the few it could see. Sized past
 * nouns × 3 now, with `sessionNames.test.ts` proving every noun is reachable rather than trusting
 * the number.
 */
const CANDIDATE_STEPS = 400;

/**
 * A noun the rail already holds this many times is a repeat: prefer one it holds fewer of.
 *
 * Two is the floor, because on a short rail any repeat is noticeable. Above that the limit grows
 * with the rail — slowly, one step per roster's worth of sessions — so a hundred sessions can all
 * carry a different noun and only a rail longer than the roster lets any noun reach four.
 */
const NOUN_REPEAT_LIMIT = 2;

/**
 * The seed after one step of collision resolution.
 *
 * Two coprime multipliers instead of `seed + 1`: consecutive seeds must not walk consecutive names
 * (two sessions started a minute apart would differ by a counter), and `taken: []` must not hand back
 * the same first name as an empty list would have offered if the step were folded into one modulo.
 */
const nextSeed = (seed: number, step: number): number =>
  (Math.imul(seed, 0x9e3779b1) + Math.imul(step, 0x85ebca6b)) >>> 0;

/** "e2e", "ui", "ci" are real words even though they look like noise. */
const KEEP_SHORT = new Set(['e2e', 'ui', 'ux', 'ci', 'qa', 'api', 'db', 'fs', 'sse', 'p95']);

/** Words whose capitalisation a roster entry or a folder name would otherwise get wrong. */
const PROPER_NOUNS: Record<string, string> = {
  github: 'GitHub',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  macos: 'macOS',
  ios: 'iOS',
  openchamber: 'OpenChamber',
  opencode: 'OpenCode',
  docker: 'Docker',
  windows: 'Windows',
  linux: 'Linux',
};

export const titleCase = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      const proper = PROPER_NOUNS[lower];
      if (proper) return proper;
      if (word.length <= 3 && KEEP_SHORT.has(lower)) return word.toUpperCase();
      return word[0].toUpperCase() + word.slice(1);
    })
    .join(' ');

const tokensOf = (text: string): string[] =>
  text
    .replace(/[`*_#>]/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9:./-]+/)
    // A colon at the edge would hide the word from keyword matching ("regression:").
    .map((token) => token.replace(/^[-.:/]+|[-.:/]+$/g, ''))
    .filter(Boolean);

const roleByName = (name: string): Role | null => ROLES.find((role) => role.name === name) ?? null;

/**
 * The imperative that opens most first messages, mapped to the role it implies. This beats keyword
 * scoring on purpose: "fix the tailnet reconnect" is a Mechanic, even though "reconnect" is a longer
 * word that belongs to the Navigator family.
 */
const VERB_ROLES: Record<string, string> = {
  fix: 'Mechanic', repair: 'Mechanic', debug: 'Mechanic', hotfix: 'Mechanic',
  build: 'Engineer', add: 'Engineer', implement: 'Engineer', wire: 'Engineer', integrate: 'Engineer', code: 'Engineer',
  test: 'Inspector', verify: 'Inspector', check: 'Inspector', inspect: 'Inspector', validate: 'Inspector',
  review: 'Auditor', audit: 'Auditor', harden: 'Auditor', secure: 'Auditor',
  write: 'Scribe', draft: 'Scribe', document: 'Scribe', note: 'Scribe',
  rename: 'Editor', edit: 'Editor', proofread: 'Editor', polish: 'Editor', reword: 'Editor',
  refactor: 'Architect', restructure: 'Architect', split: 'Architect', extract: 'Architect',
  research: 'Scout', explore: 'Scout', compare: 'Scout', investigate: 'Scout', survey: 'Scout', evaluate: 'Scout',
  plan: 'Cartographer', outline: 'Cartographer', roadmap: 'Cartographer',
  shortlist: 'Curator', collect: 'Curator', curate: 'Curator', gather: 'Curator', organise: 'Curator', organize: 'Curator',
  deploy: 'Shipwright', release: 'Shipwright', ship: 'Shipwright', install: 'Shipwright',
  measure: 'Analyst', benchmark: 'Analyst', profile: 'Analyst', time: 'Analyst',
  navigate: 'Navigator', route: 'Navigator',
  translate: 'Translator', localise: 'Translator', localize: 'Translator',
  index: 'Librarian', search: 'Librarian', archive: 'Librarian',
  log: 'Chronicler', record: 'Chronicler', journal: 'Chronicler',
  design: 'Designer', style: 'Designer',
  decide: 'Negotiator', choose: 'Negotiator', prioritise: 'Negotiator', prioritize: 'Negotiator',
  estimate: 'Estimator', forecast: 'Estimator',
  clean: 'Janitor', tidy: 'Janitor', prune: 'Janitor', remove: 'Janitor', delete: 'Janitor', dedupe: 'Janitor',
  migrate: 'Porter', move: 'Porter', port: 'Porter', upgrade: 'Porter', convert: 'Porter',
  explain: 'Teacher', teach: 'Teacher', learn: 'Teacher',
  ask: 'Interviewer', clarify: 'Interviewer',
  orchestrate: 'Foreman', coordinate: 'Foreman', delegate: 'Foreman', spawn: 'Foreman',
  send: 'Courier', notify: 'Courier', email: 'Courier', message: 'Courier', ping: 'Courier',
  sort: 'Sorter', triage: 'Sorter', merge: 'Sorter', group: 'Sorter', arrange: 'Sorter',
  watch: 'Sentinel', monitor: 'Sentinel', probe: 'Sentinel',
  schedule: 'Scheduler', cron: 'Scheduler',
  prototype: 'Prototyper', experiment: 'Prototyper',
  drive: 'Pilot', walkthrough: 'Pilot',
  protect: 'Warden', enforce: 'Warden',
};

/**
 * Which role the message points at, or null when it gives nothing to match.
 *
 * **The imperative wins.** Most first messages open with a verb — "fix", "refactor", "shortlist" —
 * and that is the truest signal about the kind of work, so it beats any keyword scoring: "fix the
 * tailnet reconnect" is a Mechanic even though "reconnect" is a longer, more specific word. With no
 * leading verb, the longest keyword hit wins, then the earliest, so "unit test" beats "test".
 *
 * What it returns is a *noun* — the message's words never become part of the name.
 */
export const matchRole = (text: string): Role | null => {
  const tokens = tokensOf(text);
  const firstContent = tokens.find((token) => !STOP_WORDS.has(token));
  const verbRole = firstContent ? VERB_ROLES[firstContent] : undefined;
  if (verbRole) return roleByName(verbRole);

  // Tokens, not raw text: "regression:" and "regression," must match the keyword too. A multi-word
  // keyword ("look up", "build script") matches on the token run, which is why the join keeps
  // single spaces between the tokens.
  const haystack = ` ${tokens.join(' ')} `;
  let best: { role: Role; length: number; at: number } | null = null;
  ROLES.forEach((role) => {
    role.keywords.forEach((keyword) => {
      const at = haystack.indexOf(` ${keyword} `);
      if (at < 0) return;
      if (!best || keyword.length > best.length || (keyword.length === best.length && at < best.at)) {
        best = { role, length: keyword.length, at };
      }
    });
  });
  return best ? (best as unknown as { role: Role }).role : null;
};

/**
 * The tones a first message can carry. Each maps to a *pool* of adjectives, and the noun roster is
 * split so only adjectives that fit the noun are ever offered (see `ADJECTIVE_NOUNS` below).
 */
export type Tone = 'breakage' | 'curiosity' | 'building' | 'routine' | 'neutral';

/**
 * The tone words, in the order they are scored. Each tone counts its hits in the message and the
 * loudest wins; a tie goes to the earlier tone in this list, so breakage — the thing a person is
 * most likely to be typing about — outranks a plan that happens to mention "check".
 *
 * These are *classifiers*, not topic words: "crash" makes the name *Frantic*, it never makes the
 * name *Crash*.
 */
const TONE_WORDS: ReadonlyArray<{ tone: Tone; words: readonly string[]; weight?: number }> = [
  {
    tone: 'breakage',
    words: [
      'crash', 'crashes', 'crashed', 'crashing', 'broken', 'break', 'breaks', 'breaking', 'flapping',
      'flaky', 'wrong', 'bug', 'bugs', 'error', 'errors', 'failing', 'fails', 'failed', 'failure',
      'urgent', 'asap', 'immediately', 'stuck', 'hung', 'hangs', 'freeze', 'freezes', 'frozen',
      'regression', 'regressed', 'glitch', 'busted', 'dead', 'dies', 'lost', 'missing', 'panic',
      'help',
      // The vocabulary of an actual report, rather than of a summary of one. A pasted error and a
      // plain description of the wrong thing happening are the two commonest first messages there
      // are, and both used to read as a calm message.
      'drop', 'drops', 'dropped', 'dropping', 'lose', 'loses', 'losing', 'lost', 'jump', 'jumps',
      'jumping', 'reset', 'resets', 'resetting', 'flicker', 'flickers', 'flickering', 'stutter',
      'stutters', 'blank', 'silent', 'silently', 'disappear', 'disappears', 'disappeared',
      'throws', 'throw', 'threw', 'fault', 'faults', 'undefined', 'null', 'nan', 'enoent', 'econnrefused',
      'cannot', 'cannot-read', 'timeout', 'timeouts', 'timing-out', 'slow', 'laggy', 'lag', 'stuck',
      'ignored', 'ignores', 'wrongly', 'badly', 'janky', 'jank', 'leak', 'leaks', 'leaking', 'oom',
    ],
    // The two words that mean "the whole thing, and it is not the first time".
    weight: 2,
  },
  {
    tone: 'curiosity',
    words: ['how', 'why', 'what', 'wonder', 'wondering', 'curious', 'research', 'compare', 'explore', 'investigate', 'understand', 'learn', 'look', 'into', 'question', 'maybe', 'think'],
  },
  {
    tone: 'building',
    words: ['plan', 'build', 'design', 'roadmap', 'architect', 'structure', 'write', 'draft', 'propose', 'outline', 'spec', 'implement', 'add', 'new', 'create', 'make', 'start'],
  },
  {
    tone: 'routine',
    words: ['tidy', 'small', 'minor', 'quick', 'tiny', 'cleanup', 'clean', 'sort', 'rename', 'polish', 'note', 'few', 'bit'],
  },
];

/** Words that say "this is the whole thing, or it is happening again" — counted double. */
const EMPHASIS_WORDS = new Set(['everything', 'again', 'always', 'never', 'constantly', 'every', 'all', 'entirely', 'completely']);

/**
 * Classify the message's tone.
 *
 * Deliberately a small bag-of-words count rather than anything clever: the point is that a report of
 * breakage sounds different from a plan, and that *nothing here touches the noun*. A message with no
 * signal at all is `neutral`, which is not a failure — it is the normal case for "hmm" or "ok".
 */
const ERROR_SHAPED = /\b(?:typeerror|referenceerror|syntaxerror|rangeerror|enoent|econnrefused|errno|traceback|exception|panic)\b|\bat [\w./-]+\.(?:tsx?|jsx?|mjs):\d+/;

/** Words that only ever *frame* a report rather than describe it. */
const INTERROGATIVE = new Set(['why', 'how', 'what', 'when', 'where', 'which', 'who']);

export const detectTone = (text: string): Tone => {
  const tokens = tokensOf(text);
  if (tokens.length === 0) return 'neutral';
  const lower = text.toLowerCase();
  let emphasis = 0;
  tokens.forEach((token) => {
    if (EMPHASIS_WORDS.has(token)) emphasis += 1;
  });

  const wordsOf = (tone: Tone): readonly string[] => TONE_WORDS.find((entry) => entry.tone === tone)?.words ?? [];
  // "why does it drop my paste every time" is a complaint wearing a question mark: a question word
  // is framing, so it only counts for curiosity when nothing in the message reports a problem.
  const reportsBreakage =
    tokens.some((token) => wordsOf('breakage').includes(token)) || ERROR_SHAPED.test(lower);
  const asked = tokens.some((token) => INTERROGATIVE.has(token));

  let best: { tone: Tone; score: number } | null = null;
  TONE_WORDS.forEach(({ tone, words, weight }) => {
    let hits = tokens.filter((token) => words.includes(token)).length;
    if (tone === 'curiosity') {
      hits = tokens.filter((token) => words.includes(token) && (asked || !reportsBreakage || !INTERROGATIVE.has(token))).length;
    }
    // A pasted stack trace or a thrown error names the breakage in a word a token list cannot hold
    // ("TypeError", "at Transcript (…:412:18)"); it counts as one more piece of evidence.
    const evidence = hits + (tone === 'breakage' && ERROR_SHAPED.test(lower) ? 1 : 0);
    const score = evidence * (weight ?? 1) + (tone === 'breakage' ? emphasis : 0);
    if (evidence === 0) return;
    // A tie goes to breakage: it is the louder thing to be typing about, and "check the flaky
    // test" should not read as curiosity because it also says "check".
    const beats = !best || score > best.score || (score === best.score && tone === 'breakage');
    if (beats) best = { tone, score };
  });
  return best ? (best as { tone: Tone }).tone : 'neutral';
};

/**
 * The adjectives, by tone.
 *
 * **The tone's own words are almost all of every row.** This is the lesson of 0.88.0, where each row
 * was a 22-word shared middle with six to twelve tone words appended: the draw hashes over the whole
 * row, so 65–80% of the time a tone word was never reachable and the tone was decoration. Measured
 * on that build, a breakage report drew *Observant Mechanic* and *Gentle Beetle*, a plan drew
 * *Watchful Cartographer*, tidying drew *Watchful Janitor*. Each row below carries exactly one
 * shared word, so the measured share of a tone-carrying draw is 95–100% for every tone, and
 * `sessionNames.test.ts` measures that rather than trusting this comment.
 *
 * Two rules hold every word:
 *
 *   - **Nothing here is an insult, and nothing describes a *thing*.** A session is named after the
 *     person doing the work, so there is no "Clumsy Mechanic", no "Broken Porter", no "Lazy" on a bug
 *     report, and no word that reads as a diagnosis of the person rather than a mood of the moment.
 *   - **A tone's words mean that tone.** A crash is *Frantic*, *Harried*, *Stretched*; a plan is
 *     *Methodical*, *Deliberate*, *Diligent*; tidying is *Deft*, *Snappy*, *Prompt*; a question is
 *     *Curious*, *Inquisitive*, *Probing*. Words equally true of every tone — *Observant*,
 *     *Watchful*, *Wary*, *Alert*, *Gentle*, *Patient*, *Unhurried*, *Content*, *Cheerful*, *Dapper*
 *     — live only in `neutral`, where they are the point, and a crash can never reach them.
 */

/**
 * The shared minority: **one** word per row, and it has to be true for that tone's worst day too.
 *
 * A row is drawn uniformly, so every shared word is a straight subtraction from the share of draws
 * that carry the tone — which is exactly how 0.88.0 lost the tone. One is enough to stop a row
 * reading mechanical on the fourth session in a folder. *Keen* is in both the frantic and the
 * curious row on purpose: on a bug report "Keen Mechanic" is somebody on it, and on a question "Keen
 * Teacher" is somebody digging in.
 */
const SHARED_URGENT: readonly string[] = ['Keen'];
const SHARED_CAREFUL: readonly string[] = ['Steady'];
const SHARED_ATTENTIVE: readonly string[] = ['Thoughtful'];

export const ADJECTIVES: Record<Tone, readonly string[]> = {
  // Something is on fire, or keeps catching fire. Urgent, harassed, short-tempered — never placid,
  // and never a judgement of the person: "Pummelled Mechanic" reads as someone who has been hit,
  // which is an accident rather than a character.
  breakage: [
    'Frantic', 'Feral', 'Feverish', 'Harried', 'Hurried', 'Overworked', 'Stretched', 'Bristling',
    'Prickly', 'Restless', 'Vigilant', 'Grim', 'Stubborn', 'Unflappable', 'Bruised', 'Dogged',
    'Stoic', 'Hounded', 'Terse', 'Frayed', 'Cornered', 'Winded', 'Gritted', 'Rattled',
    'Bedraggled', 'Weary', 'Obstinate', 'Undaunted',
    ...SHARED_URGENT,
  ],
  // A question, a dig, a look into something.
  curiosity: [
    'Curious', 'Inquisitive', 'Inquiring', 'Perceptive', 'Attentive', 'Considerate', 'Sifting',
    'Speculative', 'Receptive', 'Pondering', 'Reflective', 'Musing', 'Questioning', 'Searching',
    'Ruminating', 'Cerebral', 'Enquiring', 'Investigative', 'Contemplative', 'Wondering', 'Digging',
    'Probing', 'Glancing', 'Listening', 'Chewing-it-over',
    ...SHARED_ATTENTIVE,
  ],
  // A plan, a build, something being made.
  building: [
    'Diligent', 'Methodical', 'Deliberate', 'Inventive', 'Studious', 'Careful', 'Thorough',
    'Meticulous', 'Steadfast', 'Resourceful', 'Ambitious', 'Orderly', 'Patient', 'Assiduous',
    'Plodding', 'Ingenious', 'Painstaking', 'Conscientious', 'Foresighted', 'Prudent', 'Unyielding', 'Plucky',
    ...SHARED_CAREFUL,
  ],
  // Brisk, small, tidy work. One word per turn's worth of work: nothing that sounds long or heavy.
  routine: [
    'Brisk', 'Deft', 'Spry', 'Snappy', 'Tidy', 'Neat', 'Handy', 'Prompt', 'Practised', 'Breezy', 'Agile',
    'Nimble', 'Efficient', 'Tireless', 'Dapper', 'Spruce', 'Chipper', 'Nifty', 'Jaunty', 'Trig',
    ...SHARED_CAREFUL,
  ],
  // No signal at all: the widest, calmest row, and the only home of the slow and the dreamy.
  neutral: [
    'Lazy', 'Sleepy', 'Drowsy', 'Wistful', 'Mosey', 'Dappled', 'Jolly', 'Fresh', 'Genteel',
    'Observant', 'Watchful', 'Wary', 'Alert', 'Gentle', 'Patient', 'Unhurried', 'Content',
    'Cheerful', 'Dapper', 'Quiet', 'Steady', 'Mellow', 'Bright', 'Plucky', 'Sensible', 'Curious',
  ],
};

/**
 * The adjectives a *creature* carries on a bad day: alarmed at the problem, not placid and not ill.
 *
 * "Frantic Fox" is an emergency rather than a name and "Feverish Otter" is a disease, so a creature
 * never gets the trade breakage row — but "Gentle Beetle" on a crash is the pair the brief forbids,
 * so the creature row is its own: wide-eyed, ruffled, wary. A crash must actually draw this.
 */
const CREATURE_BREAKAGE: readonly string[] = [
  'Wary', 'Alert', 'Ruffled', 'Bristly', 'Keen', 'Restless', 'Startled', 'Spooked', 'Edgy', 'Wide-eyed',
  'Skittish', 'Anxious', 'Flustered', 'Prickly', 'Lofty',
];

/**
 * The row a *creature* takes when the message carries no emergency.
 *
 * "Deft Heron" and "Curious Magpie" are fine; what a creature must not get is a trade's breakage row
 * ("Frantic Fox" is an emergency rather than a name, "Feverish Otter" is a disease), which is why
 * `CREATURE_BREAKAGE` above exists as a row of its own. There is no floor of alarm for the calm
 * rows: a *wary* magpie is a fine name, but a crash that came out *Wary Magpie* would be the placid
 * pair this brief is about, so a creature on a bad day draws only the alarmed row.
 */
const CREATURE_CALM: readonly string[] = [...ADJECTIVES.neutral, ...ADJECTIVES.curiosity, ...ADJECTIVES.building, ...ADJECTIVES.routine];

/** The adjectives a noun admits for this tone: a trade takes the tone's row, a creature its own. */
const adjectivesFor = (tone: Tone, noun: Role): readonly string[] => {
  if (noun.kind !== 'creature') {
    // A trade takes its tone's row whether it is the message's own noun or a bounce: the tone is the
    // message's, and a frantic occasion does not calm down because the work moved next door.
    return ADJECTIVES[tone];
  }
  return tone === 'breakage' ? CREATURE_BREAKAGE : CREATURE_CALM;
};

const CREATURE_NOUNS = ROLES.filter((role) => role.kind === 'creature').map((role) => role.name);

/**
 * A seeded creature: the noun a message gets when it named no kind of work.
 *
 * Drawn from the seed so two idle sessions in a row are not the same animal, and used for the
 * first draw *and* every bounce of a message that matched nothing — so a walk through the roster
 * can reach a creature on every step, not only when the hash happens to land on one.
 */
const creatureFor = (seed: number): Role =>
  roleByName(CREATURE_NOUNS[draw(seed, CREATURE_NOUNS.length)]) ?? roleByName(LAST_RESORT_ROLE)!;

export type NameInput = {
  /** The first message: the best evidence of what the session is about, and of its tone. */
  text?: string;
  /**
   * The folder the session runs in. It can no longer supply the noun — that is what made a missing
   * subject turn into a folder name read as a person ("Hearth Gardener") — and is used for the seed
   * only, so two projects' identical first messages are told apart.
   */
  directory?: string;
  /**
   * The project's display name, when the folder is not one. Same deal: seed only. It is kept in the
   * input because callers pass it, and because a session created in two projects should not read as
   * the identical name twice.
   */
  project?: string;
  /** Titles already in use, so two sessions don't land on the same name. */
  taken?: readonly string[];
  /** Stable seed: the conversation's own id when it exists, else the draft's key. */
  seed?: string;
};

/**
 * The name: `<Adjective> <Noun>`.
 *
 * Noun: the role the message points at, else a seeded creature — always from the roster. Adjective:
 * drawn from the pool the message's tone selects, filtered to the ones the noun admits.
 *
 * **Collisions step the seed, not the array.** Each step is a fresh draw, so a second session with
 * the same first message gets an unrelated name rather than the next adjective down the list, and a
 * taken list can never force a duplicate: the loop only returns a name that is not in `taken`. After
 * every adjective × every noun has been tried it numbers the last resort ("Lazy Librarian 2"), which
 * is the only case in which a name stops being adjective + noun from the roster.
 */
export const deriveSessionName = (input: NameInput = {}): string => {
  const text = (input.text ?? '').trim();
  const baseSeed = hashSeed(
    input.seed ?? `${text}|${input.directory ?? ''}|${input.project ?? ''}`
  );
  // Normalised once, lowercased: a title compares the way a person reads it.
  const taken = new Set((input.taken ?? []).map((title) => title.trim().toLowerCase()));

  const tone = text ? detectTone(text) : 'neutral';
  const matched = text ? matchRole(text) : null;
  const drawCounts = new Map<string, number>();

  /**
   * How many sessions already in the rail are named after this noun.
   *
   * `taken` carries titles, not nouns, so the read is the last word of each title. A numbered name
   * ("Weary Mechanic 2") still carries its noun in the middle, which the split handles.
   */
  // Keyed the way a title actually reads: the `taken` set is lowercased, so compare lowercased.
  const nounUses = new Map<string, number>();
  taken.forEach((title) => {
    const words = title.split(/\s+/).filter(Boolean);
    // A numbered name ("Weary Mechanic 2") carries its count last, so the noun is two back; every
    // other name ends with its noun.
    const nounName = /^\d+$/.test(words[words.length - 1] ?? '')
      ? words[words.length - 2]
      : words[words.length - 1];
    if (nounName) nounUses.set(nounName.toLowerCase(), (nounUses.get(nounName.toLowerCase()) ?? 0) + 1);
  });
  const nounUseCount = (name: string): number => nounUses.get(name.toLowerCase()) ?? 0;
  const railWidth = taken.size;

  /**
   * The draw at one step.
   *
   * Step 0 is the message's own noun — its kind of work, or a seeded creature — with an adjective
   * from the tone's row. Every step after it is a *bounce*: **any** noun from the roster, with an
   * adjective from whatever row that noun admits. A walk that redrew only the adjective would leave a
   * session named for work the message never mentioned; a walk that bounced only through creatures
   * (which is what 0.88.1 did) could never reach a colleague, so a hundred idle sessions wrapped the
   * same animals.
   */
  const candidateAt = (step: number): { adjective: string; noun: Role } => {
    // Step 0 is the message's own noun. Bounces draw from the whole roster, so a folder of idle
    // sessions can reach a colleague and not just the next animal — otherwise "a different noun"
    // would be a promise the walk could not keep.
    const seed = step === 0 ? baseSeed : nextSeed(baseSeed, step);
    const candidateRole =
      step === 0 ? matched ?? creatureFor(seed) : ROLES[draw((seed ^ 0x2545f491) >>> 0, ROLES.length)];
    // The adjective is drawn from a different slice of the hash than the noun: otherwise the two are
    // one choice, and a seed whose message matched a trade could only ever reach the adjectives that
    // happen to pair with *its* noun.
    const pool = adjectivesFor(tone, candidateRole);
    return {
      adjective: pool[draw((seed ^ hashSeed('adjective')) >>> 0, pool.length)],
      noun: candidateRole,
    };
  };

  const nameOf = (candidate: { adjective: string; noun: Role }): string =>
    `${candidate.adjective} ${candidate.noun.name}`;

  // Nothing to collide with: the first draw, and nothing drawn to avoid.
  if (taken.size === 0) return nameOf(candidateAt(0));

  /**
   * A collision walks seeded draws and keeps the best one that is free.
   *
   * The walk is ranked by what a person comparing two sessions in their rail actually sees: **the
   * noun**. 0.88.1 ranked the message's own noun *first*, so a folder of "fix …" sessions came out
   * twenty-six Mechanics and a folder of idle ones wrapped round the same 22 creatures — the walk
   * changed the adjective while the thing a person reads as "the same session again" stayed put.
   * That is the owner's "i have too many gardeners".
   *
   * So a noun the rail already holds too often now loses to any noun it holds less — the message's
   * own noun is not ranked above that any more, it is simply *first in the walk*, which is what keeps
   * a lone fix session a Mechanic: with nothing taken the first draw wins outright, and with a short
   * rail the tie-break is the walk order.
   *
   * Only free names (not in `taken`, not drawn twice) are considered, so the walk can never return a
   * duplicate; the ranking only chooses among names that are all available.
   */
  type Candidate = { adjective: string; noun: Role; name: string; repeated: number; hop: number };
  const candidates: Candidate[] = [];
  const seenNouns = new Set<string>();
  for (let step = 0; step < CANDIDATE_STEPS; step += 1) {
    const candidate = candidateAt(step);
    const name = nameOf(candidate);
    if (taken.has(name.toLowerCase())) continue;
    if (drawCounts.has(name)) continue;
    drawCounts.set(name, 1);
    // One entry per noun: the first free draw *of that noun* is the one that counts, so the walk can
    // reach every noun in the roster instead of its steps filling up with the same few animals drawn
    // again with different adjectives.
    if (!seenNouns.has(candidate.noun.name)) {
      seenNouns.add(candidate.noun.name);
      candidates.push({
        ...candidate,
        name,
        repeated: nounUseCount(candidate.noun.name),
        hop: candidate.noun.kind === 'trade' ? 1 : 0,
      });
    }
    if (seenNouns.size >= ROLES.length) break;
  }

  // The thing a person reads as "the same session again" is the **noun**, so the noun is what the
  // walk ranks: a name whose noun the rail already holds too often loses to any name whose noun it
  // holds less. The message's own noun is not ranked above that — ranking it first is what produced
  // a rail of twenty-six Mechanics — it is simply *first in the walk*, so it wins every tie and a
  // lone fix session is still a Mechanic.
  //
  // When the rail has used every noun up to the limit, the *least*-used one wins: that is what lets
  // a hundred idle sessions keep reaching colleagues instead of wrapping the same animals.
  const least = candidates.reduce((m, candidate) => Math.min(m, candidate.repeated), Number.POSITIVE_INFINITY);
  // Up to the limit, and the limit grows slowly with the rail: a hundred sessions can still all be
  // different nouns, and only a rail longer than the roster lets a noun reach four.
  const limit = Math.max(NOUN_REPEAT_LIMIT, Math.ceil(railWidth / ROLES.length) + 1);
  const fresh = candidates.filter((candidate) => candidate.repeated < limit);
  const pool = fresh.length > 0 ? fresh : candidates.filter((candidate) => candidate.repeated === least);
  if (pool.length > 0) {
    return pool.reduce((best, candidate) => {
      if (candidate.repeated !== best.repeated) return candidate.repeated < best.repeated ? candidate : best;
      return candidate.hop > best.hop ? candidate : best;
    }).name;
  }

  // Every name this message can produce is taken: number it rather than return a duplicate. A
  // `taken` list this long is a test's, not a person's, but a duplicate name is the one thing this
  // function must not do.
  const base = nameOf(candidateAt(0));
  for (let index = 2; index < 2000; index += 1) {
    const name = `${base} ${index}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return base;
};
