/**
 * Virtual-contest performance evidence (Sprint 18c).
 *
 * Codeforces' public API exposes no "performance" field — only an official rating and a rating
 * history — so this module models **user-entered** virtual-contest evidence: a score the solver
 * obtained in a virtual (out-of-competition) run and the method that produced it. Nothing here
 * claims to be official, and nothing is fetched: `sourceUrl` is a reference the plugin never
 * requests. The four provenance channels stay distinguishable — `source` is always the
 * server-injected `user_import`, `calculationMethod` names the tool/formula the user applied, and
 * `independence`/`priorExposure` state what the solver knew at the time.
 *
 * The module is pure: `participatedAt` is validated as an ISO instant, but whether it lies in the
 * past is the caller's decision (the service owns the clock), because a domain validator reads no
 * clock.
 *
 * A ledger is one account's bounded history (<= {@link MAX_VIRTUAL_PERFORMANCE_ROWS} rows). Entries
 * are unique by `contestId`, so a repeated virtual run of the same contest replaces its row instead
 * of being counted twice, and the revision is monotonic across saves *and* deletes — including a
 * delete that empties the ledger — so a stale writer can never resurrect what it read (no ABA).
 *
 * {@link virtualPerformancePlanningSummary} is the only shape meant for a model or a later
 * ability-evaluation stage: every identifier becomes a synthetic `evidenceRef`, exact timestamps
 * collapse to a coarse age bucket, and the note, source URL, contest id, rank and exact dates never
 * appear. {@link virtualPerformanceLedgerHash} covers **all** stored semantic fields, including the
 * ones the summary intentionally omits, so a mutation or deletion invalidates a plan preparation
 * even though the model never saw those fields.
 */
import { DomainError, invariant } from './errors.js';
import { contentHashOf } from './hash.js';
import { assertIsoTimestamp } from './ids.js';

/** Version of the identifier-free planning summary shape; bump when an exported meaning changes. */
export const VIRTUAL_PERFORMANCE_SUMMARY_VERSION = 'virtual-performance-summary.1';

/** The only accepted ledger `source`: injected by the server, never sent by a client. */
export const VIRTUAL_PERFORMANCE_SOURCE = 'user_import';

/** Independence vocabulary of one entered virtual run. */
export const VIRTUAL_PERFORMANCE_INDEPENDENCE = ['independent', 'assisted', 'unknown'] as const;
export type VirtualPerformanceIndependence = (typeof VIRTUAL_PERFORMANCE_INDEPENDENCE)[number];

/**
 * Documented inclusive bound of one entered performance value.
 *
 * The bound is a data-quality guard, not a claim about any platform's scale: a virtual performance
 * outside it is far more likely to be a mistyped contest id or an unadjusted tool output than a
 * real value.
 */
export const VIRTUAL_PERFORMANCE_MIN = -1000;
export const VIRTUAL_PERFORMANCE_MAX = 5000;

/** Maximum evidence rows one account ledger may hold. */
export const MAX_VIRTUAL_PERFORMANCE_ROWS = 200;

/** Longest accepted `calculationMethod` (a short tool/formula label, e.g. `carrot`). */
export const MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS = 200;

/** Longest accepted `sourceUrl`; the link is stored as a reference and is never fetched. */
export const MAX_VIRTUAL_PERFORMANCE_URL_CHARS = 2000;

/** Longest accepted local-only `note`. */
export const MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS = 1000;

/** Longest accepted `evidenceId`. */
export const MAX_VIRTUAL_PERFORMANCE_EVIDENCE_ID_CHARS = 200;

/** Age bucket boundary of {@link VirtualPerformanceAgeBucket}: a run inside this window is recent. */
export const VIRTUAL_PERFORMANCE_RECENT_DAYS = 90;

/** Upper boundary of the `last_year` bucket; anything older is `older`. */
export const VIRTUAL_PERFORMANCE_YEAR_DAYS = 365;

const DAY_MS = 86_400_000;

