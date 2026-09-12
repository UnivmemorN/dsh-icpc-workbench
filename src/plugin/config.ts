/**
 * Plugin configuration and the independent training-data directory.
 *
 * The plugin owns exactly one filesystem location — the directory that holds its SQLite database —
 * and that location must be independent of the harness installation and of the host's `dshHome`:
 * installing, moving or removing the plugin never touches either tree. `dataDir` is optional; when
 * it is omitted the operating system's per-user data location is used, and no other environment
 * variable is ever read. No credential, token or endpoint can be expressed by this configuration.
 *
 * The path is canonicalized *before* any caller writes to it: the nearest existing ancestor is
 * resolved through symlinks and the remaining segments are appended unchanged, so a link that
 * points into the harness tree cannot disguise itself. This module only inspects the filesystem —
 * it never creates a directory (the storage adapter creates the database when it opens it).
 *
 * The plugin's own `.local/state` directory is an ordinary absolute path: the acceptance profile
 * may point `dataDir` there, and it is accepted as long as it stays outside the harness
 * installation and outside `dshHome`.
 */
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Per-user data directory name below the operating system's own data location. */
export const PRODUCT_DATA_DIR_NAME = 'dsh-icpc-workbench';

/** What one filesystem probe reports for a path. */
export type PathKind = 'directory' | 'file' | 'other' | 'missing';

/** Filesystem probe; the real implementation reads, it never writes or creates. */
export interface ConfigFileSystem {
  /** Kind of the entry at `path`; `missing` when nothing exists there. */
  readonly stat: (path: string) => PathKind;
  /** Canonical path of an existing entry; only called after `stat` reported an existing directory. */
  readonly realpath: (path: string) => string;
}

/** Everything this module reads from the process environment; injected in tests. */
export interface ConfigEnvironment {
  readonly platform: NodeJS.Platform;
  /** Read-only view of the environment; only `LOCALAPPDATA` and `XDG_DATA_HOME` are consulted. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Operating-system home directory, used by the macOS/Linux defaults. */
  readonly home: string;
}

/** Validated plugin configuration. */
export interface PluginConfig {
  /** Absolute directory holding the plugin's own database; the OS default when omitted. */
  readonly dataDir?: string;
}

/** Stable failure codes of configuration validation. */
export type ConfigErrorCode =
  | 'invalid_config'
  | 'invalid_data_dir'
  | 'data_dir_conflict'
  | 'missing_environment'
  | 'unresolvable_data_dir';

/** Configuration failure; `code` is stable so callers never match on message text. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ConfigErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.details = details;
  }
}

/** Context of {@link resolveDataDir}; every field exists for tests and for the later composition. */
export interface DataDirContext {
  /** Defaults to the running process. */
  readonly environment?: ConfigEnvironment;
  /** Absolute `dshHome` disclosed by the host; `null`/omitted when the host did not provide one. */
  readonly dshHome?: string | null;
  /** Installation root returned by the compatibility gate; `null`/omitted when it is unknown. */
  readonly installationRoot?: string | null;
  /** Test seam: filesystem probe; defaults to the real filesystem. */
  readonly fileSystem?: ConfigFileSystem;
}

/** The real filesystem probe; reports `missing` for every error instead of creating anything. */
const realFileSystem: ConfigFileSystem = {
  stat(path) {
    try {
      const info = statSync(path);
      return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    } catch (error) {
      // Only "nothing is there" may continue the ancestor walk. An unreadable ancestor
      // (EACCES/EPERM/EIO) must be refused by the caller instead of being walked past, because a
      // path the process cannot inspect is a path it cannot prove is outside the guarded trees.
      if (isMissingPathError(error)) {
        return 'missing';
      }
      throw error;
    }
  },
  realpath(path) {
    // Match fs.promises.realpath used by the backup boundary: Windows native resolution
    // expands 8.3 aliases (e.g. RUNNER~1) that the JavaScript walker can preserve.
    return realpathSync.native(path);
  },
};

/** The real probe, for tests and for callers that need the shared implementation. */
export function defaultConfigFileSystem(): ConfigFileSystem {
  return realFileSystem;
}

