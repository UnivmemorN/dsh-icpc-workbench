#!/usr/bin/env node
/**
 * Reproducible, idempotent local compatibility patch for @lemcae/dsh-balance.
 *
 * Why: the ICPC client runtime types `commands.execute(agentId, line, submittedAttachments, signal?)`
 * — the attachments argument is required. The published @lemcae/dsh-balance 0.1.7 /
 * 0.1.7-icpc-compat.1 client calls it with two arguments, so every balance RPC is rejected before
 * dispatch, and the old code swallowed every failure into `null` forever (the chip and the Settings
 * card stayed on "loading"). This patch is local-only: it never talks to the network, never touches
 * credentials, and never changes the shipped host half or the harness.
 *
 * What it changes:
 *   1. adds the required empty `[]` attachments argument to every `commands.execute` call;
 *   2. returns a fixed, finite error payload (`{ ok: false, error: <local code> }`) instead of
 *      `null` for a missing session, a failed envelope, invalid JSON or a thrown transport error,
 *      and never copies host/thrown text into that payload;
 *   3. validates the parsed payload is a record with a boolean `ok`; success payloads pass through
 *      unchanged;
 *   4. localizes those error codes at render time and adds a manual retry button to the Settings
 *      card so a failed lookup can never be stranded (the header chip keeps its click-to-refresh);
 *   5. bumps `package.version` to 0.1.7-icpc-compat.2 and removes the stale `sourceMappingURL`
 *      comment from the edited lib/client.js so the map cannot pretend to describe edited code
 *      (the `.map` files themselves are kept).
 *
 * Safety model: every replacement is anchored on the exact trimmed lines of the shipped file. The
 * script validates the package name, the incoming version and every anchor in memory first, then
 * stages all writes as temp files and renames them. An unexpected package, a diverged source or a
 * partial state is refused with a non-zero exit code and no writes. Running it twice is a no-op.
 *
 * Usage:
 *   node scripts/patch-balance-client.mjs <package-directory>
 *
 * @typedef {{ id: string, anchor: string[], replacement: string[], count?: number }} PatchOp
 */

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PACKAGE_NAME = '@lemcae/dsh-balance'
export const TARGET_VERSION = '0.1.7-icpc-compat.2'
/** Versions the patch may start from: the upstream release and the first local compatibility patch. */
export const ACCEPTED_SOURCE_VERSIONS = ['0.1.7', '0.1.7-icpc-compat.1']
/** Marker written into both edited files; its presence means "already patched". */
export const PATCH_MARKER = 'dsh-balance-icpc-compat.2'
export const SOURCE_FILE = 'src/client/index.ts'
export const LIB_FILE = 'lib/client.js'
export const SOURCE_MAP_COMMENT = '//# sourceMappingURL=client.js.map'
const VERSION_PATTERN = /("version"\s*:\s*")([^"]*)(")/

/** Raised for every refusal; the CLI turns it into exit code 1. */
export class PatchRefusedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PatchRefusedError'
  }
}

const SOURCE_ERROR_TABLE = [
  '/** dsh-balance-icpc-compat.2: fixed local error codes; host or thrown text is never forwarded. */',
  "const BALANCE_ERROR_NO_SESSION = 'no-session'",
  "const BALANCE_ERROR_REQUEST = 'request'",
  "const BALANCE_ERROR_ENVELOPE = 'envelope'",
  "const BALANCE_ERROR_PAYLOAD = 'payload'",
  '',
  '/** Error code -> localized copy; unknown codes fall back to the generic message. */',
  'const BALANCE_ERROR_TEXT: Record<Lang, Record<string, string>> = {',
  '  zh: {',
  "    'no-session': '没有可用会话，无法查询余额',",
  "    request: '余额查询失败，请点击重试',",
  "    envelope: '宿主返回了无法识别的响应',",
  "    payload: '响应数据格式无效',",
  '  },',
  '  en: {',
  "    'no-session': 'No active session; cannot query the balance',",
  "    request: 'Balance request failed; click to retry',",
  "    envelope: 'The host returned an unrecognized response',",
  "    payload: 'Response data was not valid',",
  '  },',
  '}',
  '',
  'function errorText(lang: Lang, code: unknown): string {',
  '  const table = BALANCE_ERROR_TEXT[lang] ?? BALANCE_ERROR_TEXT.zh',
  "  const localized = typeof code === 'string' && Object.prototype.hasOwnProperty.call(table, code)",
  '    ? table[code]',
  '    : undefined',
  "  return typeof localized === 'string' ? localized : (table[BALANCE_ERROR_REQUEST] as string)",
  '}',
  '',
  'function t(lang: Lang, key: keyof typeof COPY.zh): string {',
  '  return COPY[lang][key] ?? COPY.zh[key] ?? String(key)',
  '}',
]