/** Coarse age of one run relative to the explicit observation instant. */
export type VirtualPerformanceAgeBucket = 'last_90_days' | 'last_year' | 'older';

/** Fixed disclosure carried by the planning summary and by every API view. */
export const VIRTUAL_PERFORMANCE_DISCLOSURE =
  '用户录入的虚拟参赛表现，不是官方评分：模型只收到去标识的分数、相对时间档、计算方法标签、独立性与赛前是否见过题；不含账号、比赛编号、名次、备注、来源链接或具体日期，本账本只保存表现分；AI 评估另行分析，不能改写官方评分。';

/** One user-entered virtual-contest result. */
export interface VirtualPerformanceEvidence {
  /** Stable identity of this row inside its account ledger. */
  readonly evidenceId: string;
  /** Contest id of the virtual run (a positive integer, e.g. a Codeforces round id). */
  readonly contestId: number;
  /** ISO instant of the original contest; validated as a parseable instant, normalized to UTC. */
  readonly participatedAt: string;
  /** Entered performance, a bounded signed integer (see the documented bounds). */
  readonly performance: number;
  /** Tool/formula that produced the value; required because tools differ. */
  readonly calculationMethod: string;
  /** Reference URL; validated http(s), credential-free and bounded, never fetched. */
  readonly sourceUrl: string;
  readonly independence: VirtualPerformanceIndependence;
  /** Whether the solver had seen the problems before this run. */
  readonly priorExposure: boolean;
  readonly rank: number | null;
  /** Local-only note; never leaves this machine through a model summary. */
  readonly note: string | null;
}

/** One account's revisioned ledger. */
export interface VirtualPerformanceLedger {
  readonly accountId: string;
  /** Monotonic per-account revision; advanced by every save and every delete. */
  readonly revision: number;
  readonly updatedAt: string;
  /** Always {@link VIRTUAL_PERFORMANCE_SOURCE}. */
  readonly source: typeof VIRTUAL_PERFORMANCE_SOURCE;
  /** Unique by `contestId` and `evidenceId`, ordered by `participatedAt` descending. */
  readonly entries: readonly VirtualPerformanceEvidence[];
}

const EVIDENCE_KEYS = [
  'evidenceId',
  'contestId',
  'participatedAt',
  'performance',
  'calculationMethod',
  'sourceUrl',
  'independence',
  'priorExposure',
  'rank',
  'note',
] as const;

const LEDGER_KEYS = ['accountId', 'revision', 'updatedAt', 'source', 'entries'] as const;

type JsonObject = Record<string, unknown>;

function requireObject(label: string, value: unknown): JsonObject {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    `${label} must be a JSON object`,
    { label },
  );
  return value as JsonObject;
}

/** Strict shape check: an undeclared key and a missing declared key are both rejected. */
function requireExactKeys(label: string, value: JsonObject, keys: readonly string[]): void {
  const unknownKeys = Object.keys(value).filter((key) => !keys.includes(key));
  invariant(unknownKeys.length === 0, 'invalid_input', `${label} has unknown keys: ${unknownKeys.join(', ')}`, {
    label,
    unknownKeys,
  });
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  invariant(missing.length === 0, 'invalid_input', `${label} is missing keys: ${missing.join(', ')}`, {
    label,
    missing,
  });
}

/** Trimmed non-empty text of at most `max` characters; control characters are refused. */
function requireText(label: string, value: unknown, max: number): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `${label} must be a non-empty string`,
    { label, value },
  );
  const trimmed = value.trim();
  invariant(trimmed.length <= max, 'invalid_input', `${label} must be at most ${max} characters`, {
    label,
    length: trimmed.length,
    max,
  });
  return trimmed;
}

/** A positive safe integer within `max`. */
function requirePositiveInt(label: string, value: unknown, max: number): number {
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max,
    'invalid_input',
    `${label} must be an integer within 1..${max}`,
    { label, value },
  );
  return value;
}

