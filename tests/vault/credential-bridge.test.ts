/**
 * Sprint 17b — portable hidden-bridge protocol and process regressions.
 *
 * The bridge is driven through its injected spawn and timer seams, so every process failure path —
 * spawn error, throw, non-zero or signal exit, unusable reply, oversized stdout or stderr, timeout,
 * ignored kill, refused or throwing kill, cancellation and drain-before-settle — is exercised on
 * any OS. The one thing these tests never do is call the real Credential Manager;
 * `tests/vault/credential-vault-windows.test.ts` covers that with synthetic values on Windows.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BRIDGE_TIMEOUT_MS,
  MAX_BRIDGE_STDERR_BYTES,
  MAX_BRIDGE_STDOUT_BYTES,
  POWERSHELL_BRIDGE_ARGUMENTS,
  POWERSHELL_BRIDGE_COMMAND,
  POWERSHELL_BRIDGE_SCRIPT,
  PowerShellCredentialBridge,
  createWindowsCredentialVault,
  type CredentialBridgeRequest,
  type SpawnBridgeProcess,
} from '../../src/adapters/windows/index.js';
import { DomainError, createCancellationSource } from '../../src/domain/index.js';
import {
  createEmulatedCredentialManager,
  createManualTimers,
  createSpawnHarness,
  soon,
  tick,
  type FakeChildProcess,
  type ManualTimers,
  type SpawnHarness,
} from './fixtures.js';

const TARGET = `dsh-icpc-workbench.${'a'.repeat(64)}`;
const EXECUTABLE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function token(): ReturnType<typeof createCancellationSource>['token'] {
  return createCancellationSource().token;
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

interface BridgeFixture {
  readonly bridge: PowerShellCredentialBridge;
  readonly harness: SpawnHarness;
  readonly timers: ManualTimers;
}

function bridgeWith(
  behavior: (child: FakeChildProcess, index: number) => void,
  options: { readonly timeoutMs?: number } = {},
): BridgeFixture {
  const harness = createSpawnHarness(behavior);
  const timers = createManualTimers();
  const bridge = new PowerShellCredentialBridge({
    platform: 'win32',
    executable: EXECUTABLE,
    spawn: harness.spawn,
    setTimer: timers.setTimer,
    ...options,
  });
  return { bridge, harness, timers };
}

/** A child that answers with `stdout` and then exits with `code`. */
function reply(stdout: string, code: number | null = 0): (child: FakeChildProcess) => void {
  return (child) => {
    soon(() => {
      child.spawnEvent();
      if (stdout.length > 0) {
        child.sendStdout(stdout);
      }
      child.close(code);
    });
  };
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
// Frozen command and protocol basics
// ---------------------------------------------------------------------------------------

test('the defaults and the encoded command are the documented frozen program', () => {
  assert.equal(DEFAULT_BRIDGE_TIMEOUT_MS, 15_000);
  assert.equal(MAX_BRIDGE_STDOUT_BYTES, 16_384);
  assert.equal(MAX_BRIDGE_STDERR_BYTES, 8_192);
  assert.equal(Buffer.from(POWERSHELL_BRIDGE_COMMAND, 'base64').toString('utf16le'), POWERSHELL_BRIDGE_SCRIPT);
  for (const marker of [
    'CredReadW',
    'CredWriteW',
    'CredDeleteW',
    'CredFree',
    'Add-Type -TypeDefinition $source',
    'TypeGeneric = 1',
    'PersistLocalMachine = 2',
  ]) {
    assert.equal(POWERSHELL_BRIDGE_SCRIPT.includes(marker), true, `the bridge program must contain ${marker}`);
  }
  assert.equal(POWERSHELL_BRIDGE_SCRIPT.includes('${'), false, 'the static program contains no interpolation');
  assert.deepEqual([...POWERSHELL_BRIDGE_ARGUMENTS].slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(POWERSHELL_BRIDGE_ARGUMENTS.includes('-ExecutionPolicy'), false, 'no execution-policy setting is loosened');
});

test('a write sends the secret only on stdin under a hidden static command', async () => {
  const secret = 'synthetic-bridge-secret-🔑';
  const fixture = bridgeWith(reply('{"ok":true}'));
  const result = await fixture.bridge.invoke(
    { operation: 'write', target: TARGET, secretBase64: base64(secret) },
    token(),
  );
  assert.deepEqual(result, { kind: 'done' });
  assert.equal(fixture.harness.calls.length, 1);
  const call = fixture.harness.calls[0]!;
  assert.equal(call.executable, EXECUTABLE);
  assert.deepEqual([...call.args], ['-NoProfile', '-NonInteractive', '-EncodedCommand', POWERSHELL_BRIDGE_COMMAND]);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.deepEqual([...call.options.stdio], ['pipe', 'pipe', 'pipe']);
  const surface = JSON.stringify({ executable: call.executable, args: call.args, options: call.options });
  assert.equal(surface.includes(secret), false, 'the secret never enters argv or spawn options');
  assert.equal(surface.includes(base64(secret)), false, 'not even the encoded secret enters argv');
  assert.equal(Object.hasOwn(call.options, 'env'), false, 'no environment override is passed at all');

  const child = fixture.harness.children[0]!;
  assert.deepEqual(JSON.parse(Buffer.concat(child.chunks).toString('utf8')), {
    op: 'write',
    target: TARGET,
    blob: base64(secret),
  });
  assert.equal(child.ended, true);
  assert.equal(child.rawChunks.length, 1, 'the request was written exactly once');
  assert.equal(
    child.rawChunks[0]!.every((byte) => byte === 0),
    true,
    'the per-request payload buffer is zeroed after use',
  );
  assert.equal(fixture.timers.pending(), 0, 'the timeout timer is cleared when the child closes');
});

test('read replies resolve to the secret or to absent; remove replies resolve to done', async () => {
  const secret = 'synthetic-read-secret';
  const present = bridgeWith(reply(JSON.stringify({ ok: true, found: true, blob: base64(secret) })));
  assert.deepEqual(await present.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token()), {
    kind: 'secret',
    secretBase64: base64(secret),
  });
  const absent = bridgeWith(reply('{"ok":true,"found":false}'));
  assert.deepEqual(await absent.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token()), {
    kind: 'absent',
  });
  const removed = bridgeWith(reply('{"ok":true}'));
  assert.deepEqual(await removed.bridge.invoke({ operation: 'remove', target: TARGET, secretBase64: null }, token()), {
    kind: 'done',
  });
});