const LIB_ERROR_TABLE = [
  '\t\t/** dsh-balance-icpc-compat.2: fixed local error codes; host or thrown text is never forwarded. */',
  "\t\tconst BALANCE_ERROR_NO_SESSION = 'no-session';",
  "\t\tconst BALANCE_ERROR_REQUEST = 'request';",
  "\t\tconst BALANCE_ERROR_ENVELOPE = 'envelope';",
  "\t\tconst BALANCE_ERROR_PAYLOAD = 'payload';",
  '',
  '\t\t/** Error code -> localized copy; unknown codes fall back to the generic message. */',
  '\t\tconst BALANCE_ERROR_TEXT = {',
  '\t\t\tzh: {',
  "\t\t\t\t'no-session': '没有可用会话，无法查询余额',",
  "\t\t\t\trequest: '余额查询失败，请点击重试',",
  "\t\t\t\tenvelope: '宿主返回了无法识别的响应',",
  "\t\t\t\tpayload: '响应数据格式无效',",
  '\t\t\t},',
  '\t\t\ten: {',
  "\t\t\t\t'no-session': 'No active session; cannot query the balance',",
  "\t\t\t\trequest: 'Balance request failed; click to retry',",
  "\t\t\t\tenvelope: 'The host returned an unrecognized response',",
  "\t\t\t\tpayload: 'Response data was not valid',",
  '\t\t\t},',
  '\t\t};',
  '',
  '\t\tfunction errorText(lang, code) {',
  '\t\t\tconst table = BALANCE_ERROR_TEXT[lang] ?? BALANCE_ERROR_TEXT.zh;',
  "\t\t\tconst localized = typeof code === 'string' && Object.prototype.hasOwnProperty.call(table, code) ? table[code] : void 0;",
  "\t\t\treturn typeof localized === 'string' ? localized : table[BALANCE_ERROR_REQUEST];",
  '\t\t}',
  '',
  '\t\tfunction t(lang, key) {',
  '\t\t\treturn COPY[lang][key] ?? COPY.zh[key] ?? String(key);',
  '\t\t}',
]

const SOURCE_RUN_COMMAND = [
  '// dsh-balance-icpc-compat.2: execute requires the third attachments argument (this plugin attaches no files).',
  'const runCommand = async (sessionId: string | undefined, line: string): Promise<ResultPayload> => {',
  "  const sid = sessionId ?? ''",
  '  if (sid.length === 0) return { ok: false, error: BALANCE_ERROR_NO_SESSION }',
  '  try {',
  '    // 生成的 Remote 命名空间返回 { ok, value } 信封。',
  '    const execution = await ctx.remote.commands.execute(sid as SessionId, line, [])',
  '    const value = isRecord(execution) && execution.ok === true ? execution.value : undefined',
  '    if (value === undefined) return { ok: false, error: BALANCE_ERROR_ENVELOPE }',
  '    const text = isRecord(value) && isRecord(value.result) ? value.result.text : undefined',
  "    if (typeof text !== 'string' || text.length === 0) return { ok: false, error: BALANCE_ERROR_ENVELOPE }",
  '    let parsed: unknown',
  '    try {',
  '      parsed = JSON.parse(text)',
  '    } catch {',
  '      return { ok: false, error: BALANCE_ERROR_PAYLOAD }',
  '    }',
  "    if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') return { ok: false, error: BALANCE_ERROR_PAYLOAD }",
  '    return parsed as ResultPayload',
  '  } catch {',
  '    return { ok: false, error: BALANCE_ERROR_REQUEST }',
  '  }',
  '}',
]