/**
 * One `sourceUrl`: bounded, credential-free, absolute http(s), and **never fetched**.
 *
 * The text is kept exactly as the user typed it (trimmed) so a stored row round-trips byte for
 * byte; only its shape is validated. A URL carrying a user name or password is refused because a
 * contest link never needs one and storing credentials in a user-visible row is exactly what this
 * product forbids.
 */
export function validateVirtualPerformanceSourceUrl(value: unknown): string {
  const text = requireText('virtual performance sourceUrl', value, MAX_VIRTUAL_PERFORMANCE_URL_CHARS);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch (cause) {
    throw new DomainError('invalid_url', 'virtual performance sourceUrl must be an absolute URL', {
      reason: 'invalid_source_url',
      cause: String(cause),
    });
  }
  invariant(
    parsed.protocol === 'http:' || parsed.protocol === 'https:',
    'invalid_url',
    'virtual performance sourceUrl must use http(s)',
    { reason: 'invalid_source_url', protocol: parsed.protocol },
  );
  invariant(
    parsed.username === '' && parsed.password === '',
    'invalid_url',
    'virtual performance sourceUrl must not carry credentials',
    { reason: 'credentialed_source_url' },
  );
  return text;
}

/** Strictly validate one evidence row and return a detached, normalized copy. */
export function validateVirtualPerformanceEvidence(value: unknown): VirtualPerformanceEvidence {
  const record = requireObject('virtual performance evidence', value);
  requireExactKeys('virtual performance evidence', record, EVIDENCE_KEYS);
  const evidenceId = requireText(
    'virtual performance evidenceId',
    record['evidenceId'],
    MAX_VIRTUAL_PERFORMANCE_EVIDENCE_ID_CHARS,
  );
  const contestId = requirePositiveInt(
    'virtual performance contestId',
    record['contestId'],
    Number.MAX_SAFE_INTEGER,
  );
  const participatedAt = assertIsoTimestamp(
    'virtual performance participatedAt',
    String(record['participatedAt']),
  );
  const performance = record['performance'];
  invariant(
    typeof performance === 'number' &&
      Number.isSafeInteger(performance) &&
      performance >= VIRTUAL_PERFORMANCE_MIN &&
      performance <= VIRTUAL_PERFORMANCE_MAX,
    'invalid_input',
    `virtual performance must be an integer within ${VIRTUAL_PERFORMANCE_MIN}..${VIRTUAL_PERFORMANCE_MAX}`,
    { performance },
  );
  const calculationMethod = requireText(
    'virtual performance calculationMethod',
    record['calculationMethod'],
    MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS,
  );
  const sourceUrl = validateVirtualPerformanceSourceUrl(record['sourceUrl']);
  const independence = record['independence'];
  invariant(
    VIRTUAL_PERFORMANCE_INDEPENDENCE.includes(independence as VirtualPerformanceIndependence),
    'invalid_input',
    `virtual performance independence must be one of: ${VIRTUAL_PERFORMANCE_INDEPENDENCE.join(', ')}`,
    { independence },
  );
  invariant(
    typeof record['priorExposure'] === 'boolean',
    'invalid_input',
    'virtual performance priorExposure must be boolean',
    { priorExposure: record['priorExposure'] },
  );
  const rank =
    record['rank'] === null || record['rank'] === undefined
      ? null
      : requirePositiveInt('virtual performance rank', record['rank'], Number.MAX_SAFE_INTEGER);
  const note =
    record['note'] === null || record['note'] === undefined
      ? null
      : requireText('virtual performance note', record['note'], MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS);
  return {
    evidenceId,
    contestId,
    participatedAt,
    performance,
    calculationMethod,
    sourceUrl,
    independence: independence as VirtualPerformanceIndependence,
    priorExposure: record['priorExposure'],
    rank,
    note,
  };
}

/**
 * Strictly validate one whole ledger: bounded rows, unique `contestId`/`evidenceId`, normalized
 * order and no duplicate contest.
 */
