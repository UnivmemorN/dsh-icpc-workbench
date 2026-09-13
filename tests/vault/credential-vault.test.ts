/**
 * Sprint 17b — portable local credential vault regressions.
 *
 * Every test in this file runs on any OS: the vault is given an injected in-memory backend, so the
 * namespace derivation, reference validation, UTF-8 capacity, lifecycle, cancellation and error
 * projection are exercised without touching a real credential store. All secret strings are
 * synthetic values generated inside this file; none is a real credential.
 *
 * One platform seam is explicit instead of hidden (Sprint 17f): the vault backend is Windows Credential
 * Manager, so "a real data directory receives no plaintext file" cannot be a single unconditional
 * statement. On Windows (`process.platform === 'win32'`) the real temporary directory is exercised
 * through a successful write/read/remove with the injected bridge — and fails loudly, never skips, if
 * that directory is not a drive-absolute Windows path, because the production namespace rule
 * deliberately refuses POSIX/UNC-rooted spellings. On any other platform the vault reports an honest
 * unsupported capability and every credential operation must be refused before the bridge is consulted,
 * so the test asserts that rejection plus the untouched real directory instead of constructing a
 * Windows-namespaced vault over a POSIX path (which the production path validation correctly refuses).
 * Neither branch is skipped on its own platform, so the no-file-fallback purpose is preserved
 * everywhere.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREDENTIAL_REFERENCE_PATTERN,
  MAX_CREDENTIAL_REFERENCE_CHARS,
  MAX_CREDENTIAL_SECRET_BYTES,
  LocalCredentialVaultError,
  requireCredentialReference,
  type LocalCredentialVault,
} from '../../src/application/local-credential-vault.js';
import {
  WindowsCredentialVault,
  canonicalCredentialNamespace,
  createWindowsCredentialVault,
  credentialTargetName,
} from '../../src/adapters/windows/index.js';
import type { CredentialBridge } from '../../src/adapters/windows/index.js';
import { createCancellationSource } from '../../src/domain/index.js';
import { createMemoryBridge, type MemoryBridge } from './fixtures.js';

const DATA_DIR = 'C:\\workspace-data\\icpc';
const OTHER_DATA_DIR = 'D:\\other-workspace\\data';

function token(): ReturnType<typeof createCancellationSource>['token'] {
  return createCancellationSource().token;
}

function vaultFor(memory: MemoryBridge, dataDir: string = DATA_DIR): WindowsCredentialVault {
  return createWindowsCredentialVault({ dataDir, platform: 'win32', bridge: memory.bridge });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: string }).code
    : undefined;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.notEqual(error, null, `expected a ${code} rejection`);
  assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
  return error as Record<string, unknown>;
}

/** A secret must not appear in any textual surface of an error or in its JSON projection. */
function assertNoSecret(error: unknown, secret: string): void {
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const fields = ['name', 'message', 'detail', 'stack']
    .map((key) => (typeof record[key] === 'string' ? (record[key] as string) : ''))
    .join(' | ');
  const surfaces = `${fields} | ${JSON.stringify(record)} | ${String(error)}`;
  assert.equal(surfaces.includes(secret), false, `the synthetic secret leaked into: ${surfaces}`);
}

// ---------------------------------------------------------------------------------------
// Capability and platform honesty
// ---------------------------------------------------------------------------------------

test('a non-Windows platform is an honest unsupported capability, not a construction failure', async () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const memory = createMemoryBridge();
    const vault = createWindowsCredentialVault({
      dataDir: '/home/user/.local/share/dsh-icpc',
      platform,
      bridge: memory.bridge,
    });
    const capabilities = vault.capabilities();
    assert.equal(capabilities.implemented, false);
    assert.equal(capabilities.platform, platform);
    assert.equal(capabilities.notes.length > 0, true);
    await rejectsWithCode(vault.read('luogu-session', token()), 'unsupported');
    await rejectsWithCode(vault.write('luogu-session', 'synthetic-secret', token()), 'unsupported');
    await rejectsWithCode(vault.remove('luogu-session', token()), 'unsupported');
    assert.equal(memory.calls.length, 0, 'an unsupported platform never consults the backend');
  }
});