const LIB_RUN_COMMAND = [
  '\t\t\t// dsh-balance-icpc-compat.2: execute requires the third attachments argument (this plugin attaches no files).',
  '\t\t\tconst runCommand = async (sessionId, line) => {',
  '\t\t\t\tconst sid = sessionId ?? "";',
  '\t\t\t\tif (sid.length === 0) return { ok: false, error: BALANCE_ERROR_NO_SESSION };',
  '\t\t\t\ttry {',
  '\t\t\t\t\tconst execution = await ctx.remote.commands.execute(sid, line, []);',
  '\t\t\t\t\tconst value = isRecord(execution) && execution.ok === true ? execution.value : void 0;',
  '\t\t\t\t\tif (value === void 0) return { ok: false, error: BALANCE_ERROR_ENVELOPE };',
  '\t\t\t\t\tconst text = isRecord(value) && isRecord(value.result) ? value.result.text : void 0;',
  '\t\t\t\t\tif (typeof text !== "string" || text.length === 0) return { ok: false, error: BALANCE_ERROR_ENVELOPE };',
  '\t\t\t\t\tlet parsed;',
  '\t\t\t\t\ttry {',
  '\t\t\t\t\t\tparsed = JSON.parse(text);',
  '\t\t\t\t\t} catch {',
  '\t\t\t\t\t\treturn { ok: false, error: BALANCE_ERROR_PAYLOAD };',
  '\t\t\t\t\t}',
  '\t\t\t\t\tif (!isRecord(parsed) || typeof parsed.ok !== "boolean") return { ok: false, error: BALANCE_ERROR_PAYLOAD };',
  '\t\t\t\t\treturn parsed;',
  '\t\t\t\t} catch {',
  '\t\t\t\t\treturn { ok: false, error: BALANCE_ERROR_REQUEST };',
  '\t\t\t\t}',
  '\t\t\t};',
]

/** Source (TypeScript) replacements, applied in order after all anchors are validated. */
export const SOURCE_OPS = [
  {
    id: 'localized-error-table',
    anchor: [
      'function t(lang: Lang, key: keyof typeof COPY.zh): string {',
      'return COPY[lang][key] ?? COPY.zh[key] ?? String(key)',
      '}',
    ],
    replacement: SOURCE_ERROR_TABLE,
  },
  {
    id: 'execute-attachments',
    anchor: [
      'const runCommand = async (sessionId: string | undefined, line: string): Promise<ResultPayload | null> => {',
      "const sid = sessionId ?? ''",
      'try {',
      '// 生成的 Remote 命名空间返回 { ok, value } 信封。',
      'const execution = await ctx.remote.commands.execute(sid as SessionId, line)',
      'const value = isRecord(execution) && execution.ok === true ? execution.value : undefined',
      'const text = value !== undefined && isRecord(value) && isRecord(value.result)',
      '? value.result.text',
      ': undefined',
      "if (typeof text !== 'string' || text.length === 0) return null",
      'try {',
      'return JSON.parse(text) as ResultPayload',
      '} catch {',
      'return null',
      '}',
      '} catch {',
      'return null',
      '}',
      '}',
    ],
    replacement: SOURCE_RUN_COMMAND,
  },
  {
    id: 'refresh-guard',
    count: 4,
    anchor: [
      "const payload = await runCommand(sessionId, '/dsh-balance refresh')",
      'if (disposed || payload === null) return',
    ],
    replacement: [
      "          const payload = await runCommand(sessionId, '/dsh-balance refresh')",
      '          if (disposed) return',
    ],
  },
  {
    id: 'chip-manual-refresh',
    anchor: [
      "void runCommand(sessionId, '/dsh-balance refresh').then((payload) => {",
      'if (payload === null) return',
    ],
    replacement: ["      void runCommand(sessionId, '/dsh-balance refresh').then((payload) => {"],
  },
  {
    id: 'chip-failure-tooltip',
    anchor: [
      'const tipLabel = (): string => {',
      "if (view.kind === 'data' && view.result.ok === true) {",
      'const result = view.result',
    ],
    replacement: [
      '    const tipLabel = (): string => {',
      "      if (view.kind === 'data') {",
      "        if (view.result.ok !== true) return `${errorText(lang, view.result.error)}\\n${L('retry')}`",
      '        const result = view.result',
    ],
  },
  {
    id: 'apply-interval',
    anchor: [
      'void runCommand(sessionId, `/dsh-balance interval ${ms}`).then((payload) => {',
      'if (payload !== null) applyPayload(payload)',
      '})',
    ],
    replacement: ['      void runCommand(sessionId, `/dsh-balance interval ${ms}`).then(applyPayload)'],
  },
  {
    id: 'apply-auto-refresh',
    anchor: [
      "void runCommand(sessionId, `/dsh-balance auto-refresh ${enabled ? 'on' : 'off'}`).then((payload) => {",
      'if (payload !== null) applyPayload(payload)',
      '})',
    ],
    replacement: ["      void runCommand(sessionId, `/dsh-balance auto-refresh ${enabled ? 'on' : 'off'}`).then(applyPayload)"],
  },
  {
    id: 'apply-prices',
    anchor: [
      'void runCommand(sessionId, `/dsh-balance prices ${JSON.stringify(prices)}`).then((payload) => {',
      'if (payload !== null) applyPayload(payload)',
      '})',
    ],
    replacement: ['      void runCommand(sessionId, `/dsh-balance prices ${JSON.stringify(prices)}`).then(applyPayload)'],
  },
  {
    id: 'apply-language',
    anchor: [
      'void runCommand(sessionId, `/dsh-balance language ${value}`).then((payload) => {',
      'if (payload !== null) applyPayload(payload)',
      '})',
    ],
    replacement: ['      void runCommand(sessionId, `/dsh-balance language ${value}`).then(applyPayload)'],
  },
  {
    id: 'card-refresh-button',
    anchor: [
      "void runCommand(sessionId, '/dsh-balance refresh').then((payload) => {",
      'if (payload !== null) applyPayload(payload)',
      '})',
    ],
    replacement: ["            void runCommand(sessionId, '/dsh-balance refresh').then(applyPayload)"],
  },
  {
    id: 'card-failure-retry',
    anchor: [
      'if (result.ok !== true) {',
      "const message = typeof result.error === 'string' ? result.error : (lang === 'zh' ? '查询失败' : 'Query failed')",
      "return React.createElement('div', { className: styles.err }, message)",
      '}',
    ],
    replacement: [
      '      if (result.ok !== true) {',
      "        return React.createElement('div', { className: styles.err },",
      "          React.createElement('div', null, errorText(lang, result.error)),",
      "          React.createElement('button', {",
      '            className: styles.btn,',
      "            type: 'button',",
      '            onClick: () => {',
      '              if (sessionId === undefined) return',
      "              void runCommand(sessionId, '/dsh-balance refresh').then(applyPayload)",
      '            },',
      "          }, L('retry')),",
      '        )',
      '      }',
    ],
  },
]