export function validateVirtualPerformanceLedger(value: unknown): VirtualPerformanceLedger {
  const record = requireObject('virtual performance ledger', value);
  requireExactKeys('virtual performance ledger', record, LEDGER_KEYS);
  const accountId = requireText('virtual performance ledger accountId', record['accountId'], 512);
  const revision = requirePositiveInt(
    'virtual performance ledger revision',
    record['revision'],
    Number.MAX_SAFE_INTEGER,
  );
  const updatedAt = assertIsoTimestamp('virtual performance ledger updatedAt', String(record['updatedAt']));
  invariant(
    record['source'] === VIRTUAL_PERFORMANCE_SOURCE,
    'invalid_input',
    `virtual performance ledger source must be ${VIRTUAL_PERFORMANCE_SOURCE}`,
    { source: record['source'] },
  );
  invariant(
    Array.isArray(record['entries']),
    'invalid_input',
    'virtual performance ledger entries must be an array',
    {},
  );
  const rawEntries = record['entries'] as readonly unknown[];
  invariant(
    rawEntries.length <= MAX_VIRTUAL_PERFORMANCE_ROWS,
    'invalid_input',
    `virtual performance ledger holds at most ${MAX_VIRTUAL_PERFORMANCE_ROWS} rows`,
    { length: rawEntries.length, bound: MAX_VIRTUAL_PERFORMANCE_ROWS },
  );
  const entries = rawEntries.map((entry) => validateVirtualPerformanceEvidence(entry));
  const contests = new Set<number>();
  const ids = new Set<string>();
  for (const entry of entries) {
    invariant(
      !contests.has(entry.contestId),
      'duplicate_id',
      `virtual performance ledger records contest ${entry.contestId} twice`,
      { reason: 'duplicate_contest', contestId: entry.contestId },
    );
    invariant(
      !ids.has(entry.evidenceId),
      'duplicate_id',
      `virtual performance ledger repeats evidence ${entry.evidenceId}`,
      { reason: 'duplicate_evidence', evidenceId: entry.evidenceId },
    );
    contests.add(entry.contestId);
    ids.add(entry.evidenceId);
  }
  return {
    accountId,
    revision,
    updatedAt,
    source: VIRTUAL_PERFORMANCE_SOURCE,
    entries: sortEvidence(entries),
  };
}

/** Deterministic order: most recent virtual run first, then stable evidence identity. */
function sortEvidence(entries: readonly VirtualPerformanceEvidence[]): readonly VirtualPerformanceEvidence[] {
  return [...entries].sort((left, right) => {
    if (left.participatedAt !== right.participatedAt) {
      return left.participatedAt < right.participatedAt ? 1 : -1;
    }
    return left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0;
  });
}

/**
 * Build one validated ledger.
 *
 * The caller supplies the next revision and the observation instant; the factory sorts the rows and
 * validates the whole body, so an invalid or duplicated row can never be persisted.
 */
export function createVirtualPerformanceLedger(input: {
  readonly accountId: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly entries: readonly VirtualPerformanceEvidence[];
}): VirtualPerformanceLedger {
  return validateVirtualPerformanceLedger({
    accountId: input.accountId,
    revision: input.revision,
    updatedAt: input.updatedAt,
    source: VIRTUAL_PERFORMANCE_SOURCE,
    entries: sortEvidence(input.entries.map((entry) => validateVirtualPerformanceEvidence(entry))),
  });
}

/**
 * `true` when one row may be used as independent current-ability evidence.
 *
 * Known assisted runs and runs whose problems were seen before never anchor independent ability, and
 * `unknown` independence is not silently promoted to independent.
 */
export function isEligibleVirtualPerformanceEvidence(entry: VirtualPerformanceEvidence): boolean {
  return entry.independence === 'independent' && !entry.priorExposure;
}

