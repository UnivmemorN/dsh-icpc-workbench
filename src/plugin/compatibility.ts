/**
 * Host compatibility gate (Stage 4h0).
 *
 * The plugin is pinned to one tested dsh baseline and refuses to activate on anything else: a
 * different Node.js line, a launcher that is not `@deepseek-ai/dsh`, a dsh version other than
 * `0.1.5-rc.2`, or a host that does not expose every public service the pipeline needs. There is
 * deliberately no configuration switch that bypasses these checks — a mismatch is either fixed by
 * installing the pinned baseline or by shipping a new plugin build, never by loosening the gate at
 * runtime.
 *
 * The launcher path is resolved through symlinks and then the *nearest* ancestor `package.json`
 * decides the identity: a foreign package closest to the launcher fails immediately instead of
 * walking further up until some dsh-named package is found. When the validated CLI lives inside
 * the dsh source checkout, the exact `@deepseek-ai/dsh-root` ancestor marker is detected through a
 * bounded ascent and its directory becomes the installation root, so the data-separation rule
 * covers the whole checkout rather than only `apps/cli`. That marker must also be `private: true`
 * and carry the same pinned version as the validated CLI; a partial upgrade is refused instead of
 * silently widening the root. The CLI manifest remains the version authority.
 *
 * This module only reads manifests. It never creates a database or a directory, never writes a
 * manifest, and never changes a host version.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { isMissingPathError, type PathKind } from './config.js';

/** Package name of the tested dsh CLI. */
export const BASELINE_DSH_PACKAGE = '@deepseek-ai/dsh';
/** Exact dsh version this build is pinned to. */
export const BASELINE_DSH_VERSION = '0.1.5-rc.2';
/** Optional ancestor marker of the dsh source checkout (`private: true` at the repository root). */
export const BASELINE_DSH_ROOT_PACKAGE = '@deepseek-ai/dsh-root';
/** Smallest supported minor on the Node.js 22 line. */
export const MIN_NODE_22_MINOR = 19;
/** Human-readable Node.js range, used verbatim in refusals. */
export const SUPPORTED_NODE_TEXT =
  'Node.js 22.19 or newer on the 22.x line, or 24.x and newer (the 23.x line is not supported)';
/** How many ancestor levels are inspected for the optional source-checkout marker. */
export const MAX_ANCESTOR_DEPTH = 12;

/**
 * Public host functions this plugin calls.
 *
 * Every entry is part of the pinned baseline's public API; the list is verified before activation
 * and returned so a caller can record exactly what was checked.
 */
export const REQUIRED_HOST_API = [
  'connection.fetch.register',
  'llm.stream',
  'llm.listProviders',
  'llm.listModels',
  'llm.resolveModelInfo',
  'sessions.prepare',
  'sessionPersistence.create',
] as const;

/** One verified host API path. */
export type RequiredHostApi = (typeof REQUIRED_HOST_API)[number];

/** Stable failure codes of the compatibility gate. */
export type CompatibilityErrorCode =
  | 'unsupported_node'
  | 'missing_launcher'
  | 'invalid_launcher_package'
  | 'unknown_launcher'
  | 'unsupported_host_version'
  | 'incomplete_host_api';

/** Compatibility refusal; `code` is stable so callers never match on message text. */
export class CompatibilityError extends Error {
  readonly code: CompatibilityErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CompatibilityErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'CompatibilityError';
    this.code = code;
    this.details = details;
  }
}

/** Read-only filesystem probe; injected in tests, never used to create anything. */
export interface HostCompatibilityProbe {
  /** Kind of the entry at `path`; `missing` when nothing exists there. */
  readonly stat: (path: string) => PathKind;
  /** Canonical path of an existing entry. */
  readonly realpath: (path: string) => string;
  /** Text content of an existing file. */
  readonly readFile: (path: string) => string;
}