/** Compiled client (JavaScript) replacements, applied in order after all anchors are validated. */
export const LIB_OPS = [
  {
    id: 'localized-error-table',
    anchor: [
      'function t(lang, key) {',
      'return COPY[lang][key] ?? COPY.zh[key] ?? String(key);',
      '}',
    ],
    replacement: LIB_ERROR_TABLE,
  },
  {
    id: 'execute-attachments',
    anchor: [
      'const runCommand = async (sessionId, line) => {',
      'const sid = sessionId ?? "";',
      'try {',
      'const execution = await ctx.remote.commands.execute(sid, line);',
      'const value = isRecord(execution) && execution.ok === true ? execution.value : void 0;',
      'const text = value !== void 0 && isRecord(value) && isRecord(value.result) ? value.result.text : void 0;',
      'if (typeof text !== "string" || text.length === 0) return null;',
      'try {',
      'return JSON.parse(text);',
      '} catch {',
      'return null;',
      '}',
      '} catch {',
      'return null;',
      '}',
      '};',
    ],
    replacement: LIB_RUN_COMMAND,
  },
  {
    id: 'refresh-guard',
    count: 2,
    anchor: [
      'const payload = await runCommand(sessionId, "/dsh-balance refresh");',
      'if (disposed || payload === null) return;',
    ],
    replacement: [
      '\t\t\t\t\t\t\tconst payload = await runCommand(sessionId, "/dsh-balance refresh");',
      '\t\t\t\t\t\t\tif (disposed) return;',
    ],
  },
  {
    id: 'chip-manual-refresh',
    anchor: [
      'runCommand(sessionId, "/dsh-balance refresh").then((payload) => {',
      'if (payload === null) return;',
    ],
    replacement: ['\t\t\t\t\trunCommand(sessionId, "/dsh-balance refresh").then((payload) => {'],
  },
  {
    id: 'chip-failure-tooltip',
    anchor: [
      'const tipLabel = () => {',
      'if (view.kind === "data" && view.result.ok === true) {',
      'const result = view.result;',
    ],
    replacement: [
      '\t\t\t\tconst tipLabel = () => {',
      '\t\t\t\t\tif (view.kind === "data") {',
      '\t\t\t\t\t\tif (view.result.ok !== true) return `${errorText(lang, view.result.error)}\\n${L("retry")}`;',
      '\t\t\t\t\t\tconst result = view.result;',
    ],
  },
  {
    id: 'apply-interval',
    anchor: [
      'runCommand(sessionId, `/dsh-balance interval ${ms}`).then((payload) => {',
      'if (payload !== null) applyPayload(payload);',
      '});',
    ],
    replacement: ['\t\t\t\t\trunCommand(sessionId, `/dsh-balance interval ${ms}`).then(applyPayload);'],
  },
  {
    id: 'apply-auto-refresh',
    anchor: [
      'runCommand(sessionId, `/dsh-balance auto-refresh ${enabled ? "on" : "off"}`).then((payload) => {',
      'if (payload !== null) applyPayload(payload);',
      '});',
    ],
    replacement: ['\t\t\t\t\trunCommand(sessionId, `/dsh-balance auto-refresh ${enabled ? "on" : "off"}`).then(applyPayload);'],
  },
  {
    id: 'apply-prices',
    anchor: [
      'runCommand(sessionId, `/dsh-balance prices ${JSON.stringify(prices)}`).then((payload) => {',
      'if (payload !== null) applyPayload(payload);',
      '});',
    ],
    replacement: ['\t\t\t\t\trunCommand(sessionId, `/dsh-balance prices ${JSON.stringify(prices)}`).then(applyPayload);'],
  },
  {
    id: 'apply-language',
    anchor: [
      'runCommand(sessionId, `/dsh-balance language ${value}`).then((payload) => {',
      'if (payload !== null) applyPayload(payload);',
      '});',
    ],
    replacement: ['\t\t\t\t\trunCommand(sessionId, `/dsh-balance language ${value}`).then(applyPayload);'],
  },
  {
    id: 'card-refresh-button',
    anchor: [
      'runCommand(sessionId, "/dsh-balance refresh").then((payload) => {',
      'if (payload !== null) applyPayload(payload);',
      '});',
    ],
    replacement: ['\t\t\t\t\t\t\trunCommand(sessionId, "/dsh-balance refresh").then(applyPayload);'],
  },
  {
    id: 'card-failure-retry',
    anchor: [
      'if (result.ok !== true) {',
      'const message = typeof result.error === "string" ? result.error : lang === "zh" ? "查询失败" : "Query failed";',
      'return react.createElement("div", { className: balance_module_css_default.err }, message);',
      '}',
    ],
    replacement: [
      '\t\t\t\t\tif (result.ok !== true) {',
      '\t\t\t\t\t\treturn react.createElement("div", { className: balance_module_css_default.err },',
      '\t\t\t\t\t\t\treact.createElement("div", null, errorText(lang, result.error)),',
      '\t\t\t\t\t\t\treact.createElement("button", {',
      '\t\t\t\t\t\t\t\tclassName: balance_module_css_default.btn,',
      '\t\t\t\t\t\t\t\ttype: "button",',
      '\t\t\t\t\t\t\t\tonClick: () => {',
      '\t\t\t\t\t\t\t\t\tif (sessionId === void 0) return;',
      '\t\t\t\t\t\t\t\t\trunCommand(sessionId, "/dsh-balance refresh").then(applyPayload);',
      '\t\t\t\t\t\t\t\t}',
      '\t\t\t\t\t\t\t}, L("retry")));',
      '\t\t\t\t\t}',
    ],
  },
  {
    id: 'drop-sourcemap-comment',
    anchor: [SOURCE_MAP_COMMENT],
    replacement: [],
  },
]

