/**
 * Focused tests for scripts/patch-balance-client.mjs.
 *
 * The synthetic fixtures are small line-level carriers that repeat the exact snippet lines of the
 * shipped @lemcae/dsh-balance package (both the TypeScript source and the compiled classic-script
 * client). They let public CI exercise the patch rules, refusals and the runtime behaviour of the
 * patched client without depending on `.local/`. When the real local compat directory exists, an
 * additional test patches a copy of it and repeats the behavioural checks against the actual build.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LIB_FILE,
  LIB_OPS,
  PACKAGE_NAME,
  PATCH_MARKER,
  PatchRefusedError,
  SOURCE_FILE,
  SOURCE_MAP_COMMENT,
  SOURCE_OPS,
  TARGET_VERSION,
  patchBalancePackage,
  replaceStagedFile,
} from './patch-balance-client.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REAL_PACKAGE_DIR = join(REPO_ROOT, '.local', 'dsh-balance-compat')
const PREVIOUS_VERSION = '0.1.7-icpc-compat.1'

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'icpc-balance-patch-'))
  const cleanup = () => {
    const target = resolve(root)
    const base = resolve(tmpdir())
    if (target === base || relative(base, target).startsWith('..')) throw new Error('unsafe test cleanup')
    rmSync(target, { recursive: true, force: true })
  }
  let result
  try {
    result = run(root)
  } catch (error) {
    cleanup()
    throw error
  }
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    return Promise.resolve(result).finally(cleanup)
  }
  cleanup()
  return result
}

/**
 * Synthetic fixture: every anchor of the source patch, wrapped in snippet functions. It is a line
 * carrier for the patch rules, not compilable plugin code.
 */