/** One identifier-free row as a model summary carries it. */
export interface VirtualPerformancePlanningEntry {
  /** Synthetic reference (`vp-1`, …); never a stored evidence id. */
  readonly evidenceRef: string;
  readonly performance: number;
  readonly methodLabel: string;
  readonly independence: VirtualPerformanceIndependence;
  readonly priorExposure: boolean;
  readonly ageBucket: VirtualPerformanceAgeBucket;
  /** `true` exactly for the `last_90_days` bucket. */
  readonly recent: boolean;
}

/** Aggregate counts of one ledger; shared by the API view and the planning summary. */
export interface VirtualPerformanceCounts {
  readonly total: number;
  /** Independent runs without prior exposure — the only rows eligible as current-ability evidence. */
  readonly eligibleIndependent: number;
  readonly assisted: number;
  readonly unknownIndependence: number;
  readonly priorExposed: number;
}

/** Count one ledger's rows without exposing any identifier. */
export function virtualPerformanceCounts(
  entries: readonly VirtualPerformanceEvidence[],
): VirtualPerformanceCounts {
  let eligibleIndependent = 0;
  let assisted = 0;
  let unknownIndependence = 0;
  let priorExposed = 0;
  for (const entry of entries) {
    if (entry.independence === 'assisted') {
      assisted += 1;
    } else if (entry.independence === 'unknown') {
      unknownIndependence += 1;
    }
    if (entry.priorExposure) {
      priorExposed += 1;
    }
    if (isEligibleVirtualPerformanceEvidence(entry)) {
      eligibleIndependent += 1;
    }
  }
  return { total: entries.length, eligibleIndependent, assisted, unknownIndependence, priorExposed };
}

/**
 * Identifier-free summary of one account's virtual-contest evidence.
 *
 * This is the only shape that may reach a model or a later ability-evaluation stage. It carries the
 * entered performance values, a synthetic reference, a coarse age bucket, the calculation-method
 * label, independence and prior exposure — and nothing else: no account id, no handle, no contest
 * id, no evidence id, no exact timestamp, no note, no source URL, no rank. `knownAssistedOrPriorExposed`
 * and `unknownIndependence` are reported **separately** so assisted or already-seen runs can never
 * anchor independent current ability. `estimation` states explicitly that this stage performs no
 * numeric estimation.
 */
export interface VirtualPerformancePlanningSummary {
  readonly version: string;
  /** `false` when the account has no ledger at all; `entries` are then empty, never zero-filled. */
  readonly ledgerPresent: boolean;
  readonly ledgerRevision: number;
  /**
   * Hash over every stored semantic field of the ledger (including note, URL, contest id, rank and
   * exact instants), so a mutation or deletion invalidates a plan preparation even though the model
   * never sees those fields. Clock-free: the same ledger always hashes the same.
   */
  readonly ledgerHash: string;
  readonly entryCount: number;
  readonly counts: VirtualPerformanceCounts;
  readonly eligible: readonly VirtualPerformancePlanningEntry[];
  readonly knownAssistedOrPriorExposed: readonly VirtualPerformancePlanningEntry[];
  readonly unknownIndependence: readonly VirtualPerformancePlanningEntry[];
  /** Always `not_estimated`: honest virtual evidence is not converted into a rating here. */
  readonly estimation: 'not_estimated';
  readonly disclosure: string;
}

/** Hash of one ledger (or of "no ledger"), covering every stored semantic field. */
export function virtualPerformanceLedgerHash(ledger: VirtualPerformanceLedger | null): string {
  return contentHashOf(
    ledger === null
      ? { version: VIRTUAL_PERFORMANCE_SUMMARY_VERSION, present: false }
      : {
          version: VIRTUAL_PERFORMANCE_SUMMARY_VERSION,
          present: true,
          accountId: ledger.accountId,
          revision: ledger.revision,
          updatedAt: ledger.updatedAt,
          source: ledger.source,
          entries: ledger.entries,
        },
  );
}