/** What the gate inspects. */
export interface HostCompatibilityRequest {
  /** Node.js version as reported by `process.version` (a leading `v` is accepted). */
  readonly nodeVersion: string;
  /** Path of the running dsh launcher: its entry file or its package directory. */
  readonly launcherPath: string;
  /** The mounted host services (`ctx` or a structural equivalent). */
  readonly services: unknown;
}

/** Result of a successful gate: the pinned baseline plus what was verified. */
export interface HostCompatibility {
  /** The accepted Node.js version, trimmed exactly as supplied. */
  readonly nodeVersion: string;
  /** Canonical path of the launcher that was inspected. */
  readonly launcherPath: string;
  /** Directory of the validated `@deepseek-ai/dsh` package manifest. */
  readonly launcherRoot: string;
  /**
   * Directory whose subtree must stay free of training data: the source-checkout root when the
   * optional marker is present, otherwise {@link launcherRoot}.
   */
  readonly installationRoot: string;
  /** Validated package name; always {@link BASELINE_DSH_PACKAGE}. */
  readonly packageName: string;
  /** Validated package version; always {@link BASELINE_DSH_VERSION}. */
  readonly packageVersion: string;
  /** Every host API path that was verified as a public function. */
  readonly hostApi: readonly RequiredHostApi[];
}

/** Real filesystem probe; reports only genuinely absent paths as `missing` and never writes. */
export function defaultHostProbe(): HostCompatibilityProbe {
  return {
    stat(path): PathKind {
      try {
        const info = statSync(path);
        return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
      } catch (error) {
        // Only "nothing is here" continues a walk. A path the process may not inspect
        // (EACCES/EPERM/EIO) must surface as a typed refusal, because a package that cannot be
        // read cannot be proven to be the wrong one.
        if (isMissingPathError(error)) {
          return 'missing';
        }
        throw error;
      }
    },
    realpath(path) {
      return realpathSync(path);
    },
    readFile(path) {
      return readFileSync(path, 'utf8');
    },
  };
}

/**
 * Validate the running host against the pinned baseline.
 *
 * Order: Node.js line, launcher identity and exact version, then the required public services. The
 * first failure is thrown as a {@link CompatibilityError}; nothing is created and nothing is
 * modified on any path.
 */
export async function checkHostCompatibility(
  request: HostCompatibilityRequest,
  probe: HostCompatibilityProbe = defaultHostProbe(),
): Promise<HostCompatibility> {
  const nodeVersion = requireSupportedNode(request.nodeVersion);
  const launcher = resolveLauncher(request.launcherPath, probe);
  const nearest = nearestPackageManifest(launcher.directory, probe);
  if (nearest === null) {
    throw new CompatibilityError(
      'missing_launcher',
      `no package.json was found at or above the dsh launcher ${launcher.path}; install the pinned baseline with "npm install -g ${BASELINE_DSH_PACKAGE}@${BASELINE_DSH_VERSION}" and start dsh from that installation`,
      { launcherPath: launcher.path },
    );
  }
  if (nearest.manifest.name !== BASELINE_DSH_PACKAGE) {
    throw new CompatibilityError(
      'unknown_launcher',
      `the package nearest to the launcher ${launcher.path} is ${describePackage(nearest.manifest)}, not "${BASELINE_DSH_PACKAGE}"; install the pinned baseline with "npm install -g ${BASELINE_DSH_PACKAGE}@${BASELINE_DSH_VERSION}" and start dsh from that installation`,
      { launcherPath: launcher.path, packageDirectory: nearest.directory, packageName: nearest.manifest.name },
    );
  }
  if (nearest.manifest.version !== BASELINE_DSH_VERSION) {
    throw new CompatibilityError(
      'unsupported_host_version',
      `dsh-icpc-workbench is pinned to ${BASELINE_DSH_PACKAGE}@${BASELINE_DSH_VERSION} but the launcher package is version "${nearest.manifest.version ?? 'unknown'}"; install the pinned baseline with "npm install -g ${BASELINE_DSH_PACKAGE}@${BASELINE_DSH_VERSION}" or update the plugin`,
      { packageDirectory: nearest.directory, packageVersion: nearest.manifest.version },
    );
  }
  const installationRoot = findInstallationRoot(nearest.directory, probe) ?? nearest.directory;
  const hostApi = verifyHostApi(request.services);
  return {
    nodeVersion,
    launcherPath: launcher.path,
    launcherRoot: nearest.directory,
    installationRoot,
    packageName: BASELINE_DSH_PACKAGE,
    packageVersion: BASELINE_DSH_VERSION,
    hostApi,
  };
}