test('the port exposes no enumeration and reports its capability honestly', () => {
  const memory = createMemoryBridge();
  const vault: LocalCredentialVault = vaultFor(memory);
  const prototype = Object.getPrototypeOf(vault) as object;
  const suspicious = Object.getOwnPropertyNames(prototype).filter((name) => /list|enumerate|all|keys|entries/i.test(name));
  assert.deepEqual(suspicious, [], 'the vault must not expose reference enumeration');
  const capabilities = vault.capabilities();
  assert.equal(capabilities.implemented, true);
  assert.equal(capabilities.platform, 'win32');
  assert.equal(capabilities.notes.length, 2);
});

// ---------------------------------------------------------------------------------------
// Reference validation and namespacing
// ---------------------------------------------------------------------------------------

test('reference validation refuses anything that is not a bounded opaque token', async () => {
  const memory = createMemoryBridge();
  const vault = vaultFor(memory);
  const invalid: readonly unknown[] = [
    '',
    ' ',
    '.',
    '-',
    '.hidden',
    '-dash',
    'a b',
    'a/b',
    'a\\b',
    'a\nb',
    'a\tb',
    'a\u0000b',
    'a".b',
    `${'a'.repeat(MAX_CREDENTIAL_REFERENCE_CHARS)}b`,
    42,
    null,
    undefined,
    {},
    ['a'],
  ];
  for (const reference of invalid) {
    const error = await rejectsWithCode(vault.write(reference as string, 'synthetic-secret', token()), 'invalid_input');
    assertNoSecret(error, 'synthetic-secret');
  }
  assert.equal(memory.calls.length, 0, 'an invalid reference never reaches the backend');
  assert.equal(requireCredentialReference('luogu-session.v1:248159'), 'luogu-session.v1:248159');
  assert.equal(CREDENTIAL_REFERENCE_PATTERN.test('a'.repeat(MAX_CREDENTIAL_REFERENCE_CHARS)), true);
  assert.equal(CREDENTIAL_REFERENCE_PATTERN.test('a'.repeat(MAX_CREDENTIAL_REFERENCE_CHARS + 1)), false);
});

test('one reference maps to different targets in different workspaces and never to the path', async () => {
  const first = createMemoryBridge();
  const second = createMemoryBridge();
  const a = vaultFor(first, DATA_DIR);
  const b = vaultFor(second, OTHER_DATA_DIR);
  await a.write('luogu-session', 'synthetic-alpha', token());
  await b.write('luogu-session', 'synthetic-beta', token());
  const targetA = first.calls[0]?.target ?? '';
  const targetB = second.calls[0]?.target ?? '';
  assert.match(targetA, /^dsh-icpc-workbench\.[0-9a-f]{64}$/u);
  assert.match(targetB, /^dsh-icpc-workbench\.[0-9a-f]{64}$/u);
  assert.notEqual(targetA, targetB, 'a different workspace must derive a different target');
  assert.equal(targetA.includes('workspace'), false, 'the target does not disclose the data directory');
  assert.equal(targetA.includes('luogu-session'), false, 'the target does not disclose the reference');
  assert.equal(await a.read('luogu-session', token()), 'synthetic-alpha');
  assert.equal(await b.read('luogu-session', token()), 'synthetic-beta');
  assert.equal(first.store.has(targetB), false, 'no cross-workspace entry exists');
});