/** Coarse age of one run relative to an explicit instant; a future instant counts as recent. */
export function virtualPerformanceAgeBucket(
  participatedAt: string,
  now: string,
): VirtualPerformanceAgeBucket {
  const age = Math.max(0, Date.parse(now) - Date.parse(participatedAt));
  if (age <= VIRTUAL_PERFORMANCE_RECENT_DAYS * DAY_MS) {
    return 'last_90_days';
  }
  return age <= VIRTUAL_PERFORMANCE_YEAR_DAYS * DAY_MS ? 'last_year' : 'older';
}

function planningEntry(
  entry: VirtualPerformanceEvidence,
  index: number,
  now: string,
): VirtualPerformancePlanningEntry {
  const ageBucket = virtualPerformanceAgeBucket(entry.participatedAt, now);
  return {
    evidenceRef: `vp-${index + 1}`,
    performance: entry.performance,
    methodLabel: entry.calculationMethod,
    independence: entry.independence,
    priorExposure: entry.priorExposure,
    ageBucket,
    recent: ageBucket === 'last_90_days',
  };
}

/**
 * Reduce one ledger (or its absence) to the identifier-free planning summary.
 *
 * The observation instant only decides the coarse age bucket; the summary's `ledgerHash` is
 * clock-free, so a moved clock can never look like changed evidence.
 */
export function virtualPerformancePlanningSummary(
  ledger: VirtualPerformanceLedger | null,
  now: string,
): VirtualPerformancePlanningSummary {
  const at = assertIsoTimestamp('virtual performance summary now', now);
  const entries = ledger === null ? [] : sortEvidence(ledger.entries);
  const eligible: VirtualPerformancePlanningEntry[] = [];
  const knownAssistedOrPriorExposed: VirtualPerformancePlanningEntry[] = [];
  const unknownIndependence: VirtualPerformancePlanningEntry[] = [];
  entries.forEach((entry, index) => {
    const view = planningEntry(entry, index, at);
    if (isEligibleVirtualPerformanceEvidence(entry)) {
      eligible.push(view);
    } else if (entry.independence === 'unknown') {
      unknownIndependence.push(view);
    } else {
      knownAssistedOrPriorExposed.push(view);
    }
  });
  return {
    version: VIRTUAL_PERFORMANCE_SUMMARY_VERSION,
    ledgerPresent: ledger !== null,
    ledgerRevision: ledger?.revision ?? 0,
    ledgerHash: virtualPerformanceLedgerHash(ledger),
    entryCount: entries.length,
    counts: virtualPerformanceCounts(entries),
    eligible,
    knownAssistedOrPriorExposed,
    unknownIndependence,
    estimation: 'not_estimated',
    disclosure: VIRTUAL_PERFORMANCE_DISCLOSURE,
  };
}

/**
 * The clock-free identity of one planning summary for `planPreparationEvidenceHash` (Sprint 18c).
 *
 * The age bucket is deliberately excluded: it is derived from the observation instant, so including
 * it would make the evidence hash of *unchanged* evidence depend on the clock. The ledger hash
 * inside is clock-free and covers every stored semantic field, which is what makes a mutation or
 * deletion invalidate a preparation.
 */
export function virtualPerformanceEvidenceIdentity(summary: VirtualPerformancePlanningSummary): unknown {
  const identityOf = (entry: VirtualPerformancePlanningEntry): unknown => ({
    evidenceRef: entry.evidenceRef,
    performance: entry.performance,
    methodLabel: entry.methodLabel,
    independence: entry.independence,
    priorExposure: entry.priorExposure,
  });
  return {
    version: summary.version,
    ledgerPresent: summary.ledgerPresent,
    ledgerRevision: summary.ledgerRevision,
    ledgerHash: summary.ledgerHash,
    entryCount: summary.entryCount,
    counts: summary.counts,
    eligible: summary.eligible.map(identityOf),
    knownAssistedOrPriorExposed: summary.knownAssistedOrPriorExposed.map(identityOf),
    unknownIndependence: summary.unknownIndependence.map(identityOf),
    estimation: summary.estimation,
  };
}

