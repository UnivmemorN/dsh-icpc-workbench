/**
 * Host compatibility gate and independent training-data directory (Stage 4h0).
 *
 * The compatibility cases build real package trees in a temporary directory — a normal installed
 * CLI package, the source-checkout layout with its `@deepseek-ai/dsh-root` marker, a symlinked
 * launcher, a foreign nearest package, a wrong version and a damaged manifest — so the walk is
 * exercised through the real filesystem, not a mock. The configuration cases additionally inject
 * the filesystem probe to pin the nearest-existing-ancestor rule and the confinement rule without
 * relying on symlink privileges.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  BASELINE_DSH_PACKAGE,
  BASELINE_DSH_ROOT_PACKAGE,
  BASELINE_DSH_VERSION,
  CompatibilityError,
  REQUIRED_HOST_API,
  checkHostCompatibility,
  defaultHostProbe,
  type CompatibilityErrorCode,
} from '../../src/plugin/compatibility.js';
import {
  ConfigError,
  PRODUCT_DATA_DIR_NAME,
  defaultConfigFileSystem,
  defaultDataDir,
  isMissingPathError,
  parsePluginConfig,
  resolveDataDir,
  type ConfigEnvironment,
  type ConfigErrorCode,
  type ConfigFileSystem,
} from '../../src/plugin/config.js';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

function tempRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'icpc-plugin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2));
}

/** A valid structural host: every required public function is present. */
function hostServices(): Record<string, unknown> {
  return {
    connection: { fetch: { register(): void {} } },
    llm: {
      stream(): void {},
      listProviders(): void {},
      listModels(): void {},
      resolveModelInfo(): void {},
    },
    sessions: { create(): void {}, flush(): void {} },
  };
}

/** Normal installed CLI package: the launcher package is its own installation root. */
function installedTree(root: string, version = BASELINE_DSH_VERSION): string {
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh');
  writeJson(join(packageDir, 'package.json'), { name: BASELINE_DSH_PACKAGE, version });
  const launcher = join(packageDir, 'lib', 'cli.js');
  writeText(launcher, '// launcher\n');
  return launcher;
}

/** Source-checkout layout: `apps/cli` is the CLI package and the repository root carries the marker. */
function checkoutTree(root: string, markerVersion = BASELINE_DSH_VERSION, markerPrivate = true): string {
  writeJson(join(root, 'package.json'), {
    name: BASELINE_DSH_ROOT_PACKAGE,
    private: markerPrivate,
    version: markerVersion,
  });
  const packageDir = join(root, 'apps', 'cli');
  writeJson(join(packageDir, 'package.json'), { name: BASELINE_DSH_PACKAGE, version: BASELINE_DSH_VERSION });
  const launcher = join(packageDir, 'dist', 'index.js');
  writeText(launcher, '// cli entry\n');
  return launcher;
}

/** Directory symlink; junctions need no elevation on Windows. Returns false when unsupported. */
function makeDirSymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

async function expectRefusal(code: CompatibilityErrorCode, work: Promise<unknown>): Promise<CompatibilityError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof CompatibilityError, `expected a CompatibilityError, received ${String(error)}`);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0, 'a refusal must explain itself');
    return error;
  }
  assert.fail(`expected a ${code} refusal`);
}