// ---------------------------------------------------------------------------------------
// Failure projection
// ---------------------------------------------------------------------------------------

test('an error before the spawn event never settles the call before the child closes', async () => {
  const secret = 'synthetic-spawn-secret';
  const fixture = bridgeWith((child) => {
    child.closeOnKill = false;
    soon(() => child.emit('error', new Error(`spawn failed while handling ${secret}`)));
  });
  const promise = fixture.bridge.invoke(
    { operation: 'write', target: TARGET, secretBase64: base64(secret) },
    token(),
  );
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  assert.equal(settled, false, 'an error before `spawn` is not proof that no process exists');
  assert.equal(fixture.harness.children[0]!.signals.length, 1, 'termination is requested for the child');
  assert.equal(fixture.timers.pending(), 1, 'only the bounded timeout timer is armed while close is pending');
  fixture.harness.children[0]!.close(null);
  const error = await rejectsWithCode(promise, 'unavailable');
  assertNoSecret(error, secret);
  assert.equal(error.message, 'the OS credential vault bridge failed');
  assert.equal(fixture.timers.pending(), 0);
});

test('a synchronous spawn throw is a fixed sanitized error with no child', async () => {
  const secret = 'synthetic-throw-secret';
  const spawn: SpawnBridgeProcess = () => {
    throw new Error(`spawn threw ${secret}`);
  };
  const timers = createManualTimers();
  const bridge = new PowerShellCredentialBridge({
    platform: 'win32',
    executable: EXECUTABLE,
    spawn,
    setTimer: timers.setTimer,
  });
  const error = await rejectsWithCode(
    bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token()),
    'unavailable',
  );
  assertNoSecret(error, secret);
  assert.equal(timers.pending(), 0);
});

test('a non-zero or signal exit is unavailable and never a partial reply', async () => {
  const partial = 'synthetic-partial-secret';
  const valid = JSON.stringify({ ok: true, found: true, blob: base64(partial) });
  for (const code of [1, 3, null]) {
    const fixture = bridgeWith(reply(valid, code));
    const error = await rejectsWithCode(
      fixture.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token()),
      'unavailable',
    );
    assertNoSecret(error, partial);
  }
});

