/**
 * Sprint 17b — real Windows Credential Manager roundtrip with synthetic values.
 *
 * This is the only file that touches a real OS credential store. Every value is generated inside
 * the test: a fresh temporary data directory derives a fresh namespace, the reference is a random
 * UUID and the secrets are random UUIDs (plus one 2560-byte UTF-8 boundary value), and the entry is
 * deleted in a `finally` block plus an idempotent second delete, so nothing synthetic is left
 * behind. No existing credential is read, listed or modified.
 *
 * Two environment preconditions are reported explicitly rather than hidden:
 *
 * - a non-Windows host cannot have a Windows vault at all;
 * - the DSH worker file sandbox denies a Node child process with piped stdio (`spawn EPERM`), and
 *   piped stdio is exactly the mechanism the bridge needs for a private stdout reply.
 *
 * Either condition skips the test with its reason. A skip is never a pass: the portable suites
 * carry the protocol and vault behaviour on every OS, and the stage report states which of these
 * checks actually executed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowsCredentialVault } from '../../src/adapters/windows/index.js';
import { createCancellationSource, type CancellationToken } from '../../src/domain/index.js';

const WINDOWS_ONLY =
  process.platform === 'win32' ? false : 'Windows-only: the OS credential vault is not implemented on this platform';

function token(): CancellationToken {
  return createCancellationSource().token;
}

/**
 * Detect the one environment limitation this test cannot work around: a host that refuses to spawn
 * a child process with piped stdio. Only the documented `EPERM` is reported; any other spawn
 * problem is left to the real roundtrip below, where it fails loudly.
 */
function pipedStdioDeniedByHost(): boolean {
  try {
    const probe = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    probe.on('error', () => undefined);
    probe.unref();
    return false;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { readonly code?: unknown }).code
        : null;
    return code === 'EPERM';
  }
}

test(
  'a synthetic secret round-trips through the real Windows Credential Manager and is deleted',
  { skip: WINDOWS_ONLY },
  async (context) => {
    if (pipedStdioDeniedByHost()) {
      context.skip(
        'this host denies a child process with piped stdio (spawn EPERM), so the real Credential Manager roundtrip cannot run here',
      );
      return;
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-icpc-vault-17b-'));
    const reference = `synthetic-session-${randomUUID()}`;
    const firstSecret = `synthetic-secret-${randomUUID()}-🔑`;
    const secondSecret = `synthetic-replaced-${randomUUID()}`;
    const boundarySecret = 'é'.repeat(1280);
    const vault = createWindowsCredentialVault({ dataDir });
    const cleanupFailures: unknown[] = [];
    try {
      const capabilities = vault.capabilities();
      assert.equal(capabilities.implemented, true, 'Windows must report an implemented vault');
      assert.equal(capabilities.platform, 'win32');

      assert.equal(await vault.read(reference, token()), null, 'a fresh random reference starts absent');
      await vault.write(reference, firstSecret, token());
      assert.deepEqual(readdirSync(dataDir), [], 'no plaintext file is written into the data directory');
      assert.equal(await vault.read(reference, token()), firstSecret);
      await vault.write(reference, secondSecret, token());
      assert.equal(await vault.read(reference, token()), secondSecret, 'a second write replaces the value');
      await vault.write(reference, boundarySecret, token());
      assert.equal(await vault.read(reference, token()), boundarySecret, 'a 2560-byte UTF-8 value round-trips');
    } finally {
      try {
        await vault.remove(reference, token());
      } catch (error) {
        cleanupFailures.push(error);
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
    assert.deepEqual(cleanupFailures, [], 'the synthetic entry must be removable');
    assert.equal(await vault.read(reference, token()), null, 'the synthetic entry is gone');
    await vault.remove(reference, token());
  },
);