/** One parsed package manifest; missing fields stay `null` instead of being invented. */
interface PackageManifest {
  readonly name: string | null;
  readonly version: string | null;
  readonly private: boolean;
}

/** Canonical launcher path plus the directory the identity walk starts from. */
interface ResolvedLauncher {
  readonly path: string;
  readonly directory: string;
}

/** Resolve the launcher through symlinks and pick the directory a package.json search starts at. */
function resolveLauncher(launcherPath: string, probe: HostCompatibilityProbe): ResolvedLauncher {
  if (typeof launcherPath !== 'string' || launcherPath.trim().length === 0) {
    throw new CompatibilityError('missing_launcher', 'the dsh launcher path was not supplied; start dsh from the pinned installation');
  }
  let real: string;
  try {
    real = probe.realpath(resolvePath(launcherPath));
  } catch (error) {
    throw new CompatibilityError(
      'missing_launcher',
      `the dsh launcher ${launcherPath} could not be resolved (${errorText(error)}); install the pinned baseline with "npm install -g ${BASELINE_DSH_PACKAGE}@${BASELINE_DSH_VERSION}" and start dsh from that installation`,
      { launcherPath, cause: errorText(error) },
    );
  }
  let kind: PathKind;
  try {
    kind = probe.stat(real);
  } catch (error) {
    throw new CompatibilityError('missing_launcher', `the dsh launcher ${real} could not be inspected: ${errorText(error)}`, {
      launcherPath: real,
    });
  }
  if (kind === 'missing') {
    throw new CompatibilityError('missing_launcher', `the dsh launcher ${real} does not exist`, { launcherPath: real });
  }
  return { path: real, directory: kind === 'directory' ? real : dirname(real) };
}

/**
 * Nearest ancestor package manifest, stopping at the first one found.
 *
 * A foreign package closest to the launcher is *the* answer: the walk never continues past it in
 * search of a dsh-named package.
 */