/**
 * True for the two errno values that mean "this entry does not exist here".
 *
 * `ENOENT` is absent; `ENOTDIR` means an ancestor component is a file, which the segment-by-segment
 * walk encounters and refuses one level higher. Every other errno (permission, IO, ...) is a real
 * failure that must surface as a typed refusal instead of a `missing` path.
 */
export function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Environment of the running process; the only environment reader in this module. */
export function processConfigEnvironment(): ConfigEnvironment {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/**
 * Default per-user data directory for one environment.
 *
 * Windows: `%LOCALAPPDATA%\dsh-icpc-workbench`. macOS:
 * `~/Library/Application Support/dsh-icpc-workbench`. Everywhere else:
 * `$XDG_DATA_HOME/dsh-icpc-workbench`, or `~/.local/share/dsh-icpc-workbench` when the variable is
 * unset. A missing variable that the default depends on is an explicit `missing_environment`
 * failure instead of a silently guessed path.
 */
export function defaultDataDir(environment: ConfigEnvironment): string {
  if (environment.platform === 'win32') {
    const localAppData = nonEmpty(environment.env['LOCALAPPDATA']);
    if (localAppData === null) {
      throw new ConfigError(
        'missing_environment',
        'LOCALAPPDATA is not set, so the default training data directory cannot be located; set dataDir explicitly in the plugin configuration',
      );
    }
    return join(localAppData, PRODUCT_DATA_DIR_NAME);
  }
  const home = nonEmpty(environment.home);
  if (home === null) {
    throw new ConfigError(
      'missing_environment',
      'the operating-system home directory could not be determined; set dataDir explicitly in the plugin configuration',
    );
  }
  if (environment.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', PRODUCT_DATA_DIR_NAME);
  }
  const xdgDataHome = nonEmpty(environment.env['XDG_DATA_HOME']);
  return xdgDataHome === null
    ? join(home, '.local', 'share', PRODUCT_DATA_DIR_NAME)
    : join(xdgDataHome, PRODUCT_DATA_DIR_NAME);
}

/**
 * Validate the raw plugin configuration.
 *
 * Exactly one optional key is accepted: `dataDir`, a non-empty absolute path. `undefined` (no
 * configuration supplied) is the empty configuration; `null`, arrays, class instances, unknown
 * keys and non-string values are rejected. The path is not touched here — {@link resolveDataDir}
 * canonicalizes and confines it.
 */
export function parsePluginConfig(input: unknown): PluginConfig {
  if (input === undefined) {
    return {};
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError(
      'invalid_config',
      `the plugin configuration must be a plain object (received ${describeValue(input)})`,
      { received: describeValue(input) },
    );
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConfigError('invalid_config', 'the plugin configuration must be a plain object, not a class instance');
  }
  const record = input as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== 'dataDir');
  if (unknownKeys.length > 0) {
    throw new ConfigError('invalid_config', `the plugin configuration has unknown keys: ${unknownKeys.join(', ')}`, {
      unknownKeys,
    });
  }
  const dataDir = record['dataDir'];
  if (dataDir === undefined) {
    return {};
  }
  if (typeof dataDir !== 'string') {
    throw new ConfigError('invalid_config', 'dataDir must be a string absolute path', { received: describeValue(dataDir) });
  }
  if (dataDir.trim().length === 0) {
    throw new ConfigError('invalid_data_dir', 'dataDir must not be empty');
  }
  if (dataDir.includes('\0')) {
    throw new ConfigError('invalid_data_dir', 'dataDir must not contain a NUL character');
  }
  if (!isAbsolute(dataDir)) {
    throw new ConfigError('invalid_data_dir', `dataDir must be an absolute path (received ${JSON.stringify(dataDir)})`);
  }
  return { dataDir };
}

/**
 * Resolve the training data directory that the store may later create.
 *
 * The configured path (or the OS default) is canonicalized through the nearest existing ancestor
 * and then confined: a path equal to or below the harness installation root or `dshHome` is a
 * `data_dir_conflict`. Sibling names that merely share a prefix (`harness2` next to `harness`)
 * are unrelated directories, not conflicts. Nothing is created here.
 */