/** Split while preserving the file's own line endings, so an untouched file round-trips byte-for-byte. */
function splitLines(file, content) {
  const crlf = (content.match(/\r\n/g) ?? []).length
  const lf = (content.match(/\n/g) ?? []).length
  if (crlf > 0 && crlf !== lf) {
    throw new PatchRefusedError(`${file}: mixes CRLF and LF line endings; refusing to rewrite it`)
  }
  return { lines: content.split(crlf > 0 ? '\r\n' : '\n'), eol: crlf > 0 ? '\r\n' : '\n' }
}

/**
 * Apply the anchored operations to one file's text. Every anchor is matched by trimmed line
 * content, so tab/space indentation differences between builds do not matter, while any content
 * change is still detected. Operations run against the text produced so far, so each one is
 * verified (and refused) before the caller writes anything to disk.
 */
export function applyPatchOps(file, content, ops) {
  const { lines, eol } = splitLines(file, content)
  let patched = [...lines]
  for (const op of ops) {
    const expected = op.count ?? 1
    const matches = []
    for (let index = 0; index + op.anchor.length <= patched.length; index++) {
      let matched = true
      for (let offset = 0; offset < op.anchor.length; offset++) {
        if (patched[index + offset].trim() !== op.anchor[offset]) {
          matched = false
          break
        }
      }
      if (matched) {
        matches.push(index)
        index += op.anchor.length - 1
      }
    }
    if (matches.length !== expected) {
      throw new PatchRefusedError(
        `${file}: operation "${op.id}" expected ${expected} anchor match(es) but found ${matches.length}; refusing to write`,
      )
    }
    for (let index = matches.length - 1; index >= 0; index--) {
      patched.splice(matches[index], op.anchor.length, ...op.replacement)
    }
  }
  return patched.join(eol)
}