test('the data directory canonicalizes case, separators and dot segments but not sibling paths', () => {
  const canonical = canonicalCredentialNamespace('C:\\Workspace\\Data\\');
  assert.equal(canonical, 'c:\\workspace\\data');
  assert.equal(canonicalCredentialNamespace('c:/workspace/data'), canonical);
  assert.equal(canonicalCredentialNamespace('C:\\workspace\\other\\..\\data'), canonical);
  assert.equal(
    credentialTargetName(canonical, 'luogu-session'),
    credentialTargetName(canonicalCredentialNamespace('c:/WORKSPACE/data/'), 'luogu-session'),
  );
  assert.notEqual(
    credentialTargetName(canonical, 'luogu-session'),
    credentialTargetName(canonicalCredentialNamespace('C:\\Workspace\\Data2'), 'luogu-session'),
  );
  assert.notEqual(
    credentialTargetName(canonical, 'luogu-session'),
    credentialTargetName(canonical, 'luogu-session-2'),
  );
  for (const bad of ['', 'relative\\path', '/rooted', 'C:', 'data', 'C:\\bad\u0000path', '\\\\', 'x'.repeat(4097)]) {
    assert.throws(
      () => canonicalCredentialNamespace(bad),
      (error: unknown) => codeOf(error) === 'invalid_input',
      `the data directory ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('a reference that mimics a credential target addresses only its own digest', async () => {
  const memory = createMemoryBridge();
  const vault = vaultFor(memory);
  const victimTarget = credentialTargetName(canonicalCredentialNamespace(DATA_DIR), 'victim-reference');
  const victimSecret = 'synthetic-victim-secret';
  memory.store.set(victimTarget, Buffer.from(victimSecret, 'utf8').toString('base64'));

  const mimic = victimTarget;
  assert.equal(CREDENTIAL_REFERENCE_PATTERN.test(mimic), true, 'the mimic is a valid reference by shape');
  assert.equal(await vault.read(mimic, token()), null, 'the mimic reads its own (empty) entry');
  await vault.write(mimic, 'synthetic-mimic-secret', token());
  const mimicTarget = memory.calls[0]?.target ?? '';
  assert.notEqual(mimicTarget, victimTarget, 'the mimic must not resolve to the target it spells');
  assert.equal(await vault.read('victim-reference', token()), victimSecret, 'the victim entry is untouched');
  assert.equal(memory.store.size, 2);
});

// ---------------------------------------------------------------------------------------
// Lifecycle and capacity
// ---------------------------------------------------------------------------------------

test('write, replace, read and remove: a missing read is null and a missing remove is a no-op', async () => {
  const memory = createMemoryBridge();
  const vault = vaultFor(memory);
  assert.equal(await vault.read('luogu-session', token()), null);
  await vault.remove('luogu-session', token());
  await vault.write('luogu-session', 'synthetic-first', token());
  assert.equal(await vault.read('luogu-session', token()), 'synthetic-first');
  await vault.write('luogu-session', 'synthetic-second', token());
  assert.equal(await vault.read('luogu-session', token()), 'synthetic-second', 'a write replaces the value');
  assert.equal(memory.store.size, 1, 'a replace overwrites exactly one entry');
  await vault.remove('luogu-session', token());
  assert.equal(await vault.read('luogu-session', token()), null);
  await vault.remove('luogu-session', token());
  assert.equal(memory.store.size, 0);
});

test('the capacity is measured in UTF-8 bytes before any write reaches the backend', async () => {
  const memory = createMemoryBridge();
  const vault = vaultFor(memory);
  const accepted = [
    'a'.repeat(MAX_CREDENTIAL_SECRET_BYTES),
    'é'.repeat(MAX_CREDENTIAL_SECRET_BYTES / 2),
    '🔑'.repeat(MAX_CREDENTIAL_SECRET_BYTES / 4),
  ];
  for (const secret of accepted) {
    await vault.write('boundary', secret, token());
    assert.equal(await vault.read('boundary', token()), secret, 'the accepted boundary value round-trips');
  }
  const lastAccepted = accepted[accepted.length - 1] ?? '';

  const callsBefore = memory.calls.length;
  const refused = [
    'a'.repeat(MAX_CREDENTIAL_SECRET_BYTES + 1),
    'é'.repeat(MAX_CREDENTIAL_SECRET_BYTES / 2 + 1),
    '🔑'.repeat(MAX_CREDENTIAL_SECRET_BYTES / 4 + 1),
    '',
    '\uD800',
    'ok\uDC00',
  ];
  for (const secret of refused) {
    await rejectsWithCode(vault.write('boundary', secret, token()), 'invalid_input');
  }
  assert.equal(memory.calls.length, callsBefore, 'an oversized or malformed secret never reaches the backend');
  assert.equal(
    await vault.read('boundary', token()),
    lastAccepted,
    'refused writes leave the stored value untouched',
  );
});

test('a value longer than the store capacity is refused rather than split across entries', async () => {
  const memory = createMemoryBridge();
  const vault = vaultFor(memory);
  for (const reference of ['part-one', 'part-two']) {
    await vault.write(reference, 'a'.repeat(MAX_CREDENTIAL_SECRET_BYTES), token());
  }
  assert.equal(memory.calls.length, 2, 'two distinct references are two distinct entries, never one split value');
  await rejectsWithCode(vault.write('part-one', 'a'.repeat(MAX_CREDENTIAL_SECRET_BYTES + 1), token()), 'invalid_input');
});

// ---------------------------------------------------------------------------------------
// Failure projection and backends the vault does not control
// ---------------------------------------------------------------------------------------

test('a hostile or broken backend cannot leak a secret through the vault error projection', async () => {
  const secret = 'synthetic-secret-marker-0123456789';

  const exploding = createMemoryBridge();
  exploding.beforeInvoke = () => {
    throw new Error(`bridge exploded while handling ${secret}`);
  };
  const explodingVault = vaultFor(exploding);
  const exploded = await rejectsWithCode(explodingVault.read('luogu-session', token()), 'unavailable');
  assertNoSecret(exploded, secret);
  assert.equal(exploded.message, 'the OS credential vault operation failed');

  const forged = createMemoryBridge();
  forged.beforeInvoke = () => {
    const error = new LocalCredentialVaultError('invalid_input', `forged detail ${secret}`);
    Object.assign(error, { code: `code-${secret}` });
    throw error;
  };
  const forgedVault = vaultFor(forged);
  const forgedError = await rejectsWithCode(forgedVault.write('luogu-session', secret, token()), 'unavailable');
  assertNoSecret(forgedError, secret);

  const knownCode = createMemoryBridge();
  knownCode.beforeInvoke = () => {
    throw new LocalCredentialVaultError('invalid_input', secret);
  };
  const knownVault = vaultFor(knownCode);
  const knownError = await rejectsWithCode(knownVault.read('luogu-session', token()), 'invalid_input');
  assertNoSecret(knownError, secret);
  assert.equal(knownError.message, 'the credential request was rejected', 'only the allow-listed code survives');
});

test('an unusable backend reply is a failure, never a partial or fabricated value', async () => {
  const secret = 'synthetic-unusable-secret';
  const replies: readonly unknown[] = [
    { kind: 'secret', secretBase64: 'not base64!!' },
    { kind: 'secret', secretBase64: '' },
    { kind: 'done' },
    {},
  ];
  for (const reply of replies) {
    const bridge: CredentialBridge = {
      invoke: async () => reply as Awaited<ReturnType<CredentialBridge['invoke']>>,
    };
    const vault = createWindowsCredentialVault({ dataDir: DATA_DIR, platform: 'win32', bridge });
    const error = await rejectsWithCode(vault.read('luogu-session', token()), 'unavailable');
    assertNoSecret(error, secret);
  }

  const wrongWay: CredentialBridge = { invoke: async () => ({ kind: 'secret', secretBase64: 'AAAA' }) };
  const wrongWayVault = createWindowsCredentialVault({ dataDir: DATA_DIR, platform: 'win32', bridge: wrongWay });
  await rejectsWithCode(wrongWayVault.write('luogu-session', 'synthetic-secret', token()), 'unavailable');
  await rejectsWithCode(wrongWayVault.remove('luogu-session', token()), 'unavailable');
});

// ---------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------

test('cancellation is refused before the backend, observed during it, and never reported as success', async () => {
  const memory = createMemoryBridge();
  const vault = vaultFor(memory);

  const alreadyCancelled = createCancellationSource();
  alreadyCancelled.cancel('user navigated away');
  const callsBefore = memory.calls.length;
  await rejectsWithCode(vault.write('luogu-session', 'synthetic-secret', alreadyCancelled.token), 'cancelled');
  await rejectsWithCode(vault.read('luogu-session', alreadyCancelled.token), 'cancelled');
  await rejectsWithCode(vault.remove('luogu-session', alreadyCancelled.token), 'cancelled');
  assert.equal(memory.calls.length, callsBefore, 'a cancelled call never reaches the backend');

  let observedCancellation = false;
  const slow: CredentialBridge = {
    invoke: async (_request, token) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      observedCancellation = token.cancelled;
      return { kind: 'done' };
    },
  };
  const slowVault = createWindowsCredentialVault({ dataDir: DATA_DIR, platform: 'win32', bridge: slow });
  const slowSource = createCancellationSource();
  const slowCall = slowVault.write('luogu-session', 'synthetic-secret', slowSource.token);
  slowSource.cancel('disconnect');
  await rejectsWithCode(slowCall, 'cancelled');
  assert.equal(observedCancellation, true, 'the cancellation token reaches the backend');

  // A backend that already committed when cancellation arrived still yields `cancelled`; the vault
  // makes no rollback claim, so the stored value may exist.
  const committed = createMemoryBridge();
  const committedVault = vaultFor(committed);
  const racing = createCancellationSource();
  const racingCall = committedVault.write('luogu-session', 'synthetic-secret', racing.token);
  racing.cancel('disconnect raced the write');
  await rejectsWithCode(racingCall, 'cancelled');
  assert.equal(committed.store.size, 1, 'cancellation does not claim to have rolled the write back');
});

// ---------------------------------------------------------------------------------------
// No file fallback
// ---------------------------------------------------------------------------------------

/**
 * Real-directory no-fallback check, native branch.
 *
 * An actual directory of this Windows host is the vault's data directory, so a successful
 * write/read/remove through the injected bridge can be checked against the real file system. The
 * synthetic secret lives only in the in-memory store, and the directory must still be empty
 * afterwards: there is no plaintext fallback.
 */
test(
  'the vault writes no file: a real data directory stays empty across write, read and remove',
  { skip: process.platform === 'win32' ? false : 'the Windows-only success branch needs a real Windows data directory' },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-icpc-vault-'));
    try {
      assert.match(
        directory,
        /^[A-Za-z]:[\\/]/u,
        'the Windows branch needs a drive-absolute temporary directory; a POSIX/UNC-rooted host path cannot carry this check because the namespace rule correctly refuses it',
      );
      const memory = createMemoryBridge();
      const vault = createWindowsCredentialVault({ dataDir: directory, platform: 'win32', bridge: memory.bridge });
      await vault.write('luogu-session', 'synthetic-secret', token());
      assert.equal(await vault.read('luogu-session', token()), 'synthetic-secret');
      await vault.remove('luogu-session', token());
      assert.deepEqual(readdirSync(directory), [], 'the vault has no plaintext file fallback');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

/**
 * Real-directory no-fallback check, non-Windows branch.
 *
 * This host has no OS-protected credential backend, so an injected bridge must never be consulted
 * and no credential operation may appear to succeed — independently of the data directory. A real
 * temporary directory is the vault's data directory here, and it must stay empty: an unsupported
 * platform is an explicit capability gap, not a reason to fall back to a file.
 */
test(
  'no plaintext fallback on a host without the OS vault: a real directory stays empty while every operation is refused',
  { skip: process.platform === 'win32' ? 'this host has the Windows vault; the non-Windows honesty branch covers the unsupported case' : false },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-icpc-vault-unsupported-'));
    try {
      const memory = createMemoryBridge();
      const vault = createWindowsCredentialVault({ dataDir: directory, platform: process.platform, bridge: memory.bridge });
      const capabilities = vault.capabilities();
      assert.equal(capabilities.implemented, false, 'this host has no OS-protected credential backend');
      assert.equal(capabilities.platform, process.platform);
      await rejectsWithCode(vault.write('luogu-session', 'synthetic-secret', token()), 'unsupported');
      await rejectsWithCode(vault.read('luogu-session', token()), 'unsupported');
      await rejectsWithCode(vault.remove('luogu-session', token()), 'unsupported');
      assert.equal(memory.calls.length, 0, 'an unsupported host never consults the backend');
      assert.deepEqual(readdirSync(directory), [], 'the vault has no plaintext file fallback');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