export function resolveDataDir(config: PluginConfig, context: DataDirContext = {}): string {
  const environment = context.environment ?? processConfigEnvironment();
  const fileSystem = context.fileSystem ?? realFileSystem;
  const target = config.dataDir ?? defaultDataDir(environment);
  if (typeof target !== 'string' || target.trim().length === 0 || target.includes('\0')) {
    throw new ConfigError('invalid_data_dir', 'the training data directory must be a non-empty path string');
  }
  if (!isAbsolute(target)) {
    throw new ConfigError('invalid_data_dir', `the training data directory must be absolute (received ${JSON.stringify(target)})`);
  }
  const realized = realpathNearestAncestor(resolve(target), fileSystem, 'invalid_data_dir');
  for (const [label, guard] of guardedRoots(context)) {
    const guardReal = realpathNearestAncestor(resolve(guard), fileSystem, 'unresolvable_data_dir');
    if (isWithin(realized, guardReal, environment.platform === 'win32')) {
      throw new ConfigError(
        'data_dir_conflict',
        `the training data directory ${realized} is inside ${label} (${guardReal}); choose a directory outside the dsh installation and outside dshHome`,
        { dataDir: realized, guard: guardReal, guardKind: label },
      );
    }
  }
  return realized;
}

/** Guards that the data directory must stay out of, in the order their failures are reported. */
function guardedRoots(context: DataDirContext): readonly (readonly [string, string])[] {
  const roots: (readonly [string, string])[] = [];
  const installationRoot = nonEmpty(context.installationRoot ?? null);
  if (installationRoot !== null) {
    roots.push(['the dsh installation', installationRoot]);
  }
  const dshHome = nonEmpty(context.dshHome ?? null);
  if (dshHome !== null) {
    roots.push(['the dsh home directory', dshHome]);
  }
  return roots;
}

/**
 * Canonical form of `target`, resolving symlinks through its nearest existing ancestor.
 *
 * The ancestor is realpath-resolved and the not-yet-existing trailing segments are appended
 * unchanged, which is the canonical path a later `mkdir -p` would create. A path component that
 * exists as a file cannot become a directory, so it is refused instead of being treated as a
 * missing segment.
 */
function realpathNearestAncestor(target: string, fileSystem: ConfigFileSystem, failureCode: ConfigErrorCode): string {
  const remaining: string[] = [];
  let current = target;
  for (;;) {
    let kind: PathKind;
    try {
      kind = fileSystem.stat(current);
    } catch (error) {
      throw new ConfigError(failureCode, `the path ${current} could not be inspected: ${errorText(error)}`, {
        path: current,
      });
    }
    if (kind !== 'missing') {
      if (kind !== 'directory') {
        throw new ConfigError('invalid_data_dir', `${current} exists but is not a directory`, { path: current });
      }
      let resolved: string;
      try {
        resolved = fileSystem.realpath(current);
      } catch (error) {
        throw new ConfigError(failureCode, `the real path of ${current} could not be resolved: ${errorText(error)}`, {
          path: current,
        });
      }
      return remaining.length === 0 ? resolved : join(resolved, ...remaining.reverse());
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new ConfigError(failureCode, `no existing ancestor of ${target} could be found`, { target });
    }
    remaining.push(basename(current));
    current = parent;
  }
}

/** True when `candidate` is `root` itself or lives below it, compared segment by segment. */
function isWithin(candidate: string, root: string, caseInsensitive: boolean): boolean {
  const left = caseInsensitive ? candidate.toLowerCase() : candidate;
  const right = caseInsensitive ? root.toLowerCase() : root;
  if (left === right) {
    return true;
  }
  const rest = relative(right, left);
  // `..training` is a legitimate child name (Windows and Linux both allow it); only the exact
  // parent segment `..`, a path that begins with `..` + separator, or a drive-relative absolute
  // path means the candidate is outside this root.
  return rest.length > 0 && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : `thrown ${typeof error}`;
}

function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}