function expectConfigError(code: ConfigErrorCode, work: () => unknown): ConfigError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, received ${String(error)}`);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0, 'a refusal must explain itself');
    return error;
  }
  assert.fail(`expected a ${code} refusal`);
}

// ---------------------------------------------------------------------------------------
// Compatibility: launcher identity and installation root
// ---------------------------------------------------------------------------------------

void test('an installed CLI package is accepted and is its own installation root', async (t) => {
  const root = tempRoot(t);
  const launcher = installedTree(root);

  const compatibility = await checkHostCompatibility(
    { nodeVersion: 'v24.15.0', launcherPath: launcher, services: hostServices() },
    undefined,
  );

  assert.equal(compatibility.nodeVersion, 'v24.15.0');
  assert.equal(compatibility.packageName, BASELINE_DSH_PACKAGE);
  assert.equal(compatibility.packageVersion, BASELINE_DSH_VERSION);
  assert.equal(compatibility.launcherPath, realpathSync(launcher));
  assert.equal(compatibility.launcherRoot, realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh')));
  assert.equal(compatibility.installationRoot, compatibility.launcherRoot);
  assert.deepEqual(compatibility.hostApi, [...REQUIRED_HOST_API]);
});

void test('a source checkout resolves the exact root marker while the CLI manifest stays the version authority', async (t) => {
  const root = tempRoot(t);
  const launcher = checkoutTree(root);

  const compatibility = await checkHostCompatibility({
    nodeVersion: 'v22.19.0',
    launcherPath: launcher,
    services: hostServices(),
  });

  assert.equal(compatibility.launcherRoot, realpathSync(join(root, 'apps', 'cli')));
  assert.equal(compatibility.installationRoot, realpathSync(root));
  assert.equal(compatibility.packageVersion, BASELINE_DSH_VERSION);
});

void test('a source checkout marker with a different version is refused as a partial upgrade', async (t) => {
  const root = tempRoot(t);
  const launcher = checkoutTree(root, '0.1.4');

  const refusal = await expectRefusal(
    'unsupported_host_version',
    checkHostCompatibility({ nodeVersion: 'v24.15.0', launcherPath: launcher, services: hostServices() }),
  );

  assert.match(refusal.message, /0\.1\.4/);
  assert.match(refusal.message, new RegExp(BASELINE_DSH_VERSION.replaceAll('.', '\\.')));
  assert.equal(refusal.details['packageDirectory'], realpathSync(root));
});

void test('a source checkout marker that is not private is refused instead of widening the root', async (t) => {
  const root = tempRoot(t);
  const launcher = checkoutTree(root, BASELINE_DSH_VERSION, false);

  await expectRefusal(
    'unsupported_host_version',
    checkHostCompatibility({ nodeVersion: 'v24.15.0', launcherPath: launcher, services: hostServices() }),
  );
});

void test('a launcher directory is accepted as the launcher path', async (t) => {
  const root = tempRoot(t);
  installedTree(root);
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh');

  const compatibility = await checkHostCompatibility({
    nodeVersion: '24.15.0',
    launcherPath: packageDir,
    services: hostServices(),
  });

  assert.equal(compatibility.launcherRoot, realpathSync(packageDir));
});

void test('a symlinked launcher is resolved through the link', async (t) => {
  const root = tempRoot(t);
  const launcher = installedTree(root);
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const link = join(root, 'linked-dsh');
  if (!makeDirSymlink(packageDir, link)) {
    t.skip('directory symlinks are not available on this host');
    return;
  }

  const compatibility = await checkHostCompatibility({
    nodeVersion: 'v24.15.0',
    launcherPath: join(link, 'lib', 'cli.js'),
    services: hostServices(),
  });

  assert.equal(compatibility.launcherPath, realpathSync(launcher));
  assert.equal(compatibility.launcherRoot, realpathSync(packageDir));
  assert.equal(compatibility.launcherRoot.includes('linked-dsh'), false);
});

void test('a foreign nearest package is refused even when a dsh package exists above it', async (t) => {
  const root = tempRoot(t);
  writeJson(join(root, 'package.json'), { name: BASELINE_DSH_PACKAGE, version: BASELINE_DSH_VERSION });
  const foreign = join(root, 'vendor', 'acme-cli');
  writeJson(join(foreign, 'package.json'), { name: 'acme-cli', version: '9.9.9' });
  const launcher = join(foreign, 'bin', 'acme.js');
  writeText(launcher, '// foreign\n');

  const refusal = await expectRefusal(
    'unknown_launcher',
    checkHostCompatibility({ nodeVersion: 'v24.15.0', launcherPath: launcher, services: hostServices() }),
  );

  assert.match(refusal.message, /acme-cli/);
  assert.equal(refusal.details['packageDirectory'], realpathSync(foreign));
});

void test('a launcher with no package manifest at or above it is refused', async (t) => {
  const root = tempRoot(t);

  await expectRefusal(
    'missing_launcher',
    checkHostCompatibility({
      nodeVersion: 'v24.15.0',
      launcherPath: join(root, 'nowhere', 'cli.js'),
      services: hostServices(),
    }),
  );
});

void test('a dsh package with the wrong version is refused with pin instructions', async (t) => {
  const root = tempRoot(t);
  const launcher = installedTree(root, '0.1.6');

  const refusal = await expectRefusal(
    'unsupported_host_version',
    checkHostCompatibility({ nodeVersion: 'v24.15.0', launcherPath: launcher, services: hostServices() }),
  );

  assert.match(refusal.message, /0\.1\.6/);
  assert.match(refusal.message, new RegExp(BASELINE_DSH_VERSION.replaceAll('.', '\\.')));
});

void test('a damaged nearest manifest is refused instead of being walked past', async (t) => {
  const root = tempRoot(t);
  writeJson(join(root, 'package.json'), { name: BASELINE_DSH_PACKAGE, version: BASELINE_DSH_VERSION });
  const broken = join(root, 'apps', 'cli');
  writeText(join(broken, 'package.json'), '{ not json');
  const launcher = join(broken, 'index.js');
  writeText(launcher, '// broken\n');

  await expectRefusal(
    'invalid_launcher_package',
    checkHostCompatibility({ nodeVersion: 'v24.15.0', launcherPath: launcher, services: hostServices() }),
  );
});

void test('an unreadable package manifest is a typed refusal instead of being walked past', async (t) => {
  const root = tempRoot(t);
  const launcher = installedTree(root);
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const before = readdirSync(packageDir).sort();
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
  const real = defaultHostProbe();
  const probe = {
    stat: (path: string) => {
      if (path === join(packageDir, 'package.json')) {
        throw denied;
      }
      return real.stat(path);
    },
    realpath: (path: string) => real.realpath(path),
    readFile: (path: string) => readFileSync(path, 'utf8'),
  };

  const refusal = await expectRefusal(
    'invalid_launcher_package',
    checkHostCompatibility({ nodeVersion: 'v24.15.0', launcherPath: launcher, services: hostServices() }, probe),
  );

  assert.match(refusal.message, /could not be inspected/);
  assert.deepEqual(readdirSync(packageDir).sort(), before, 'a refused check must not write anything');
});

void test('the real host probe treats only absent paths as missing', (t) => {
  const root = tempRoot(t);
  const file = join(root, 'package.json');
  writeText(file, '{}');
  const probe = defaultHostProbe();

  assert.equal(probe.stat(root), 'directory');
  assert.equal(probe.stat(file), 'file');
  assert.equal(probe.stat(join(root, 'absent')), 'missing');
  assert.equal(probe.stat(join(file, 'child')), 'missing');
});

// ---------------------------------------------------------------------------------------
// Compatibility: Node.js range and host API
// ---------------------------------------------------------------------------------------

void test('only the baseline Node.js lines are accepted', async (t) => {
  const root = tempRoot(t);
  const launcher = installedTree(root);
  const accepted = ['v22.19.0', '22.19.1', 'v22.20.0', 'v24.0.0', 'v24.15.0', 'v25.1.2', 'v26.0.0-nightly'];
  for (const nodeVersion of accepted) {
    const compatibility = await checkHostCompatibility({ nodeVersion, launcherPath: launcher, services: hostServices() });
    assert.equal(compatibility.nodeVersion, nodeVersion);
  }
  const refused = ['v22.18.0', 'v22.0.0', 'v20.11.0', 'v23.5.0', 'v23.0.0', 'v18.20.4', 'not-a-version', ''];
  for (const nodeVersion of refused) {
    await expectRefusal(
      'unsupported_node',
      checkHostCompatibility({ nodeVersion, launcherPath: launcher, services: hostServices() }),
    );
  }
});

void test('an unsupported Node.js version is refused before any launcher work', async (t) => {
  const root = tempRoot(t);

  const refusal = await expectRefusal(
    'unsupported_node',
    checkHostCompatibility({
      nodeVersion: 'v23.1.0',
      launcherPath: join(root, 'does-not-exist'),
      services: hostServices(),
    }),
  );

  assert.match(refusal.message, /22\.19/);
});

void test('every required public host function must be present', async (t) => {
  const root = tempRoot(t);
  const launcher = installedTree(root);

  const empty = await expectRefusal(
    'incomplete_host_api',
    checkHostCompatibility({ nodeVersion: 'v24.15.0', launcherPath: launcher, services: {} }),
  );
  assert.deepEqual(empty.details['missing'], [...REQUIRED_HOST_API]);

  const partial = hostServices();
  delete (partial['llm'] as Record<string, unknown>)['resolveModelInfo'];
  const partialRefusal = await expectRefusal(
    'incomplete_host_api',
    checkHostCompatibility({ nodeVersion: 'v24.15.0', launcherPath: launcher, services: partial }),
  );
  assert.deepEqual(partialRefusal.details['missing'], ['llm.resolveModelInfo']);

  const notAFunction = hostServices();
  (notAFunction['sessions'] as Record<string, unknown>)['flush'] = 'yes';
  await expectRefusal(
    'incomplete_host_api',
    checkHostCompatibility({ nodeVersion: 'v24.15.0', launcherPath: launcher, services: notAFunction }),
  );
});

// ---------------------------------------------------------------------------------------
// Configuration: defaults
// ---------------------------------------------------------------------------------------

function environment(overrides: Partial<ConfigEnvironment> = {}): ConfigEnvironment {
  return { platform: 'linux', env: {}, home: '/home/trainer', ...overrides };
}

void test('the default data directory follows the operating-system convention', () => {
  const localAppData = 'C:\\Users\\trainer\\AppData\\Local';
  assert.equal(
    defaultDataDir(environment({ platform: 'win32', env: { LOCALAPPDATA: localAppData }, home: 'C:\\Users\\trainer' })),
    join(localAppData, PRODUCT_DATA_DIR_NAME),
  );
  assert.equal(
    defaultDataDir(environment({ platform: 'darwin', home: '/Users/trainer' })),
    join('/Users/trainer', 'Library', 'Application Support', PRODUCT_DATA_DIR_NAME),
  );
  assert.equal(
    defaultDataDir(environment({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg/data' }, home: '/home/trainer' })),
    join('/xdg/data', PRODUCT_DATA_DIR_NAME),
  );
  assert.equal(
    defaultDataDir(environment()),
    join('/home/trainer', '.local', 'share', PRODUCT_DATA_DIR_NAME),
  );
});

void test('a missing environment variable is an explicit failure, not a guessed path', () => {
  expectConfigError('missing_environment', () => defaultDataDir(environment({ platform: 'win32', env: {} })));
  expectConfigError('missing_environment', () => defaultDataDir(environment({ platform: 'darwin', home: '   ' })));
});

// ---------------------------------------------------------------------------------------
// Configuration: strict shape
// ---------------------------------------------------------------------------------------

void test('the plugin configuration is a strict plain object', () => {
  assert.deepEqual(parsePluginConfig(undefined), {});
  assert.deepEqual(parsePluginConfig({}), {});
  assert.deepEqual(parsePluginConfig({ dataDir: process.platform === 'win32' ? 'C:\\data' : '/data' }), {
    dataDir: process.platform === 'win32' ? 'C:\\data' : '/data',
  });
  const absolute = process.platform === 'win32' ? 'C:\\data' : '/data';
  expectConfigError('invalid_config', () => parsePluginConfig(null));
  expectConfigError('invalid_config', () => parsePluginConfig([]));
  expectConfigError('invalid_config', () => parsePluginConfig('data'));
  expectConfigError('invalid_config', () => parsePluginConfig(new (class Config {})()));
  expectConfigError('invalid_config', () => parsePluginConfig({ dataDir: absolute, provider: 'x' }));
  expectConfigError('invalid_config', () => parsePluginConfig({ dataDir: 7 }));
  expectConfigError('invalid_data_dir', () => parsePluginConfig({ dataDir: '' }));
  expectConfigError('invalid_data_dir', () => parsePluginConfig({ dataDir: '   ' }));
  expectConfigError('invalid_data_dir', () => parsePluginConfig({ dataDir: 'relative/data' }));
  expectConfigError('invalid_data_dir', () => parsePluginConfig({ dataDir: `${absolute}\0suffix` }));
});

// ---------------------------------------------------------------------------------------
// Configuration: resolution and confinement
// ---------------------------------------------------------------------------------------

void test('a configured data directory is canonicalized without being created', (t) => {
  const root = tempRoot(t);
  const target = join(root, 'state', 'training');
  const before = readdirSync(root).sort();

  const resolved = resolveDataDir({ dataDir: target }, { environment: environment({ platform: process.platform }) });

  assert.equal(resolved, join(realpathSync(root), 'state', 'training'));
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(root).sort(), before);
});

void test('a symlinked ancestor is resolved before the remaining segments are appended', (t) => {
  const root = tempRoot(t);
  const real = join(root, 'real-tree');
  mkdirSync(real, { recursive: true });
  const link = join(root, 'link-tree');
  if (!makeDirSymlink(real, link)) {
    t.skip('directory symlinks are not available on this host');
    return;
  }

  const resolved = resolveDataDir(
    { dataDir: join(link, 'state', 'training') },
    { environment: environment({ platform: process.platform }) },
  );

  assert.equal(resolved, join(realpathSync(real), 'state', 'training'));
  assert.equal(resolved.includes('link-tree'), false);
  assert.equal(existsSync(join(real, 'state')), false);
});

void test('training data inside the dsh installation or dshHome is refused; siblings are not', (t) => {
  const root = tempRoot(t);
  const installationRoot = join(root, 'harness');
  const dshHome = join(root, 'dsh-home');
  mkdirSync(installationRoot, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  const context = {
    environment: environment({ platform: process.platform }),
    installationRoot,
    dshHome,
  };

  expectConfigError('data_dir_conflict', () => resolveDataDir({ dataDir: join(installationRoot, 'data') }, context));
  expectConfigError('data_dir_conflict', () => resolveDataDir({ dataDir: installationRoot }, context));
  expectConfigError('data_dir_conflict', () => resolveDataDir({ dataDir: join(dshHome, 'data') }, context));

  const sibling = resolveDataDir({ dataDir: join(root, 'harness2', 'data') }, context);
  assert.equal(sibling, join(realpathSync(root), 'harness2', 'data'));

  const acceptance = resolveDataDir(
    { dataDir: join(root, 'plugin', '.local', 'state', 'training') },
    context,
  );
  assert.equal(acceptance, join(realpathSync(root), 'plugin', '.local', 'state', 'training'));
});

void test('a child whose name starts with dots is still inside the guarded tree', (t) => {
  const root = tempRoot(t);
  const installationRoot = join(root, 'harness');
  const dshHome = join(root, 'dsh-home');
  mkdirSync(installationRoot, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  const context = {
    environment: environment({ platform: process.platform }),
    installationRoot,
    dshHome,
  };

  for (const guarded of [installationRoot, dshHome]) {
    expectConfigError('data_dir_conflict', () => resolveDataDir({ dataDir: join(guarded, '..training') }, context));
    expectConfigError('data_dir_conflict', () =>
      resolveDataDir({ dataDir: join(guarded, '..training', 'nested') }, context),
    );
  }

  const hidden = resolveDataDir(
    { dataDir: join(root, 'state', '.hidden', 'training') },
    { environment: environment({ platform: process.platform }) },
  );
  assert.equal(hidden, join(realpathSync(root), 'state', '.hidden', 'training'));
});

void test('an unreadable path is a typed refusal and never a silent walk past it', (t) => {
  const root = tempRoot(t);
  const blocked = join(root, 'blocked');
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
  const probe: ConfigFileSystem = {
    stat: (path) => {
      if (path === blocked) {
        throw denied;
      }
      return path === root ? 'directory' : 'missing';
    },
    realpath: () => realpathSync(root),
  };

  const error = expectConfigError('invalid_data_dir', () =>
    resolveDataDir(
      { dataDir: join(blocked, 'training') },
      { environment: environment({ platform: process.platform }), fileSystem: probe },
    ),
  );

  assert.match(error.message, /could not be inspected/);
  assert.equal(existsSync(blocked), false, 'a refused check must not create the unreadable path');
  assert.deepEqual(readdirSync(root), []);
});

void test('an unreadable guard root is an unresolvable-data-dir refusal', (t) => {
  const root = tempRoot(t);
  const guard = join(root, 'harness');
  const denied = Object.assign(new Error('access denied'), { code: 'EPERM' });
  const probe: ConfigFileSystem = {
    stat: (path) => {
      if (path === guard) {
        throw denied;
      }
      return path === root ? 'directory' : 'missing';
    },
    realpath: () => realpathSync(root),
  };

  expectConfigError('unresolvable_data_dir', () =>
    resolveDataDir(
      { dataDir: join(root, 'training') },
      { environment: environment({ platform: process.platform }), installationRoot: guard, fileSystem: probe },
    ),
  );
});

void test('only absent entries are classified as missing by the real probe', (t) => {
  assert.equal(isMissingPathError(Object.assign(new Error('gone'), { code: 'ENOENT' })), true);
  assert.equal(isMissingPathError(Object.assign(new Error('a component is a file'), { code: 'ENOTDIR' })), true);
  for (const code of ['EACCES', 'EPERM', 'EIO', 'EBUSY']) {
    assert.equal(isMissingPathError(Object.assign(new Error('denied'), { code })), false, `${code} is not missing`);
  }
  assert.equal(isMissingPathError(new Error('no code')), false);

  const root = tempRoot(t);
  const file = join(root, 'file.txt');
  writeText(file, 'x');
  const probe = defaultConfigFileSystem();
  assert.equal(probe.stat(root), 'directory');
  assert.equal(probe.stat(file), 'file');
  assert.equal(probe.stat(join(root, 'absent')), 'missing');
  assert.equal(probe.stat(join(file, 'child')), 'missing');
});

void test('an undisclosed dshHome or installation root leaves the location unguarded', (t) => {
  const root = tempRoot(t);

  const resolved = resolveDataDir(
    { dataDir: join(root, 'data') },
    { environment: environment({ platform: process.platform }), dshHome: null, installationRoot: null },
  );

  assert.equal(resolved, join(realpathSync(root), 'data'));
});

void test('the nearest existing ancestor rule uses the injected probe', () => {
  const existing = process.platform === 'win32' ? 'C:\\icpc-existing' : '/icpc-existing';
  const canonical = process.platform === 'win32' ? 'C:\\icpc-canonical' : '/icpc-canonical';
  const probe: ConfigFileSystem = {
    stat: (path) => (path === existing ? 'directory' : 'missing'),
    realpath: () => canonical,
  };

  const resolved = resolveDataDir(
    { dataDir: join(existing, 'a', 'b') },
    { environment: environment({ platform: process.platform }), fileSystem: probe },
  );

  assert.equal(resolved, join(canonical, 'a', 'b'));

  const fileProbe: ConfigFileSystem = {
    stat: (path) => (path === existing ? 'file' : 'missing'),
    realpath: () => canonical,
  };
  expectConfigError('invalid_data_dir', () =>
    resolveDataDir(
      { dataDir: join(existing, 'a') },
      { environment: environment({ platform: process.platform }), fileSystem: fileProbe },
    ),
  );
});

void test('a relative configured directory is refused at resolution time too', () => {
  expectConfigError('invalid_data_dir', () =>
    resolveDataDir({ dataDir: 'relative/data' }, { environment: environment({ platform: process.platform }) }),
  );
});