function nearestPackageManifest(
  startDirectory: string,
  probe: HostCompatibilityProbe,
): { readonly directory: string; readonly manifest: PackageManifest } | null {
  let directory = startDirectory;
  for (;;) {
    const manifest = readPackageManifest(directory, probe);
    if (manifest !== null) {
      return { directory, manifest };
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/**
 * Optional source-checkout marker above the validated CLI package.
 *
 * The ascent is bounded and only the exact marker (`@deepseek-ai/dsh-root`, `private: true`, the
 * same pinned version as the validated CLI) is accepted. A recognized marker with any other
 * version is a partial upgrade: it is refused as `unsupported_host_version` instead of widening
 * the installation root to a tree that does not match the baseline the CLI manifest declared. A
 * normal installed CLI package has no such ancestor and keeps its own directory as the root.
 */
function findInstallationRoot(cliDirectory: string, probe: HostCompatibilityProbe): string | null {
  let directory = dirname(cliDirectory);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const manifest = readPackageManifest(directory, probe);
    if (manifest !== null && manifest.name === BASELINE_DSH_ROOT_PACKAGE) {
      if (!manifest.private || manifest.version !== BASELINE_DSH_VERSION) {
        throw new CompatibilityError(
          'unsupported_host_version',
          `the source-checkout marker ${join(directory, 'package.json')} is not the pinned baseline: it declares "${manifest.name}" version "${manifest.version ?? 'unknown'}"${manifest.private ? '' : ' without private: true'}, while the validated CLI expects "${BASELINE_DSH_ROOT_PACKAGE}" private: true version ${BASELINE_DSH_VERSION}; the checkout looks partially upgraded — install ${BASELINE_DSH_PACKAGE}@${BASELINE_DSH_VERSION} or update the plugin`,
          { packageDirectory: directory, packageVersion: manifest.version, private: manifest.private },
        );
      }
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
  return null;
}

/** Read one package manifest, or `null` when the directory has none. */
function readPackageManifest(directory: string, probe: HostCompatibilityProbe): PackageManifest | null {
  const file = join(directory, 'package.json');
  let kind: PathKind;
  try {
    kind = probe.stat(file);
  } catch (error) {
    throw new CompatibilityError('invalid_launcher_package', `${file} could not be inspected: ${errorText(error)}`, { file });
  }
  if (kind === 'missing') {
    return null;
  }
  if (kind !== 'file') {
    throw new CompatibilityError('invalid_launcher_package', `${file} exists but is not a file`, { file });
  }
  let text: string;
  try {
    text = probe.readFile(file);
  } catch (error) {
    throw new CompatibilityError('invalid_launcher_package', `${file} could not be read: ${errorText(error)}`, { file });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CompatibilityError(
      'invalid_launcher_package',
      `${file} is not valid JSON; the pinned dsh installation is damaged — reinstall ${BASELINE_DSH_PACKAGE}@${BASELINE_DSH_VERSION}`,
      { file },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CompatibilityError('invalid_launcher_package', `${file} must contain a JSON object`, { file });
  }
  const record = parsed as Record<string, unknown>;
  return {
    name: typeof record['name'] === 'string' ? record['name'] : null,
    version: typeof record['version'] === 'string' ? record['version'] : null,
    private: record['private'] === true,
  };
}

/** Accept only the Node.js lines the pinned baseline supports. */
function requireSupportedNode(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new CompatibilityError('unsupported_node', `the Node.js version was not supplied; ${SUPPORTED_NODE_TEXT} is required`);
  }
  const text = raw.trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text);
  if (match === null) {
    throw new CompatibilityError(
      'unsupported_node',
      `the Node.js version "${text}" was not recognized; dsh-icpc-workbench requires ${SUPPORTED_NODE_TEXT}`,
      { nodeVersion: text },
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported = major === 22 ? minor >= MIN_NODE_22_MINOR : major >= 24;
  if (!supported) {
    throw new CompatibilityError(
      'unsupported_node',
      `dsh-icpc-workbench requires ${SUPPORTED_NODE_TEXT}; this host is running Node.js ${text}. Install a supported Node.js release and start dsh again.`,
      { nodeVersion: text, major, minor },
    );
  }
  return text;
}

/** Verify every required public host function and report all missing ones at once. */
function verifyHostApi(services: unknown): readonly RequiredHostApi[] {
  const missing = REQUIRED_HOST_API.filter((path) => !hasFunctionAt(services, path));
  if (missing.length > 0) {
    throw new CompatibilityError(
      'incomplete_host_api',
      `the mounted dsh host does not expose ${missing.join(', ')}; this plugin needs the public ${BASELINE_DSH_PACKAGE}@${BASELINE_DSH_VERSION} API (connection.fetch.register, llm.stream, llm.listProviders, llm.listModels, llm.resolveModelInfo, sessions.prepare, sessionPersistence.create). Install the pinned baseline or update the plugin.`,
      { missing },
    );
  }
  return [...REQUIRED_HOST_API];
}

/** True when `path` names a function reachable from `root`; a throwing getter counts as absent. */
function hasFunctionAt(root: unknown, path: string): boolean {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      return false;
    }
    try {
      current = (current as Record<string, unknown>)[segment];
    } catch {
      // A getter that refuses to answer cannot be called either, so the capability is absent.
      return false;
    }
  }
  return typeof current === 'function';
}

function describePackage(manifest: PackageManifest): string {
  return `"${manifest.name ?? 'unknown'}"${manifest.version === null ? '' : `@${manifest.version}`}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : `thrown ${typeof error}`;
}