function buildSourceFixture() {
  const lines = [
    '// synthetic src/client/index.ts fixture; the snippet lines match the shipped package.',
    "type Lang = 'zh' | 'en'",
    "const COPY = { zh: { retry: '点击重试' }, en: { retry: 'Click to retry' } }",
    "const styles = { err: 'err', btn: 'btn' }",
    'declare const ctx: unknown',
    'declare function isRecord(value: unknown): value is Record<string, unknown>',
    'declare const React: any',
  ]
  const counters = new Map()
  for (const op of SOURCE_OPS) {
    for (let index = 0; index < (op.count ?? 1); index++) {
      const seen = (counters.get(op.id) ?? 0) + 1
      counters.set(op.id, seen)
      lines.push(`async function snippet_${op.id.replaceAll('-', '_')}_${seen}() {`)
      lines.push(...op.anchor)
      lines.push('}')
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** Synthetic fixture: a loadable classic-script client bundle with every compiled anchor. */
function buildLibFixture() {
  return [
    'window.__ModuleLoader__.load({',
    '\tid: "@lemcae/dsh-balance",',
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tlet react = require("react");',
    '\t\tfunction isRecord(value) {',
    '\t\t\treturn typeof value === "object" && value !== null && !Array.isArray(value);',
    '\t\t}',
    '\t\tfunction resolveLang(language) {',
    '\t\t\tif (language === "zh-CN") return "zh";',
    '\t\t\tif (language === "en") return "en";',
    '\t\t\treturn "zh";',
    '\t\t}',
    '\t\tconst COPY = {',
    '\t\t\tzh: { retry: "点击重试", loading: "查询中…", noSession: "打开会话后自动显示余额", balanceDash: "余额 —" },',
    '\t\t\ten: { retry: "Click to retry", loading: "Loading…", noSession: "Open a session", balanceDash: "Balance —" }',
    '\t\t};',
    '\t\tconst balance_module_css_default = { err: "err", btn: "btn", muted: "muted", card: "card", util: "util", utilErr: "utilErr" };',
    '\t\tfunction t(lang, key) {',
    '\t\t\treturn COPY[lang][key] ?? COPY.zh[key] ?? String(key);',
    '\t\t}',
    '\t\tfunction apply(ctx) {',
    '\t\t\tconst runCommand = async (sessionId, line) => {',
    '\t\t\t\tconst sid = sessionId ?? "";',
    '\t\t\t\ttry {',
    '\t\t\t\t\tconst execution = await ctx.remote.commands.execute(sid, line);',
    '\t\t\t\t\tconst value = isRecord(execution) && execution.ok === true ? execution.value : void 0;',
    '\t\t\t\t\tconst text = value !== void 0 && isRecord(value) && isRecord(value.result) ? value.result.text : void 0;',
    '\t\t\t\t\tif (typeof text !== "string" || text.length === 0) return null;',
    '\t\t\t\t\ttry {',
    '\t\t\t\t\t\treturn JSON.parse(text);',
    '\t\t\t\t\t} catch {',
    '\t\t\t\t\t\treturn null;',
    '\t\t\t\t\t}',
    '\t\t\t\t} catch {',
    '\t\t\t\t\treturn null;',
    '\t\t\t\t}',
    '\t\t\t};',
    '\t\t\tconst BalanceChip = (props) => {',
    '\t\t\t\tconst sessionId = props.sessionId ?? "";',
    '\t\t\t\tconst [view, setView] = react.useState({ kind: "loading" });',
    '\t\t\t\tconst [intervalMs, setIntervalMs] = react.useState(3e4);',
    '\t\t\t\tconst [nextMs, setNextMs] = react.useState(3e4);',
    '\t\t\t\tconst [lang, setLang] = react.useState(resolveLang(void 0));',
    '\t\t\t\tconst L = (key) => t(lang, key);',
    '\t\t\t\treact.useEffect(() => {',
    '\t\t\t\t\tlet disposed = false;',
    '\t\t\t\t\tlet inFlight = false;',
    '\t\t\t\t\tconst tick = async () => {',
    '\t\t\t\t\t\tif (inFlight || disposed) return;',
    '\t\t\t\t\t\tinFlight = true;',
    '\t\t\t\t\t\ttry {',
    '\t\t\t\t\t\t\tconst payload = await runCommand(sessionId, "/dsh-balance refresh");',
    '\t\t\t\t\t\t\tif (disposed || payload === null) return;',
    '\t\t\t\t\t\t\tsetView({ kind: "data", result: payload });',
    '\t\t\t\t\t\t} finally {',
    '\t\t\t\t\t\t\tinFlight = false;',
    '\t\t\t\t\t\t}',
    '\t\t\t\t\t};',
    '\t\t\t\t\ttick();',
    '\t\t\t\t\tconst timer = setInterval(() => { tick(); }, nextMs);',
    '\t\t\t\t\treturn () => { disposed = true; clearInterval(timer); };',
    '\t\t\t\t}, [sessionId, intervalMs, nextMs]);',
    '\t\t\t\tconst tipLabel = () => {',
    '\t\t\t\t\tif (view.kind === "data" && view.result.ok === true) {',
    '\t\t\t\t\t\tconst result = view.result;',
    '\t\t\t\t\t\treturn String(result.fetchedAt ?? "");',
    '\t\t\t\t\t}',
    '\t\t\t\t\tif (view.kind === "error") return `${view.message}\\n${L("retry")}`;',
    '\t\t\t\t\treturn L("loading");',
    '\t\t\t\t};',
    '\t\t\t\tconst manualRefresh = () => {',
    '\t\t\t\t\trunCommand(sessionId, "/dsh-balance refresh").then((payload) => {',
    '\t\t\t\t\t\tif (payload === null) return;',
    '\t\t\t\t\t\tsetView({ kind: "data", result: payload });',
    '\t\t\t\t\t});',
    '\t\t\t\t};',
    '\t\t\t\treturn react.createElement("button", { onClick: manualRefresh, type: "button" }, tipLabel());',
    '\t\t\t};',
    '\t\t\tconst BalanceCard = (props) => {',
    '\t\t\t\tconst sessionId = props.sessionId;',
    '\t\t\t\tconst [view, setView] = react.useState({ kind: "loading" });',
    '\t\t\t\tconst [intervalMs, setIntervalMs] = react.useState(3e4);',
    '\t\t\t\tconst [nextMs, setNextMs] = react.useState(3e4);',
    '\t\t\t\tconst [prices, setPrices] = react.useState(null);',
    '\t\t\t\tconst [lang, setLang] = react.useState(resolveLang(void 0));',
    '\t\t\t\tconst L = (key) => t(lang, key);',
    '\t\t\t\tconst applyPayload = (payload) => { setView({ kind: "data", result: payload }); };',
    '\t\t\t\treact.useEffect(() => {',
    '\t\t\t\t\tif (sessionId === void 0) return;',
    '\t\t\t\t\tlet disposed = false;',
    '\t\t\t\t\tlet inFlight = false;',
    '\t\t\t\t\tconst tick = async () => {',
    '\t\t\t\t\t\tif (inFlight || disposed) return;',
    '\t\t\t\t\t\tinFlight = true;',
    '\t\t\t\t\t\ttry {',
    '\t\t\t\t\t\t\tconst payload = await runCommand(sessionId, "/dsh-balance refresh");',
    '\t\t\t\t\t\t\tif (disposed || payload === null) return;',
    '\t\t\t\t\t\t\tapplyPayload(payload);',
    '\t\t\t\t\t\t} finally {',
    '\t\t\t\t\t\t\tinFlight = false;',
    '\t\t\t\t\t\t}',
    '\t\t\t\t\t};',
    '\t\t\t\t\ttick();',
    '\t\t\t\t\tconst timer = setInterval(() => { tick(); }, nextMs);',
    '\t\t\t\t\treturn () => { disposed = true; clearInterval(timer); };',
    '\t\t\t\t}, [sessionId, intervalMs, nextMs]);',
    '\t\t\t\tconst applyInterval = (ms) => {',
    '\t\t\t\t\tif (sessionId === void 0) return;',
    '\t\t\t\t\trunCommand(sessionId, `/dsh-balance interval ${ms}`).then((payload) => {',
    '\t\t\t\t\t\tif (payload !== null) applyPayload(payload);',
    '\t\t\t\t\t});',
    '\t\t\t\t};',
    '\t\t\t\tconst applyAutoRefresh = (enabled) => {',
    '\t\t\t\t\tif (sessionId === void 0) return;',
    '\t\t\t\t\trunCommand(sessionId, `/dsh-balance auto-refresh ${enabled ? "on" : "off"}`).then((payload) => {',
    '\t\t\t\t\t\tif (payload !== null) applyPayload(payload);',
    '\t\t\t\t\t});',
    '\t\t\t\t};',
    '\t\t\t\tconst applyPrices = () => {',
    '\t\t\t\t\tif (sessionId === void 0 || prices === null) return;',
    '\t\t\t\t\trunCommand(sessionId, `/dsh-balance prices ${JSON.stringify(prices)}`).then((payload) => {',
    '\t\t\t\t\t\tif (payload !== null) applyPayload(payload);',
    '\t\t\t\t\t});',
    '\t\t\t\t};',
    '\t\t\t\tconst applyLanguage = (value) => {',
    '\t\t\t\t\tif (sessionId === void 0) return;',
    '\t\t\t\t\trunCommand(sessionId, `/dsh-balance language ${value}`).then((payload) => {',
    '\t\t\t\t\t\tif (payload !== null) applyPayload(payload);',
    '\t\t\t\t\t});',
    '\t\t\t\t};',
    '\t\t\t\tconst renderBody = () => {',
    '\t\t\t\t\tif (sessionId === void 0) return react.createElement("div", { className: balance_module_css_default.muted }, L("noSession"));',
    '\t\t\t\t\tif (view.kind === "loading") return react.createElement("div", null, L("loading"));',
    '\t\t\t\t\tconst result = view.result;',
    '\t\t\t\t\tif (result.ok !== true) {',
    '\t\t\t\t\t\tconst message = typeof result.error === "string" ? result.error : lang === "zh" ? "查询失败" : "Query failed";',
    '\t\t\t\t\t\treturn react.createElement("div", { className: balance_module_css_default.err }, message);',
    '\t\t\t\t\t}',
    '\t\t\t\t\treturn react.createElement("div", null, react.createElement("button", {',
    '\t\t\t\t\t\tclassName: balance_module_css_default.btn,',
    '\t\t\t\t\t\tonClick: () => {',
    '\t\t\t\t\t\t\tif (sessionId === void 0) return;',
    '\t\t\t\t\t\t\trunCommand(sessionId, "/dsh-balance refresh").then((payload) => {',
    '\t\t\t\t\t\t\t\tif (payload !== null) applyPayload(payload);',
    '\t\t\t\t\t\t\t});',
    '\t\t\t\t\t\t},',
    '\t\t\t\t\t\ttype: "button"',
    '\t\t\t\t\t}, L("retry")));',
    '\t\t\t\t};',
    '\t\t\t\treturn react.createElement("div", { className: balance_module_css_default.card }, react.createElement("div", null, L("balanceDash")), renderBody());',
    '\t\t\t};',
    '\t\t\tctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "dsh-balance" }, (props) => {',
    '\t\t\t\tconst currentId = props.useSessions((state) => state.current);',
    '\t\t\t\treturn react.createElement(BalanceCard, typeof currentId === "string" ? { settings: true, sessionId: currentId } : { settings: true });',
    '\t\t\t}));',
    '\t\t\tctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: "dsh-balance" }, (props) => react.createElement(BalanceChip, { sessionId: props.sessionId })));',
    '\t\t}',
    '\t\texports.apply = apply;',
    '\t\texports.inject = ["slots", "remote", "remote.commands"];',
    '\t\texports.name = "dsh-balance";',
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
    SOURCE_MAP_COMMENT,
    '',
  ].join('\n')
}

function createPackageFixture(root, options = {}) {
  mkdirSync(join(root, 'src', 'client'), { recursive: true })
  mkdirSync(join(root, 'lib'), { recursive: true })
  const manifest = {
    name: options.name ?? PACKAGE_NAME,
    description: 'synthetic @lemcae/dsh-balance fixture',
    version: options.version ?? PREVIOUS_VERSION,
    license: 'MIT',
    author: 'LemCAE',
    repository: { type: 'git', url: 'https://github.com/LemCAE/dsh-balance' },
    type: 'module',
  }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(root, SOURCE_FILE), options.source ?? buildSourceFixture())
  writeFileSync(join(root, LIB_FILE), options.lib ?? buildLibFixture())
  writeFileSync(join(root, 'lib', 'client.js.map'), '{"version":3,"file":"client.js"}\n')
  return {
    packageJson: join(root, 'package.json'),
    source: join(root, SOURCE_FILE),
    lib: join(root, LIB_FILE),
    sourceMap: join(root, 'lib', 'client.js.map'),
  }
}

function patchedLibSource() {
  return withTempDir((root) => {
    createPackageFixture(root)
    patchBalancePackage(root)
    return readFileSync(join(root, LIB_FILE), 'utf8')
  })
}

// ─── minimal React/render harness for the patched classic-script client ─────

function createReactShim() {
  const hooks = []
  let cursor = 0
  let scheduled = []
  const api = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(initial) {
      const index = cursor++
      if (hooks[index] === undefined) {
        hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      }
      const hook = hooks[index]
      return [hook.value, (next) => { hook.value = typeof next === 'function' ? next(hook.value) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { kind: 'ref', value: { current: initial } }
      return hooks[index].value
    },
    useEffect(fn, deps) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { first: true, deps: undefined, cleanup: undefined }
      const hook = hooks[index]
      const changed = hook.first === true
        || deps === undefined
        || hook.deps === undefined
        || deps.length !== hook.deps.length
        || deps.some((value, position) => !Object.is(value, hook.deps[position]))
      if (changed) {
        hook.first = false
        hook.deps = deps === undefined ? undefined : [...deps]
        hook.fn = fn
        scheduled.push(hook)
      }
    },
    useMemo(factory) { return factory() },
    useCallback(fn) { return fn },
    useLayoutEffect() {},
    Fragment: Symbol('Fragment'),
  }
  return {
    api,
    beginRender() { cursor = 0; scheduled = [] },
    runEffects() {
      const running = scheduled
      scheduled = []
      for (const hook of running) {
        if (typeof hook.cleanup === 'function') hook.cleanup()
        hook.cleanup = hook.fn()
      }
    },
    dispose() {
      for (const hook of hooks) {
        if (hook !== undefined && typeof hook.cleanup === 'function') {
          hook.cleanup()
          hook.cleanup = undefined
        }
      }
    },
  }
}

function renderTree(element) {
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (typeof element.type === 'function') return renderTree(element.type(element.props))
  return {
    type: element.type,
    props: element.props,
    children: element.children.map((child) => renderTree(child)),
  }
}

async function renderToSettled(root, react) {
  let tree = null
  for (let pass = 0; pass < 4; pass++) {
    react.beginRender()
    tree = renderTree(root)
    react.runEffects()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  }
  react.beginRender()
  return renderTree(root)
}

function collectText(node, out = []) {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (node === null || node === undefined || typeof node !== 'object') return out
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

function collectButtons(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (node.type === 'button') out.push(node)
  for (const child of node.children ?? []) collectButtons(child, out)
  return out
}

function loadClientModule(libSource, executeImpl) {
  const react = createReactShim()
  const registrations = new Map()
  const calls = []
  const ctx = {
    slots: {
      inject(_name, register) { return register() },
      register(meta, component) { registrations.set(meta.name, component) },
    },
    remote: {
      commands: {
        execute: async (...args) => {
          calls.push(args)
          return executeImpl(...args)
        },
      },
    },
  }
  let moduleExports
  const windowShim = {
    __ModuleLoader__: {
      load({ factory }) {
        moduleExports = factory((id) => {
          if (id === 'react') return react.api
          throw new Error(`unexpected require(${JSON.stringify(id)})`)
        })
      },
    },
  }
  new Function('window', libSource)(windowShim)
  assert.ok(moduleExports !== undefined, 'client bundle must register itself through window.__ModuleLoader__')
  moduleExports.apply(ctx)
  return { react, registrations, calls, moduleExports }
}

function extractFunctionSource(source, header) {
  const start = source.indexOf(header)
  assert.ok(start >= 0, `missing function header: ${header}`)
  let index = source.indexOf('{', start)
  let depth = 0
  let quote = null
  for (; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (quote !== null) {
      if (char === '\\') { index++; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '/' && next === '/') { while (index < source.length && source[index] !== '\n') index++; continue }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++
      index++
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) { index++; break }
    }
  }
  assert.equal(depth, 0, 'unbalanced function body')
  return source.slice(start, index)
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function buildRunCommand(libSource, execute) {
  const functionSource = extractFunctionSource(libSource, 'const runCommand = async (sessionId, line) => {')
  const factory = new Function(
    'ctx', 'isRecord',
    'BALANCE_ERROR_NO_SESSION', 'BALANCE_ERROR_REQUEST', 'BALANCE_ERROR_ENVELOPE', 'BALANCE_ERROR_PAYLOAD',
    `${functionSource};\nreturn runCommand;`,
  )
  return factory(
    { remote: { commands: { execute } } },
    isRecord, 'no-session', 'request', 'envelope', 'payload',
  )
}

// ─── patch mechanics ───────────────────────────────────────────────────────

test('patch rewrites both source variants, the version and the stale sourcemap comment', () => {
  withTempDir((root) => {
    const paths = createPackageFixture(root)
    const result = patchBalancePackage(root)
    assert.equal(result.status, 'patched')
    assert.equal(result.version, TARGET_VERSION)
    assert.deepEqual([...result.changedFiles].sort(), [LIB_FILE, SOURCE_FILE, 'package.json'].sort())

    const manifest = JSON.parse(readFileSync(paths.packageJson, 'utf8'))
    assert.equal(manifest.name, PACKAGE_NAME)
    assert.equal(manifest.version, TARGET_VERSION)
    assert.equal(manifest.license, 'MIT')
    assert.equal(manifest.author, 'LemCAE')
    assert.deepEqual(manifest.repository, { type: 'git', url: 'https://github.com/LemCAE/dsh-balance' })

    const source = readFileSync(paths.source, 'utf8')
    const lib = readFileSync(paths.lib, 'utf8')
    assert.match(source, /commands\.execute\(sid as SessionId, line, \[\]\)/)
    assert.match(source, /if \(sid\.length === 0\) return \{ ok: false, error: BALANCE_ERROR_NO_SESSION \}/)
    assert.match(source, /return \{ ok: false, error: BALANCE_ERROR_REQUEST \}/)
    assert.ok(source.includes(PATCH_MARKER))
    assert.match(lib, /commands\.execute\(sid, line, \[\]\)/)
    assert.ok(lib.includes(PATCH_MARKER))
    assert.equal(lib.includes('sourceMappingURL'), false)
    assert.equal(existsSync(paths.sourceMap), true, 'the sourcemap file itself must be kept')
    assert.equal(readFileSync(paths.sourceMap, 'utf8'), '{"version":3,"file":"client.js"}\n')
    assert.equal(source.includes('payload === null'), false)
    assert.equal(lib.includes('payload === null'), false)
    assert.equal(source.includes('return null'), false)
  })
})

test('patch accepts the upstream 0.1.7 version as well', () => {
  withTempDir((root) => {
    createPackageFixture(root, { version: '0.1.7' })
    assert.equal(patchBalancePackage(root).status, 'patched')
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, TARGET_VERSION)
  })
})

test('patch is idempotent and can finish a version-only resume', () => {
  withTempDir((root) => {
    const paths = createPackageFixture(root)
    patchBalancePackage(root)
    const after = [readFileSync(paths.source, 'utf8'), readFileSync(paths.lib, 'utf8'), readFileSync(paths.packageJson, 'utf8')]

    const second = patchBalancePackage(root)
    assert.equal(second.status, 'already-patched')
    assert.deepEqual(second.changedFiles, [])
    assert.deepEqual(
      [readFileSync(paths.source, 'utf8'), readFileSync(paths.lib, 'utf8'), readFileSync(paths.packageJson, 'utf8')],
      after,
    )

    const manifest = JSON.parse(after[2])
    manifest.version = PREVIOUS_VERSION
    writeFileSync(paths.packageJson, `${JSON.stringify(manifest, null, 2)}\n`)
    const resume = patchBalancePackage(root)
    assert.equal(resume.status, 'version-only')
    assert.deepEqual(resume.changedFiles, ['package.json'])
    assert.equal(JSON.parse(readFileSync(paths.packageJson, 'utf8')).version, TARGET_VERSION)
    assert.equal(readFileSync(paths.source, 'utf8'), after[0])
    assert.equal(readFileSync(paths.lib, 'utf8'), after[1])
  })
})

test('patch refuses unexpected packages, versions and anchors without partial writes', () => {
  withTempDir((root) => {
    const paths = createPackageFixture(root, { name: 'not-the-balance-plugin' })
    const before = readFileSync(paths.source, 'utf8')
    assert.throws(() => patchBalancePackage(root), PatchRefusedError)
    assert.equal(readFileSync(paths.source, 'utf8'), before)
  })

  withTempDir((root) => {
    const paths = createPackageFixture(root, { version: '9.9.9' })
    const before = [readFileSync(paths.source, 'utf8'), readFileSync(paths.packageJson, 'utf8')]
    assert.throws(() => patchBalancePackage(root), /unexpected version/)
    assert.deepEqual([readFileSync(paths.source, 'utf8'), readFileSync(paths.packageJson, 'utf8')], before)
  })

  withTempDir((root) => {
    const paths = createPackageFixture(root)
    rmSync(paths.lib)
    assert.throws(() => patchBalancePackage(root), /missing lib\/client\.js/)
    assert.equal(JSON.parse(readFileSync(paths.packageJson, 'utf8')).version, PREVIOUS_VERSION)
  })

  // A diverged (already hand-edited) compiled client must be refused before anything is written,
  // including the source file that would have matched on its own.
  withTempDir((root) => {
    const paths = createPackageFixture(root)
    const diverged = readFileSync(paths.lib, 'utf8').replace(
      'const execution = await ctx.remote.commands.execute(sid, line);',
      'const execution = await ctx.remote.commands.execute(sid, line, []);',
    )
    writeFileSync(paths.lib, diverged)
    const sourceBefore = readFileSync(paths.source, 'utf8')
    assert.throws(() => patchBalancePackage(root), /anchor match/)
    assert.equal(readFileSync(paths.lib, 'utf8'), diverged)
    assert.equal(readFileSync(paths.source, 'utf8'), sourceBefore)
    assert.equal(JSON.parse(readFileSync(paths.packageJson, 'utf8')).version, PREVIOUS_VERSION)
    assert.equal(existsSync(`${paths.source}.dsh-balance-patch.tmp`), false)
    assert.equal(existsSync(`${paths.lib}.dsh-balance-patch.tmp`), false)
  })

  withTempDir((root) => {
    const paths = createPackageFixture(root)
    writeFileSync(paths.source, `${PATCH_MARKER}\n${readFileSync(paths.source, 'utf8')}`)
    const libBefore = readFileSync(paths.lib, 'utf8')
    assert.throws(() => patchBalancePackage(root), /inconsistent patch state/)
    assert.equal(readFileSync(paths.lib, 'utf8'), libBefore)
  })

  withTempDir((root) => {
    const paths = createPackageFixture(root, { version: TARGET_VERSION })
    const before = readFileSync(paths.source, 'utf8')
    assert.throws(() => patchBalancePackage(root), /unpatched/)
    assert.equal(readFileSync(paths.source, 'utf8'), before)
  })
})

// ─── behaviour of the patched compiled runCommand ──────────────────────────

test('patched runCommand requires a session, forwards attachments and fails safe', async () => {
  const libSource = patchedLibSource()
  const calls = []
  let respond = async () => ({ ok: true, value: { result: { text: JSON.stringify({ ok: true, data: { is_available: true } }) } } })
  const runCommand = buildRunCommand(libSource, async (...args) => {
    calls.push(args)
    return respond(...args)
  })

  assert.deepEqual(await runCommand(undefined, '/dsh-balance refresh'), { ok: false, error: 'no-session' })
  assert.deepEqual(await runCommand('', '/dsh-balance refresh'), { ok: false, error: 'no-session' })
  assert.equal(calls.length, 0, 'a missing session must not reach the transport')

  const success = await runCommand('session-1', '/dsh-balance refresh')
  assert.deepEqual(calls.at(-1), ['session-1', '/dsh-balance refresh', []])
  assert.deepEqual(success, { ok: true, data: { is_available: true } }, 'existing success payloads stay unchanged')

  respond = async () => ({ ok: false, error: 'REMOTE-SECRET-TEXT' })
  assert.deepEqual(await runCommand('session-1', '/x'), { ok: false, error: 'envelope' })

  respond = async () => ({ ok: true, value: {} })
  assert.deepEqual(await runCommand('session-1', '/x'), { ok: false, error: 'envelope' })

  respond = async () => ({ ok: true, value: { result: { text: '' } } })
  assert.deepEqual(await runCommand('session-1', '/x'), { ok: false, error: 'envelope' })

  respond = async () => ({ ok: true, value: { result: { text: 'not json' } } })
  assert.deepEqual(await runCommand('session-1', '/x'), { ok: false, error: 'payload' })

  respond = async () => ({ ok: true, value: { result: { text: '[]' } } })
  assert.deepEqual(await runCommand('session-1', '/x'), { ok: false, error: 'payload' })

  respond = async () => ({ ok: true, value: { result: { text: '{"ok":"yes"}' } } })
  assert.deepEqual(await runCommand('session-1', '/x'), { ok: false, error: 'payload' })

  respond = async () => { throw new Error('REMOTE-SECRET-TEXT') }
  const thrown = await runCommand('session-1', '/x')
  assert.deepEqual(thrown, { ok: false, error: 'request' })
  assert.equal(JSON.stringify(thrown).includes('REMOTE-SECRET-TEXT'), false, 'thrown text must never be echoed')

  const failures = JSON.stringify([
    await runCommand('session-1', '/x'),
    await runCommand(undefined, '/x'),
  ])
  assert.equal(failures.includes('REMOTE-SECRET-TEXT'), false)
  assert.equal(calls.every((args) => args.length === 3 && Array.isArray(args[2]) && args[2].length === 0), true)
})

// ─── rendered failure UI ───────────────────────────────────────────────────

function assertFailureUiRetries(libSource) {
  const remoteText = 'REMOTE-SECRET-TEXT: quota exceeded for account 12345'
  const loaded = loadClientModule(libSource, async () => ({
    ok: true,
    value: { result: { text: JSON.stringify({ ok: false, error: remoteText }) } },
  }))
  const section = loaded.registrations.get('settings.section')
  assert.ok(section !== undefined, 'the settings section must stay registered')
  try {
    return renderToSettled(section({ useSessions: (select) => select({ current: 'session-1' }) }), loaded.react)
      .then((tree) => {
        const text = collectText(tree).join(' | ')
        assert.equal(text.includes(remoteText), false, 'arbitrary remote text must never be rendered')
        assert.equal(text.includes('REMOTE-SECRET-TEXT'), false)
        assert.match(text, /余额查询失败/, 'the failed result must render fixed localized copy')
        const retry = collectButtons(tree).find((button) => collectText(button).join('') === '点击重试')
        assert.ok(retry !== undefined, 'a failed result must render a manual retry button')
        assert.deepEqual(loaded.calls.at(-1), ['session-1', '/dsh-balance refresh', []])
        const before = loaded.calls.length
        retry.props.onClick()
        assert.equal(loaded.calls.length, before + 1, 'the retry button must issue a new balance request')
        return loaded
      })
      .finally(() => loaded.react.dispose())
  } catch (error) {
    loaded.react.dispose()
    throw error
  }
}

test('failed balance result renders a localized retry button and never echoes remote text', async () => {
  await assertFailureUiRetries(patchedLibSource())
})

test('patched header chip shows the localized failure instead of a permanent loading tooltip', async () => {
  const libSource = patchedLibSource()
  const loaded = loadClientModule(libSource, async () => ({
    ok: true,
    value: { result: { text: JSON.stringify({ ok: false, error: 'REMOTE-SECRET-TEXT' }) } },
  }))
  const chip = loaded.registrations.get('conversation.session.header.utilities')
  assert.ok(chip !== undefined, 'the fixture registers the header chip')
  try {
    const tree = await renderToSettled(chip({ sessionId: 'session-1' }), loaded.react)
    const line = collectText(tree).join('\n')
    assert.match(line, /余额查询失败/, 'the chip tooltip must state the failure, not stay on "loading"')
    assert.equal(line.includes('REMOTE-SECRET-TEXT'), false)
    assert.equal(line.includes('查询中'), false)
  } finally {
    loaded.react.dispose()
  }
})

// ─── actual local compat package (skipped when the fixture is absent) ──────

test('the actual .local/dsh-balance-compat package patches cleanly on a copy', {
  skip: existsSync(REAL_PACKAGE_DIR) ? false : 'no .local/dsh-balance-compat fixture in this checkout',
}, async () => {
  const originalManifest = JSON.parse(readFileSync(join(REAL_PACKAGE_DIR, 'package.json'), 'utf8'))
  const originalSource = readFileSync(join(REAL_PACKAGE_DIR, SOURCE_FILE), 'utf8')
  assert.equal(originalManifest.name, PACKAGE_NAME)

  await withTempDir(async (root) => {
    const copy = join(root, 'dsh-balance-compat')
    cpSync(REAL_PACKAGE_DIR, copy, { recursive: true })
    const result = patchBalancePackage(copy)
    assert.ok(['patched', 'already-patched'].includes(result.status), `unexpected patch status ${result.status}`)

    assert.equal(JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).version, TARGET_VERSION)
    assert.equal(existsSync(join(copy, 'lib', 'client.js.map')), true)
    assert.equal(readFileSync(join(copy, LIB_FILE), 'utf8').includes('sourceMappingURL'), false)
    // The shared fixture itself must stay untouched: the test only ever patches a copy.
    assert.equal(readFileSync(join(REAL_PACKAGE_DIR, SOURCE_FILE), 'utf8'), originalSource)
    assert.equal(JSON.parse(readFileSync(join(REAL_PACKAGE_DIR, 'package.json'), 'utf8')).version, originalManifest.version)

    const libSource = readFileSync(join(copy, LIB_FILE), 'utf8')
    const calls = []
    const runCommand = buildRunCommand(libSource, async (...args) => {
      calls.push(args)
      return { ok: true, value: { result: { text: JSON.stringify({ ok: true, data: { is_available: false } }) } } }
    })
    assert.deepEqual(await runCommand(undefined, '/dsh-balance refresh'), { ok: false, error: 'no-session' })
    assert.equal(calls.length, 0)
    assert.deepEqual(await runCommand('session-1', '/dsh-balance refresh'), { ok: true, data: { is_available: false } })
    assert.deepEqual(calls.at(-1), ['session-1', '/dsh-balance refresh', []])

    if (result.status === 'patched') {
      await assertFailureUiRetries(libSource)
    }
  })
})


test('temporary replacement locks retry finitely without deleting the destination', () => {
  let attempts = 0; const waits = [];
  replaceStagedFile('staged', 'destination', (source, target) => {
    assert.equal(source, 'staged'); assert.equal(target, 'destination');
    if (++attempts < 3) throw Object.assign(new Error('temporary lock'), { code: 'EPERM' });
  }, ms => waits.push(ms));
  assert.equal(attempts, 3); assert.deepEqual(waits, [25, 50]);
  attempts = 0;
  assert.throws(() => replaceStagedFile('s', 't', () => {
    attempts++; throw Object.assign(new Error('permanent lock'), {code: 'EBUSY'});
  }, () => {}), /permanent lock/);
  assert.equal(attempts, 6);
  attempts = 0;
  assert.throws(() => replaceStagedFile('s', 't', () => {
    attempts++; throw Object.assign(new Error('disk failure'), {code: 'EIO'});
  }, () => assert.fail('unrelated errors must not retry')), /disk failure/);
  assert.equal(attempts, 1);
});

test('an already marked package with a removed required RPC fix is refused unchanged', () => {
  withTempDir(root => {
    const paths = createPackageFixture(root); patchBalancePackage(root);
    const broken = readFileSync(paths.lib, 'utf8').replace('commands.execute(sid, line, [])', 'commands.execute(sid, line)');
    writeFileSync(paths.lib, broken);
    assert.throws(() => patchBalancePackage(root), PatchRefusedError);
    assert.equal(readFileSync(paths.lib, 'utf8'), broken);
    assert.equal(JSON.parse(readFileSync(paths.packageJson, 'utf8')).version, TARGET_VERSION);
  });
});