/** Cheap post-conditions that must hold in the patched text; a failure means we refuse to write. */
function verifyPatched(file, content, kind) {
  const required = kind === 'source'
    ? ['commands.execute(sid as SessionId, line, [])', PATCH_MARKER, 'BALANCE_ERROR_NO_SESSION', 'errorText(lang, result.error)', "L('retry')"]
    : ['commands.execute(sid, line, [])', PATCH_MARKER, 'BALANCE_ERROR_NO_SESSION', 'errorText(lang, result.error)', 'L("retry")']
  for (const token of required) {
    if (!content.includes(token)) {
      throw new PatchRefusedError(`${file}: patched output is missing ${JSON.stringify(token)}; refusing to write`)
    }
  }
  if (kind === 'lib' && content.includes('sourceMappingURL')) {
    throw new PatchRefusedError(`${file}: patched output still declares a sourceMappingURL; refusing to write`)
  }
}

/** Retry only transient Windows replacement locks; never unlink the existing destination. */
export function replaceStagedFile(source, target, rename = renameSync, pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  for (let attempt = 0; ; attempt++) {
    try { rename(source, target); return }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 5) throw error
      pause(25 * 2 ** attempt)
    }
  }
}

/** Stage every write next to its target, then rename, so a refusal never leaves a half-written file. */
function commitWrites(files) {
  const staged = files.map(({ path, content }) => {
    const temp = `${path}.dsh-balance-patch.tmp`
    writeFileSync(temp, content, 'utf8')
    return { path, temp }
  })
  try {
    for (const entry of staged) replaceStagedFile(entry.temp, entry.path)
  } finally {
    for (const entry of staged) if (existsSync(entry.temp)) rmSync(entry.temp)
  }
}

function readJson(file, label) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new PatchRefusedError(`${label} is not readable: ${file}`)
  }
  try {
    return { text, json: JSON.parse(text) }
  } catch {
    throw new PatchRefusedError(`${label} is not valid JSON: ${file}`)
  }
}

/**
 * Patch one unpacked @lemcae/dsh-balance package directory.
 *
 * @param {string} packageDir directory containing package.json, src/client/index.ts and lib/client.js
 * @param {{ dryRun?: boolean }} [options] dryRun validates and prepares everything but writes nothing
 * @returns {{ status: 'patched'|'already-patched'|'version-only', packageDir: string, version: string, changedFiles: string[] }}
 */