const SUMMARY_KEYS = [
  'version',
  'ledgerPresent',
  'ledgerRevision',
  'ledgerHash',
  'entryCount',
  'counts',
  'eligible',
  'knownAssistedOrPriorExposed',
  'unknownIndependence',
  'estimation',
  'disclosure',
] as const;
const SUMMARY_ENTRY_KEYS = [
  'evidenceRef',
  'performance',
  'methodLabel',
  'independence',
  'priorExposure',
  'ageBucket',
  'recent',
] as const;
const SUMMARY_COUNT_KEYS = [
  'total',
  'eligibleIndependent',
  'assisted',
  'unknownIndependence',
  'priorExposed',
] as const;
const AGE_BUCKETS: readonly VirtualPerformanceAgeBucket[] = ['last_90_days', 'last_year', 'older'];

/**
 * Strictly validate one persisted planning summary.
 *
 * The summary is stored JSON that a model-adjacent path reads, so it is re-validated structurally
 * (closed key sets, bounded strings, 64-hex ledger hash, counts consistent with the three groups)
 * instead of being trusted. Its closed shape is also the privacy guarantee: there is no field a
 * contest id, a note, a URL, a rank or an exact timestamp could travel in.
 */
export function validateVirtualPerformancePlanningSummary(value: unknown): VirtualPerformancePlanningSummary {
  const record = requireObject('virtual performance planning summary', value);
  requireExactKeys('virtual performance planning summary', record, SUMMARY_KEYS);
  const version = requireText('virtual performance planning summary version', record['version'], 100);
  invariant(
    typeof record['ledgerPresent'] === 'boolean',
    'invalid_input',
    'virtual performance planning summary ledgerPresent must be boolean',
    { ledgerPresent: record['ledgerPresent'] },
  );
  const ledgerRevision =
    typeof record['ledgerRevision'] === 'number' &&
    Number.isSafeInteger(record['ledgerRevision']) &&
    record['ledgerRevision'] >= 0
      ? (record['ledgerRevision'] as number)
      : null;
  invariant(
    ledgerRevision !== null,
    'invalid_input',
    'virtual performance planning summary ledgerRevision must be an integer >= 0',
    { ledgerRevision: record['ledgerRevision'] },
  );
  const ledgerHash = record['ledgerHash'];
  invariant(
    typeof ledgerHash === 'string' && /^[0-9a-f]{64}$/u.test(ledgerHash),
    'invalid_input',
    'virtual performance planning summary ledgerHash must be a sha256 digest',
    { ledgerHash },
  );
  invariant(
    record['estimation'] === 'not_estimated',
    'invalid_input',
    'virtual performance planning summary must state that no estimation was performed',
    { estimation: record['estimation'] },
  );
  const disclosure = requireText('virtual performance planning summary disclosure', record['disclosure'], 1000);
  const groups = (['eligible', 'knownAssistedOrPriorExposed', 'unknownIndependence'] as const).map((key) => {
    const raw = record[key];
    invariant(Array.isArray(raw), 'invalid_input', `virtual performance planning summary ${key} must be an array`, {
      key,
    });
    invariant(
      raw.length <= MAX_VIRTUAL_PERFORMANCE_ROWS,
      'invalid_input',
      `virtual performance planning summary ${key} holds at most ${MAX_VIRTUAL_PERFORMANCE_ROWS} entries`,
      { key, length: raw.length },
    );
    return raw.map((entry) => validateSummaryEntry(key, entry));
  });
  const [eligible = [], knownAssistedOrPriorExposed = [], unknownIndependence = []] = groups;
  const counts = requireObject('virtual performance planning summary counts', record['counts']);
  requireExactKeys('virtual performance planning summary counts', counts, SUMMARY_COUNT_KEYS);
  const countOf = (key: string): number => {
    const value = counts[key];
    invariant(
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
      'invalid_input',
      `virtual performance planning summary counts.${key} must be an integer >= 0`,
      { key, value },
    );
    return value;
  };
  const entryCount = countOf('total');
  const summaryCounts: VirtualPerformanceCounts = {
    total: entryCount,
    eligibleIndependent: countOf('eligibleIndependent'),
    assisted: countOf('assisted'),
    unknownIndependence: countOf('unknownIndependence'),
    priorExposed: countOf('priorExposed'),
  };
  invariant(
    entryCount === eligible.length + knownAssistedOrPriorExposed.length + unknownIndependence.length,
    'invalid_input',
    'virtual performance planning summary entryCount does not match its three evidence groups',
    { entryCount, groups: groups.map((group) => group.length) },
  );
  invariant(
    summaryCounts.eligibleIndependent === eligible.length &&
      summaryCounts.unknownIndependence === unknownIndependence.length,
    'invalid_input',
    'virtual performance planning summary counts do not match its evidence groups',
    { counts: summaryCounts },
  );
  const refs = new Set<string>();
  for (const entry of [...eligible, ...knownAssistedOrPriorExposed, ...unknownIndependence]) {
    invariant(
      !refs.has(entry.evidenceRef),
      'invalid_input',
      `virtual performance planning summary repeats reference ${entry.evidenceRef}`,
      { evidenceRef: entry.evidenceRef },
    );
    refs.add(entry.evidenceRef);
  }
  return {
    version,
    ledgerPresent: record['ledgerPresent'],
    ledgerRevision: ledgerRevision as number,
    ledgerHash,
    entryCount,
    counts: summaryCounts,
    eligible,
    knownAssistedOrPriorExposed,
    unknownIndependence,
    estimation: 'not_estimated',
    disclosure,
  };
}