test('an unusable reply is unavailable and its text never surfaces', async () => {
  const secret = 'synthetic-reply-secret';
  const replies: readonly string[] = [
    'not json',
    '',
    '[]',
    '{}',
    JSON.stringify({ ok: false, code: 'unavailable', detail: secret }),
    JSON.stringify({ ok: 'yes' }),
    JSON.stringify({ ok: true, found: 'yes' }),
    JSON.stringify({ ok: true, found: true }),
    JSON.stringify({ ok: true, found: true, blob: `not-base64-${secret}` }),
    JSON.stringify({ ok: true, found: true, blob: '' }),
  ];
  for (const stdout of replies) {
    const fixture = bridgeWith(reply(stdout));
    const error = await rejectsWithCode(
      fixture.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token()),
      'unavailable',
    );
    assertNoSecret(error, secret);
  }
});

test('oversized stdout is refused, the child is killed and its bytes never surface', async () => {
  const marker = 'synthetic-oversize-marker';
  const filler = `${marker}${'x'.repeat(MAX_BRIDGE_STDOUT_BYTES + 1)}`;
  const fixture = bridgeWith((child) => {
    soon(() => {
      child.spawnEvent();
      child.sendStdout(filler);
    });
  });
  const error = await rejectsWithCode(
    fixture.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token()),
    'unavailable',
  );
  assertNoSecret(error, marker);
  assert.equal(fixture.harness.children[0]!.signals.length, 1, 'an oversized reply kills the child');
  assert.equal(fixture.timers.pending(), 0);
});

test('chunks after an overflow are discarded and wiped while close is delayed', async () => {
  const marker = 'synthetic-flood-marker';
  const crossing = Buffer.from(`${marker}${'x'.repeat(MAX_BRIDGE_STDOUT_BYTES)}`, 'utf8');
  const later = [Buffer.from('y'.repeat(64), 'utf8'), Buffer.from('z'.repeat(64), 'utf8')];
  const fixture = bridgeWith((child) => {
    child.closeOnKill = false;
    soon(() => {
      child.spawnEvent();
      child.sendStdoutBuffer(crossing);
      for (const chunk of later) {
        child.sendStdoutBuffer(chunk);
      }
    });
  });
  const promise = fixture.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token());
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  assert.equal(settled, false, 'overflow kills the child but never settles before close');
  assert.equal(fixture.harness.children[0]!.signals.length, 1, 'the flood is stopped exactly once');
  assert.equal(fixture.timers.pending(), 1, 'only the bounded timeout timer is armed while close is pending');
  assert.equal(crossing.every((byte) => byte === 0), true, 'the overflowing chunk was wiped, not retained');
  for (const chunk of later) {
    assert.equal(chunk.every((byte) => byte === 0), true, 'every chunk after the overflow was wiped');
  }
  fixture.harness.children[0]!.close(null);
  const error = await rejectsWithCode(promise, 'unavailable');
  assertNoSecret(error, marker);
  assert.equal(fixture.timers.pending(), 0, 'cleanup happens only once close arrived');
});

test('stderr is counted but never surfaced: noise is tolerated and oversize is refused', async () => {
  const marker = 'synthetic-stderr-marker';
  const noisy = bridgeWith((child) => {
    soon(() => {
      child.spawnEvent();
      child.sendStderr(`#< CLIXML progress noise ${marker}`);
      child.sendStdout('{"ok":true,"found":false}');
      child.close(0);
    });
  });
  const result = await noisy.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token());
  assert.deepEqual(result, { kind: 'absent' }, 'ordinary Windows PowerShell progress noise is harmless');
  assertNoSecret(JSON.stringify(result), marker);

  const flood = bridgeWith((child) => {
    soon(() => {
      child.spawnEvent();
      child.sendStderr(`${marker}${'e'.repeat(MAX_BRIDGE_STDERR_BYTES + 1)}`);
    });
  });
  const error = await rejectsWithCode(
    flood.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token()),
    'unavailable',
  );
  assertNoSecret(error, marker);
  assert.equal(flood.harness.children[0]!.signals.length, 1);
});

// ---------------------------------------------------------------------------------------
// Timeout, termination and cancellation
// ---------------------------------------------------------------------------------------

test('a timeout kills the child and settles only after the child closed', async () => {
  const fixture = bridgeWith(
    (child) => {
      soon(() => child.spawnEvent());
    },
    { timeoutMs: 5_000 },
  );
  const promise = fixture.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token());
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  fixture.timers.fire();
  assert.equal(settled, false, 'the call does not settle before the child closed');
  assert.equal(fixture.harness.children[0]!.signals.length, 1, 'the timed-out child was killed');
  const error = await rejectsWithCode(promise, 'unavailable');
  assert.match(String(error.message), /timed out/);
  assert.equal(settled, true);
  assert.equal(fixture.timers.pending(), 0, 'every timer was cleared');
});

