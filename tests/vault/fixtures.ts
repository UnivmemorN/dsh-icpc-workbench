/**
 * Synthetic fixtures for the Sprint 17b credential-vault tests.
 *
 * Everything here is generated in-process: an in-memory bridge, a fake child process and a manual
 * timer. No helper reads or writes a real credential, and no secret in the tests is a real one.
 */
import type {
  BridgeChildProcess,
  BridgeReadableStream,
  BridgeSpawnOptions,
  BridgeWritableStream,
  CredentialBridge,
  CredentialBridgeRequest,
  SpawnBridgeProcess,
} from '../../src/adapters/windows/index.js';
import type { SetTimerFn } from '../../src/adapters/platform/http.js';
import type { CancellationToken } from '../../src/domain/index.js';
import { DomainError } from '../../src/domain/index.js';

/** Schedule `run` after the current synchronous section, like a real child's I/O event would. */
export function soon(run: () => void): void {
  queueMicrotask(run);
}

/** Let every pending microtask and one macrotask run, so scheduled child events are delivered. */
export function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export interface MemoryBridge {
  readonly bridge: CredentialBridge;
  /** target → base64 secret; the emulated store. */
  readonly store: Map<string, string>;
  readonly calls: CredentialBridgeRequest[];
  /** Optional hook that runs before every operation; throw to simulate a broken/hostile backend. */
  beforeInvoke: ((request: CredentialBridgeRequest, token: CancellationToken) => void) | null;
}

/** In-memory vault backend with the same remove-is-idempotent semantics as the real bridge. */
export function createMemoryBridge(): MemoryBridge {
  const store = new Map<string, string>();
  const calls: CredentialBridgeRequest[] = [];
  const state: MemoryBridge = {
    store,
    calls,
    beforeInvoke: null,
    bridge: {
      async invoke(request, token) {
        calls.push(request);
        state.beforeInvoke?.(request, token);
        if (token.cancelled) {
          throw new DomainError('cancelled', 'operation cancelled');
        }
        if (request.operation === 'write') {
          store.set(request.target, request.secretBase64 ?? '');
          return { kind: 'done' };
        }
        if (request.operation === 'remove') {
          store.delete(request.target);
          return { kind: 'done' };
        }
        const secretBase64 = store.get(request.target);
        return secretBase64 === undefined ? { kind: 'absent' } : { kind: 'secret', secretBase64 };
      },
    },
  };
  return state;
}

/**
 * One fake child.
 *
 * Data written to stdin is snapshotted in `chunks` and also kept by reference in `rawChunks`, so the
 * bridge's buffer clearing is observable. `killOutcome` lets a test emulate a signal that is
 * refused or throws, without pretending that the process stopped.
 */
export class FakeChildProcess implements BridgeChildProcess {
  readonly chunks: Uint8Array[] = [];
  /** The exact buffers handed to `stdin.write`, so tests can prove the bridge wipes them. */
  readonly rawChunks: Uint8Array[] = [];
  readonly signals: string[] = [];
  readonly stdoutChunks: Uint8Array[] = [];
  readonly stderrChunks: Uint8Array[] = [];
  readonly stdin: BridgeWritableStream;
  readonly stdout: BridgeReadableStream;
  readonly stderr: BridgeReadableStream;
  ended = false;
  /** When true (the default), a delivered kill schedules a `close`, like a terminated real process. */
  closeOnKill = true;
  /**
   * What `kill` answers with.
   *
   * `delivered` behaves like a real `TerminateProcess`; `refused` returns `false` and `throw`
   * throws, and neither schedules a `close`, because a signal that was not delivered is not a
   * process that stopped.
   */
  killOutcome: 'delivered' | 'refused' | 'throw' = 'delivered';
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor() {
    this.stdin = {
      write: (chunk, callback) => {
        this.chunks.push(Buffer.from(chunk));
        this.rawChunks.push(chunk);
        callback?.();
        return true;
      },
      end: () => {
        this.ended = true;
        return this;
      },
      on: (event, listener) => {
        this.listen('stdin', event, listener);
        return this;
      },
    };
    this.stdout = {
      on: (event, listener) => {
        this.listen('stdout', event, listener);
        return this;
      },
    };
    this.stderr = {
      on: (event, listener) => {
        this.listen('stderr', event, listener);
        return this;
      },
    };
  }

  private listen(target: string, event: string, listener: (...args: unknown[]) => void): void {
    const key = `${target}\u0000${event}`;
    const existing = this.listeners.get(key) ?? new Set<(...args: unknown[]) => void>();
    existing.add(listener);
    this.listeners.set(key, existing);
  }