function validateSummaryEntry(group: string, value: unknown): VirtualPerformancePlanningEntry {
  const record = requireObject(`virtual performance planning summary ${group} entry`, value);
  requireExactKeys(`virtual performance planning summary ${group} entry`, record, SUMMARY_ENTRY_KEYS);
  const performance = record['performance'];
  invariant(
    typeof performance === 'number' &&
      Number.isSafeInteger(performance) &&
      performance >= VIRTUAL_PERFORMANCE_MIN &&
      performance <= VIRTUAL_PERFORMANCE_MAX,
    'invalid_input',
    `virtual performance planning summary ${group} performance is out of bounds`,
    { performance },
  );
  const independence = record['independence'];
  invariant(
    VIRTUAL_PERFORMANCE_INDEPENDENCE.includes(independence as VirtualPerformanceIndependence),
    'invalid_input',
    `virtual performance planning summary ${group} independence is unknown`,
    { independence },
  );
  invariant(
    typeof record['priorExposure'] === 'boolean' && typeof record['recent'] === 'boolean',
    'invalid_input',
    `virtual performance planning summary ${group} flags must be boolean`,
    {},
  );
  const ageBucket = record['ageBucket'];
  invariant(
    AGE_BUCKETS.includes(ageBucket as VirtualPerformanceAgeBucket),
    'invalid_input',
    `virtual performance planning summary ${group} ageBucket is unknown`,
    { ageBucket },
  );
  const entry: VirtualPerformancePlanningEntry = {
    evidenceRef: requireText(`virtual performance planning summary ${group} evidenceRef`, record['evidenceRef'], 64),
    performance,
    methodLabel: requireText(
      `virtual performance planning summary ${group} methodLabel`,
      record['methodLabel'],
      MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS,
    ),
    independence: independence as VirtualPerformanceIndependence,
    priorExposure: record['priorExposure'],
    ageBucket: ageBucket as VirtualPerformanceAgeBucket,
    recent: record['recent'],
  };
  invariant(
    (entry.ageBucket === 'last_90_days') === entry.recent,
    'invalid_input',
    'virtual performance planning summary recent must match the recent age bucket',
    { ageBucket: entry.ageBucket, recent: entry.recent },
  );
  return entry;
}