test('a child that ignores the kill keeps the call pending until it finally closes', async () => {
  const fixture = bridgeWith(
    (child) => {
      child.closeOnKill = false;
      soon(() => child.spawnEvent());
    },
    { timeoutMs: 5_000 },
  );
  const promise = fixture.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token());
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  fixture.timers.fire();
  await tick();
  assert.equal(fixture.harness.children[0]!.signals.length, 1, 'termination was requested exactly once');
  assert.equal(settled, false, 'a killed child that has not closed is still a child that may exist');
  fixture.timers.fire();
  await tick();
  assert.equal(settled, false, 'elapsed time never settles a child that has not closed');
  fixture.harness.children[0]!.close(null);
  const error = await rejectsWithCode(promise, 'unavailable');
  assert.match(String(error.message), /timed out/);
  assert.equal(fixture.timers.pending(), 0, 'every timer is cleared once close confirms the child is gone');
});

test('a kill that returns false keeps a timed-out call pending until the child closes', async () => {
  const fixture = bridgeWith(
    (child) => {
      child.killOutcome = 'refused';
      soon(() => child.spawnEvent());
    },
    { timeoutMs: 5_000 },
  );
  const promise = fixture.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token());
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  fixture.timers.fire();
  await tick();
  assert.equal(fixture.harness.children[0]!.signals.length, 1, 'termination was requested');
  assert.equal(settled, false, 'a refused kill is not proof that the child is gone');
  fixture.timers.fire();
  await tick();
  assert.equal(settled, false, 'no elapsed grace period may settle the call');
  fixture.harness.children[0]!.close(null);
  const error = await rejectsWithCode(promise, 'unavailable');
  assert.match(String(error.message), /timed out/);
  assert.equal(fixture.timers.pending(), 0);
});

test('a kill that throws keeps a cancelled call pending until the child closes', async () => {
  const secret = 'synthetic-throwing-kill-secret';
  const fixture = bridgeWith((child) => {
    child.killOutcome = 'throw';
    soon(() => child.spawnEvent());
  });
  const source = createCancellationSource();
  const promise = fixture.bridge.invoke(
    { operation: 'write', target: TARGET, secretBase64: base64(secret) },
    source.token,
  );
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  source.cancel('disconnect');
  assert.equal(fixture.harness.children[0]!.signals.length, 1, 'termination was requested');
  assert.equal(settled, false, 'a throwing kill is not proof that the child is gone');
  fixture.timers.fire();
  await tick();
  assert.equal(settled, false, 'elapsed time never settles a child that has not closed');
  fixture.harness.children[0]!.close(null);
  const error = await rejectsWithCode(promise, 'cancelled');
  assert.equal(error instanceof DomainError, true, 'cancellation keeps its domain discriminant');
  assertNoSecret(error, secret);
  assert.equal(fixture.timers.pending(), 0);
});

test('cancellation kills and drains, and a cancelled call never resolves as success', async () => {
  const secret = 'synthetic-cancel-secret';
  const fixture = bridgeWith((child) => {
    soon(() => child.spawnEvent());
  });
  const source = createCancellationSource();
  const promise = fixture.bridge.invoke(
    { operation: 'write', target: TARGET, secretBase64: base64(secret) },
    source.token,
  );
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  source.cancel('disconnect');
  assert.equal(settled, false, 'settling waits for the killed child to close');
  assert.equal(fixture.harness.children[0]!.signals.length, 1);
  const error = await rejectsWithCode(promise, 'cancelled');
  assert.equal(error instanceof DomainError, true, 'cancellation keeps its domain discriminant');
  assertNoSecret(error, secret);
  assert.equal(fixture.timers.pending(), 0);

  const racing = bridgeWith((child) => {
    soon(() => {
      child.spawnEvent();
      child.sendStdout('{"ok":true}');
    });
  });
  const racingSource = createCancellationSource();
  const racingCall = racing.bridge.invoke(
    { operation: 'write', target: TARGET, secretBase64: base64(secret) },
    racingSource.token,
  );
  await tick();
  racingSource.cancel('disconnect raced the reply');
  await rejectsWithCode(racingCall, 'cancelled');
  assert.equal(racing.harness.children[0]!.signals.length, 1);

  const early = bridgeWith(() => {});
  const earlySource = createCancellationSource();
  earlySource.cancel();
  await rejectsWithCode(
    early.bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, earlySource.token),
    'cancelled',
  );
  assert.equal(early.harness.calls.length, 0, 'no child is spawned for an already-cancelled call');
});