  private dispatch(target: string, event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(`${target}\u0000${event}`) ?? [])]) {
      listener(...args);
    }
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    this.listen('process', event, listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    this.dispatch('process', event, ...args);
  }

  kill(signal = 'SIGKILL'): unknown {
    this.signals.push(signal);
    if (this.killOutcome === 'throw') {
      throw new Error('the synthetic child rejected the kill signal');
    }
    if (this.killOutcome === 'refused') {
      return false;
    }
    if (this.closeOnKill) {
      soon(() => this.emit('close', null));
    }
    return true;
  }

  spawnEvent(): void {
    this.emit('spawn');
  }

  close(code: number | null): void {
    this.emit('close', code);
  }

  /** Deliver a stdout chunk the test owns; a discarded chunk is wiped in place by the bridge. */
  sendStdoutBuffer(bytes: Buffer): void {
    this.stdoutChunks.push(Buffer.from(bytes));
    this.dispatch('stdout', 'data', bytes);
  }

  /** Deliver stdout bytes; the listener receives a buffer the bridge is free to clear. */
  sendStdout(text: string): void {
    this.sendStdoutBuffer(Buffer.from(text, 'utf8'));
  }

  /** Deliver stderr bytes; the content is kept only so tests can prove it never surfaces. */
  sendStderr(text: string): void {
    const bytes = Buffer.from(text, 'utf8');
    this.stderrChunks.push(Buffer.from(bytes));
    this.dispatch('stderr', 'data', bytes);
  }
}

export interface SpawnCall {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: BridgeSpawnOptions;
}

export interface SpawnHarness {
  readonly spawn: SpawnBridgeProcess;
  readonly children: FakeChildProcess[];
  readonly calls: SpawnCall[];
}

/**
 * Spawn seam whose behavior is supplied per test. The behavior runs synchronously inside `spawn`
 * and is expected to schedule its child events with {@link soon}, because the bridge attaches its
 * listeners immediately after `spawn` returns.
 */
export function createSpawnHarness(behavior: (child: FakeChildProcess, index: number) => void): SpawnHarness {
  const children: FakeChildProcess[] = [];
  const calls: SpawnCall[] = [];
  const spawn: SpawnBridgeProcess = (executable, args, options) => {
    const child = new FakeChildProcess();
    children.push(child);
    calls.push({ executable, args: [...args], options });
    behavior(child, children.length - 1);
    return child;
  };
  return { spawn, children, calls };
}

export interface ManualTimers {
  readonly setTimer: SetTimerFn;
  /** Fire every timer registered so far; timers registered while firing wait for the next call. */
  fire(): void;
  pending(): number;
}

/** Deterministic replacement for real timers, so timeout and kill-grace paths are exact. */
export function createManualTimers(): ManualTimers {
  const timers = new Set<() => void>();
  return {
    setTimer(callback) {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
    fire() {
      for (const callback of [...timers]) {
        timers.delete(callback);
        callback();
      }
    },
    pending() {
      return timers.size;
    },
  };
}

export interface EmulatedCredentialManager {
  readonly spawn: SpawnBridgeProcess;
  readonly store: Map<string, string>;
  /** Every target the fake bridge was asked to operate on, in order. */
  readonly targets: string[];
  readonly operations: string[];
}

/**
 * A fake `powershell.exe` that speaks the real bridge protocol against an in-memory store.
 *
 * This is what lets the composed `WindowsCredentialVault` + `PowerShellCredentialBridge` pair be
 * tested end to end on any OS: the protocol, the target and the secret encoding are all real, only
 * the OS call is emulated.
 */
export function createEmulatedCredentialManager(): EmulatedCredentialManager {
  const store = new Map<string, string>();
  const targets: string[] = [];
  const operations: string[] = [];
  const harness = createSpawnHarness((child) => {
    soon(() => {
      child.spawnEvent();
      let reply = '{"ok":false,"code":"unavailable"}';
      let code = 0;
      try {
        const request = JSON.parse(Buffer.concat(child.chunks).toString('utf8')) as Record<string, unknown>;
        const operation = String(request.op ?? '');
        const target = String(request.target ?? '');
        operations.push(operation);
        targets.push(target);
        if (operation === 'read') {
          const blob = store.get(target);
          reply = blob === undefined ? '{"ok":true,"found":false}' : JSON.stringify({ ok: true, found: true, blob });
        } else if (operation === 'write') {
          store.set(target, String(request.blob ?? ''));
          reply = '{"ok":true}';
        } else if (operation === 'remove') {
          store.delete(target);
          reply = '{"ok":true}';
        }
      } catch {
        code = 1;
      }
      child.sendStdout(reply);
      child.close(code);
    });
  });
  return { spawn: harness.spawn, store, targets, operations };
}