export function patchBalancePackage(packageDir, options = {}) {
  const dir = resolve(packageDir)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new PatchRefusedError(`not a package directory: ${dir}`)
  }
  const packageJsonPath = join(dir, 'package.json')
  const { text: packageText, json: packageJson } = readJson(packageJsonPath, 'package.json')
  if (packageJson?.name !== PACKAGE_NAME) {
    throw new PatchRefusedError(`unexpected package name ${JSON.stringify(packageJson?.name)}; expected ${PACKAGE_NAME}`)
  }
  const versionMatch = VERSION_PATTERN.exec(packageText)
  if (versionMatch === null) {
    throw new PatchRefusedError('package.json has no "version" field')
  }
  const currentVersion = versionMatch[2]
  const knownVersions = [...ACCEPTED_SOURCE_VERSIONS, TARGET_VERSION]
  if (!knownVersions.includes(currentVersion)) {
    throw new PatchRefusedError(
      `unexpected version ${JSON.stringify(currentVersion)}; expected one of ${knownVersions.join(', ')}`,
    )
  }

  const sourcePath = join(dir, SOURCE_FILE)
  const libPath = join(dir, LIB_FILE)
  for (const [label, path] of [[SOURCE_FILE, sourcePath], [LIB_FILE, libPath]]) {
    if (!existsSync(path)) throw new PatchRefusedError(`missing ${label} in ${dir}`)
  }
  const sourceText = readFileSync(sourcePath, 'utf8')
  const libText = readFileSync(libPath, 'utf8')

  const sourcePatched = sourceText.includes(PATCH_MARKER)
  const libPatched = libText.includes(PATCH_MARKER)
  if (sourcePatched !== libPatched) {
    throw new PatchRefusedError(
      `${PACKAGE_NAME}: inconsistent patch state (${SOURCE_FILE} ${sourcePatched ? 'patched' : 'unpatched'}, `
      + `${LIB_FILE} ${libPatched ? 'patched' : 'unpatched'}); refusing to write`,
    )
  }
  if (sourcePatched && currentVersion === TARGET_VERSION && libText.includes(SOURCE_MAP_COMMENT)) {
    throw new PatchRefusedError(`${LIB_FILE} is patched but still declares a sourceMappingURL; refusing to report success`)
  }
  if (!sourcePatched && currentVersion === TARGET_VERSION) {
    throw new PatchRefusedError(
      `package.version is already ${TARGET_VERSION} but the client files are unpatched; refusing to guess`,
    )
  }

  const changedFiles = []
  let nextSource = sourceText
  let nextLib = libText
  if (sourcePatched) {
    verifyPatched(SOURCE_FILE, sourceText, 'source')
    verifyPatched(LIB_FILE, libText, 'lib')
  }
  if (!sourcePatched) {
    nextSource = applyPatchOps(SOURCE_FILE, sourceText, SOURCE_OPS)
    nextLib = applyPatchOps(LIB_FILE, libText, LIB_OPS)
    verifyPatched(SOURCE_FILE, nextSource, 'source')
    verifyPatched(LIB_FILE, nextLib, 'lib')
  }

  const nextPackageText = packageText.replace(VERSION_PATTERN, `$1${TARGET_VERSION}$3`)
  const nextPackageJson = JSON.parse(nextPackageText)
  for (const field of ['name', 'license', 'repository', 'author', 'peerDependencies', 'dsh']) {
    if (JSON.stringify(nextPackageJson[field]) !== JSON.stringify(packageJson[field])) {
      throw new PatchRefusedError(`package.json ${field} would change; refusing to write`)
    }
  }

  if (nextSource !== sourceText) changedFiles.push(SOURCE_FILE)
  if (nextLib !== libText) changedFiles.push(LIB_FILE)
  if (nextPackageText !== packageText) changedFiles.push('package.json')

  const status = changedFiles.length === 0 ? 'already-patched' : sourcePatched ? 'version-only' : 'patched'
  if (changedFiles.length > 0 && options.dryRun !== true) {
    commitWrites([
      { path: sourcePath, content: nextSource },
      { path: libPath, content: nextLib },
      { path: packageJsonPath, content: nextPackageText },
    ])
  }
  return { status, packageDir: dir, version: TARGET_VERSION, changedFiles }
}

function main(argv) {
  const target = argv[0]
  if (target === undefined || target === '--help' || target === '-h') {
    console.error('usage: node scripts/patch-balance-client.mjs <package-directory>')
    process.exitCode = 2
    return
  }
  try {
    const result = patchBalancePackage(target)
    const summary = result.changedFiles.length === 0
      ? 'already patched; nothing to do'
      : `${result.status}: ${result.changedFiles.join(', ')}`
    console.log(`[patch-balance-client] ${PACKAGE_NAME} -> ${result.version} (${summary})`)
    console.log(`[patch-balance-client] package directory: ${result.packageDir}`)
  } catch (error) {
    if (error instanceof PatchRefusedError) {
      console.error(`[patch-balance-client] refused: ${error.message}`)
      process.exitCode = 1
      return
    }
    throw error
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) main(process.argv.slice(2))