// ---------------------------------------------------------------------------------------
// Executable resolution and request validation
// ---------------------------------------------------------------------------------------

test('the executable is resolved from the system Windows directory and fails closed when unusable', async () => {
  const fixture = bridgeWith(reply('{"ok":true,"found":false}'));
  const timers = createManualTimers();
  const bridge = new PowerShellCredentialBridge({
    platform: 'win32',
    systemRoot: 'C:\\Windows\\',
    spawn: fixture.harness.spawn,
    setTimer: timers.setTimer,
  });
  await bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token());
  assert.equal(fixture.harness.calls[0]!.executable, EXECUTABLE);

  const unusable = createSpawnHarness(() => {});
  const unusableTimers = createManualTimers();
  for (const systemRoot of ['relative', '\\\\server\\share', 'C:/Windows', 'C:\\Win\u0000dows', '']) {
    const broken = new PowerShellCredentialBridge({
      platform: 'win32',
      systemRoot,
      spawn: unusable.spawn,
      setTimer: unusableTimers.setTimer,
    });
    await rejectsWithCode(
      broken.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token()),
      'unavailable',
    );
  }
  assert.equal(unusable.calls.length, 0, 'an unresolvable executable fails closed instead of spawning');
});

test('a non-Windows platform refuses without spawning, even at construction time', async () => {
  const harness = createSpawnHarness(() => {});
  const timers = createManualTimers();
  const bridge = new PowerShellCredentialBridge({ platform: 'linux', spawn: harness.spawn, setTimer: timers.setTimer });
  await rejectsWithCode(bridge.invoke({ operation: 'read', target: TARGET, secretBase64: null }, token()), 'unsupported');
  assert.equal(harness.calls.length, 0);
});

test('malformed requests are refused before anything is spawned', async () => {
  const fixture = bridgeWith(reply('{"ok":true}'));
  const invalid: readonly Record<string, unknown>[] = [
    { operation: 'delete', target: TARGET, secretBase64: null },
    { operation: 'read', target: '', secretBase64: null },
    { operation: 'read', target: 'has space', secretBase64: null },
    { operation: 'read', target: 'a/b', secretBase64: null },
    { operation: 'read', target: 'a'.repeat(300), secretBase64: null },
    { operation: 'write', target: TARGET, secretBase64: null },
    { operation: 'write', target: TARGET, secretBase64: '' },
    { operation: 'write', target: TARGET, secretBase64: 'not base64!' },
    { operation: 'write', target: TARGET, secretBase64: 'A'.repeat(4_000) },
    { operation: 'read', target: TARGET, secretBase64: 'AAAA' },
  ];
  for (const request of invalid) {
    await rejectsWithCode(
      fixture.bridge.invoke(request as unknown as CredentialBridgeRequest, token()),
      'invalid_input',
    );
  }
  assert.equal(fixture.harness.calls.length, 0);
});

// ---------------------------------------------------------------------------------------
// Composed end-to-end over the emulated protocol
// ---------------------------------------------------------------------------------------

test('the composed vault and bridge agree on one namespaced target end to end', async () => {
  const emulated = createEmulatedCredentialManager();
  const timers = createManualTimers();
  const vault = createWindowsCredentialVault({
    dataDir: 'C:\\work\\data',
    platform: 'win32',
    bridge: new PowerShellCredentialBridge({
      platform: 'win32',
      executable: EXECUTABLE,
      spawn: emulated.spawn,
      setTimer: timers.setTimer,
    }),
  });
  assert.equal(await vault.read('luogu-session', token()), null);
  await vault.write('luogu-session', 'synthetic-end-to-end-🔑', token());
  assert.equal(await vault.read('luogu-session', token()), 'synthetic-end-to-end-🔑');
  await vault.remove('luogu-session', token());
  assert.equal(await vault.read('luogu-session', token()), null);
  assert.deepEqual(emulated.operations, ['read', 'write', 'read', 'remove', 'read']);
  assert.equal(new Set(emulated.targets).size, 1, 'one reference maps to exactly one target');
  assert.match(emulated.targets[0] ?? '', /^dsh-icpc-workbench\.[0-9a-f]{64}$/u);
});
