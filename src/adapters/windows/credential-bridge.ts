/**
 * Hidden Windows PowerShell credential bridge (Sprint 17b).
 *
 * ## Why a child process
 *
 * The Windows Credential Manager API is native. Node cannot call `CredReadW`/`CredWriteW` without
 * a third-party native addon, and this package deliberately has none. The bridge therefore runs a
 * **hidden `powershell.exe`** whose command is a static {@link POWERSHELL_BRIDGE_SCRIPT} encoded as
 * UTF-16LE base64 (`-EncodedCommand`), with `-NoProfile` and `-NonInteractive`. The command text is
 * a module constant: nothing is interpolated into it at call time, so no reference or secret can
 * reach a command line.
 *
 * ## Secret path
 *
 * A secret travels in exactly one direction and through exactly one channel: **stdin**, as a JSON
 * object whose `blob` field is base64 of the UTF-8 bytes. It never enters argv, an environment
 * variable, a temporary file or the current directory. stdout carries the reply (base64 secret for
 * a `read`) and is consumed privately by this module; stderr is never retained or surfaced, only
 * counted. Every failure — a spawn error, a non-zero exit, an unusable reply, an oversized stream,
 * a timeout, a cancellation — becomes a fixed sanitized {@link LocalCredentialVaultError}, so no
 * child text (which could quote a secret) can reach a caller, a log or a diagnostic.
 *
 * ## Lifecycle
 *
 * One invocation spawns one short-lived child and settles only on that child's `close` event, so no
 * child can still be writing after an `invoke` settles. A cancellation or timeout **requests**
 * termination (`SIGKILL`, i.e. `TerminateProcess` on Windows) and the call completes only once
 * `close` confirms the process is gone: the timeout bounds how long the child may run, never how
 * long the caller waits, and no timer reports the operation settled while a spawned child may still
 * exist. A kill that returns `false` or throws, and any error before the asynchronous `spawn`
 * event, are equally **not** evidence that no process exists; only a synchronous throw from `spawn`
 * is the no-child case. Cancellation never claims rollback: a `CredWriteW` that already committed
 * stays committed, and the operation still reports `cancelled`.
 *
 * ## Test seam
 *
 * `spawn` and `setTimer` are injectable, and `platform`/`executable`/`systemRoot` are overridable,
 * so the whole protocol — including the cancellation and drain paths — is exercised on any OS with
 * a fake child. Only the Windows-only roundtrip test needs a real Credential Manager.
 */
import { spawn } from 'node:child_process';
import { MAX_CREDENTIAL_SECRET_BYTES, LocalCredentialVaultError, credentialVaultCancelled } from '../../application/local-credential-vault.js';
import type { CancellationToken } from '../../domain/index.js';
import type { SetTimerFn } from '../platform/http.js';

/**
 * The complete bridge program, frozen as source text.
 *
 * It defines the four Credential Manager entry points by hand (`CredReadW`, `CredWriteW`,
 * `CredDeleteW`, `CredFree`) with `Add-Type`, uses generic credentials (`Type = 1`) with local
 * machine persistence (`Persist = 2`, this Windows user only, never roaming), frees the buffer
 * `CredReadW` allocates, clears every managed and unmanaged secret buffer it creates, and answers
 * with a fixed JSON reply. The script is intentionally self-contained: it reads no profile, no
 * script file, no environment and no argument.
 */
export const POWERSHELL_BRIDGE_SCRIPT = `$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

public static class DshVaultBridge
{
    private const uint TypeGeneric = 1;
    private const uint PersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree")]
    private static extern void CredFree(IntPtr buffer);

    public static byte[] Read(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, TypeGeneric, 0, out pointer))
        {
            if (Marshal.GetLastWin32Error() == ErrorNotFound) { return null; }
            throw new InvalidOperationException();
        }
        try
        {
            CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
            byte[] blob = new byte[credential.CredentialBlobSize];
            if (credential.CredentialBlobSize > 0 && credential.CredentialBlob != IntPtr.Zero)
            {
                Marshal.Copy(credential.CredentialBlob, blob, 0, (int)credential.CredentialBlobSize);
            }
            return blob;
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static void Write(string target, byte[] blob)
    {
        if (blob == null || blob.Length == 0) { throw new InvalidOperationException(); }
        IntPtr targetName = Marshal.StringToCoTaskMemUni(target);
        IntPtr blobPointer = Marshal.AllocHGlobal(blob.Length);
        try
        {
            Marshal.Copy(blob, 0, blobPointer, blob.Length);
            CREDENTIAL credential = new CREDENTIAL();
            credential.Type = TypeGeneric;
            credential.TargetName = targetName;
            credential.CredentialBlobSize = (uint)blob.Length;
            credential.CredentialBlob = blobPointer;
            credential.Persist = PersistLocalMachine;
            if (!CredWrite(ref credential, 0)) { throw new InvalidOperationException(); }
        }
        finally
        {
            for (int index = 0; index < blob.Length; index++) { Marshal.WriteByte(blobPointer, index, 0); }
            Marshal.FreeHGlobal(blobPointer);
            Marshal.FreeCoTaskMem(targetName);
        }
    }

    public static bool Delete(string target)
    {
        if (CredDelete(target, TypeGeneric, 0)) { return true; }
        if (Marshal.GetLastWin32Error() == ErrorNotFound) { return false; }
        throw new InvalidOperationException();
    }
}
'@

try { Add-Type -TypeDefinition $source } catch { [Console]::Out.Write('{"ok":false,"code":"unavailable"}'); exit 2 }
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $target = [string]$request.target
    if ([string]::IsNullOrEmpty($target)) { [Console]::Out.Write('{"ok":false,"code":"invalid_input"}') }
    else {
        switch ([string]$request.op) {
            'read' {
                $blob = [DshVaultBridge]::Read($target)
                if ($null -eq $blob) { [Console]::Out.Write('{"ok":true,"found":false}') }
                else {
                    try { [Console]::Out.Write('{"ok":true,"found":true,"blob":"' + [Convert]::ToBase64String($blob) + '"}') }
                    finally { [Array]::Clear($blob, 0, $blob.Length) }
                }
            }
            'write' {
                $blob = [Convert]::FromBase64String([string]$request.blob)
                try { [DshVaultBridge]::Write($target, $blob) } finally { [Array]::Clear($blob, 0, $blob.Length) }
                [Console]::Out.Write('{"ok":true}')
            }
            'remove' {
                [void][DshVaultBridge]::Delete($target)
                [Console]::Out.Write('{"ok":true}')
            }
            default { [Console]::Out.Write('{"ok":false,"code":"invalid_input"}') }
        }
    }
} catch {
    [Console]::Out.Write('{"ok":false,"code":"unavailable"}')
    exit 3
}
`;

/**
 * The bridge command as it is passed to `powershell.exe`.
 *
 * The encoding of the frozen script happens once at module load; no caller data participates.
 */
export const POWERSHELL_BRIDGE_COMMAND = Buffer.from(POWERSHELL_BRIDGE_SCRIPT, 'utf16le').toString('base64');

/** Bridge arguments: no secret, no script file and no execution-policy change. */
export const POWERSHELL_BRIDGE_ARGUMENTS: readonly string[] = Object.freeze([
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  POWERSHELL_BRIDGE_COMMAND,
]);

/**
 * Upper bound of the reply this bridge accepts on stdout (a 2560-byte secret is ~3.5 KiB).
 *
 * The bound is enforced **before** a chunk is retained: a chunk that would cross it is discarded
 * and wiped, and every later chunk is discarded and wiped too, so a child that ignores termination
 * cannot grow the retained buffer.
 */
export const MAX_BRIDGE_STDOUT_BYTES = 16_384;
/** Upper bound of stderr this bridge tolerates; the content is never read or surfaced. */
export const MAX_BRIDGE_STDERR_BYTES = 8_192;
/** How long the child may run before termination is requested; completion still awaits `close`. */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 15_000;

export type CredentialBridgeOperation = 'read' | 'write' | 'remove';

/** One bridge command. Only `target` and the base64 secret of a write ever reach the child. */
export interface CredentialBridgeRequest {
  readonly operation: CredentialBridgeOperation;
  /** Credential Manager target name built by the vault; never caller text. */
  readonly target: string;
  /** Base64 of the UTF-8 secret bytes for `write`; `null` for `read`/`remove`. */
  readonly secretBase64: string | null;
}

/**
 * What the child reported.
 *
 * `absent` is "no entry", not a failure. `done` is "the requested mutation is complete", which
 * includes deleting an entry that did not exist — that is what makes a repeated `remove` a
 * successful no-op.
 */
export type CredentialBridgeResult =
  | { readonly kind: 'secret'; readonly secretBase64: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'done' };

/**
 * The seam that turns one request into one answered child invocation.
 *
 * Implementations must treat a missing target as `absent` for a read and as `done` for a remove,
 * must never place a secret outside the stdin pipe, and must settle only after the child can no
 * longer write.
 */
export interface CredentialBridge {
  invoke(request: CredentialBridgeRequest, token: CancellationToken): Promise<CredentialBridgeResult>;
}

/** Minimal writable stream surface the bridge uses for a child's stdin. */
export interface BridgeWritableStream {
  write(chunk: Uint8Array, callback?: (error?: unknown) => void): unknown;
  end(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Minimal readable stream surface the bridge uses for a child's stdout/stderr. */
export interface BridgeReadableStream {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** One child process. `close` is the only event that may settle an invocation. */
export interface BridgeChildProcess {
  readonly stdin: BridgeWritableStream;
  readonly stdout: BridgeReadableStream;
  readonly stderr: BridgeReadableStream;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): unknown;
}

export interface BridgeSpawnOptions {
  readonly windowsHide: boolean;
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
  readonly shell: boolean;
}

/** Injectable spawn seam; the production default wraps `node:child_process.spawn`. */
export type SpawnBridgeProcess = (
  executable: string,
  args: readonly string[],
  options: BridgeSpawnOptions,
) => BridgeChildProcess;

const defaultSpawn: SpawnBridgeProcess = (executable, args, options) =>
  spawn(executable, [...args], {
    windowsHide: options.windowsHide,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  }) as unknown as BridgeChildProcess;

const BRIDGE_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_BRIDGE_SECRET_BASE64_CHARS = Math.ceil(MAX_CREDENTIAL_SECRET_BYTES / 3) * 4;
const WINDOWS_ROOT_PATTERN = /^[A-Za-z]:\\/u;
const PRINTABLE_ASCII = /^[\u0020-\u007e]+$/u;

export interface PowerShellCredentialBridgeOptions {
  /** Platform to honour; defaults to `process.platform`. Tests inject a value. */
  readonly platform?: string;
  /** Explicit `powershell.exe` path; defaults to the one under the system Windows directory. */
  readonly executable?: string | null;
  /** System Windows directory; defaults to `SystemRoot`/`windir` of this process. */
  readonly systemRoot?: string | null;
  /** How long the child may run before termination is requested; completion still awaits `close`. */
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly spawn?: SpawnBridgeProcess;
  readonly setTimer?: SetTimerFn;
}

type BridgeRunOutcome =
  | { readonly kind: 'exited'; readonly stdout: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: LocalCredentialVaultError };

function invalidBridgeInput(detail: string): LocalCredentialVaultError {
  return new LocalCredentialVaultError('invalid_input', detail);
}

function bridgeFailure(): LocalCredentialVaultError {
  return new LocalCredentialVaultError('unavailable', 'the OS credential vault bridge failed');
}

function bridgeTimeoutFailure(): LocalCredentialVaultError {
  return new LocalCredentialVaultError('unavailable', 'the OS credential vault bridge timed out');
}

function requireBridgeInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidBridgeInput(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/** Validate a request before anything is spawned; a caller mistake must never start a child. */
function requireBridgeRequest(request: CredentialBridgeRequest): void {
  if (!request || typeof request !== 'object') {
    throw invalidBridgeInput('a credential bridge request is required');
  }
  if (request.operation !== 'read' && request.operation !== 'write' && request.operation !== 'remove') {
    throw invalidBridgeInput('the credential bridge operation must be read, write or remove');
  }
  if (typeof request.target !== 'string' || !BRIDGE_TARGET_PATTERN.test(request.target)) {
    throw invalidBridgeInput('the credential bridge target is not a valid store target');
  }
  if (request.operation === 'write') {
    const blob = request.secretBase64;
    if (
      typeof blob !== 'string' ||
      blob.length === 0 ||
      blob.length > MAX_BRIDGE_SECRET_BASE64_CHARS ||
      !STRICT_BASE64.test(blob)
    ) {
      throw invalidBridgeInput('the credential bridge write payload is not a bounded base64 value');
    }
    return;
  }
  if (request.secretBase64 !== null) {
    throw invalidBridgeInput('only a credential bridge write may carry secret material');
  }
}

/** The sole stdin payload: JSON whose only non-ASCII-escaped field is base64. */
function buildBridgePayload(request: CredentialBridgeRequest): Buffer {
  const payload: Record<string, string> = { op: request.operation, target: request.target };
  if (request.operation === 'write') {
    payload.blob = request.secretBase64 ?? '';
  }
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk), 'utf8');
}

/**
 * Parse the child's fixed reply.
 *
 * The child is an untrusted boundary in the sense that matters here: a broken, replaced or
 * impersonated process can print anything, so only `ok`/`found`/`blob` with exact types are
 * accepted and everything else collapses to a fixed `unavailable`. A `code` field from the child
 * is deliberately ignored rather than forwarded as an error discriminant.
 */
function parseBridgeReply(operation: CredentialBridgeOperation, raw: string): CredentialBridgeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw bridgeFailure();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw bridgeFailure();
  }
  const reply = parsed as Record<string, unknown>;
  if (reply.ok !== true) {
    throw bridgeFailure();
  }
  if (operation !== 'read') {
    return { kind: 'done' };
  }
  if (reply.found === false) {
    return { kind: 'absent' };
  }
  if (reply.found !== true || typeof reply.blob !== 'string' || reply.blob.length === 0 || !STRICT_BASE64.test(reply.blob)) {
    throw bridgeFailure();
  }
  return { kind: 'secret', secretBase64: reply.blob };
}

/**
 * Hidden PowerShell credential bridge.
 *
 * Construction never touches the OS: on a non-Windows platform {@link invoke} reports
 * `unsupported` without spawning anything, so activating the plugin on an unsupported host is an
 * honest capability refusal rather than an activation failure.
 */
export class PowerShellCredentialBridge implements CredentialBridge {
  private readonly platform: string;
  private readonly executable: string | null;
  private readonly systemRoot: string | null;
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly spawnProcess: SpawnBridgeProcess;
  private readonly setTimer: SetTimerFn;

  constructor(options: PowerShellCredentialBridgeOptions = {}) {
    this.platform = typeof options.platform === 'string' && options.platform.length > 0 ? options.platform : process.platform;
    this.executable = typeof options.executable === 'string' && options.executable.length > 0 ? options.executable : null;
    const configuredRoot = options.systemRoot ?? process.env.SystemRoot ?? process.env.windir ?? null;
    this.systemRoot = typeof configuredRoot === 'string' && configuredRoot.length > 0 ? configuredRoot : null;
    this.timeoutMs = requireBridgeInteger(options.timeoutMs, DEFAULT_BRIDGE_TIMEOUT_MS, 1, 600_000, 'timeoutMs');
    this.maxStdoutBytes = requireBridgeInteger(options.maxStdoutBytes, MAX_BRIDGE_STDOUT_BYTES, 64, 1_048_576, 'maxStdoutBytes');
    this.maxStderrBytes = requireBridgeInteger(options.maxStderrBytes, MAX_BRIDGE_STDERR_BYTES, 64, 1_048_576, 'maxStderrBytes');
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    });
  }

  /**
   * Run one bridge command.
   *
   * Resolves with the child's normalized reply, or rejects with a fixed sanitized error:
   * `unsupported` on a non-Windows platform, `invalid_input` for a malformed request, `cancelled`
   * when the caller cancelled, and `unavailable` for every child/protocol/timeout failure.
   */
  async invoke(request: CredentialBridgeRequest, token: CancellationToken): Promise<CredentialBridgeResult> {
    requireBridgeRequest(request);
    if (this.platform !== 'win32') {
      throw new LocalCredentialVaultError('unsupported');
    }
    if (token.cancelled) {
      throw credentialVaultCancelled();
    }
    const payload = buildBridgePayload(request);
    const outcome = await this.run(payload, token);
    payload.fill(0);
    if (token.cancelled || outcome.kind === 'cancelled') {
      throw credentialVaultCancelled();
    }
    if (outcome.kind === 'failed') {
      throw outcome.error;
    }
    return parseBridgeReply(request.operation, outcome.stdout);
  }

  /** Resolve the hidden executable from the system Windows directory, never from PATH. */
  private resolveExecutable(): string {
    if (this.executable !== null) {
      return this.executable;
    }
    const root = this.systemRoot;
    if (
      root === null ||
      !WINDOWS_ROOT_PATTERN.test(root) ||
      !PRINTABLE_ASCII.test(root) ||
      root.includes('..') ||
      root.length > 512
    ) {
      throw new LocalCredentialVaultError('unavailable', 'the Windows system directory could not be resolved');
    }
    return `${root.replace(/[\\/]+$/u, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  }

  /**
   * Spawn, feed, drain and settle exactly one child.
   *
   * Once `spawn` has returned a child, the promise settles only on that child's `close` event. A
   * timeout or cancellation requests `SIGKILL` but never completes the call by itself, so a
   * cancelled write cannot still be executing when the caller regains control and a kill that was
   * refused or failed can never be mistaken for a drained child.
   */
  private run(payload: Buffer, token: CancellationToken): Promise<BridgeRunOutcome> {
    return new Promise<BridgeRunOutcome>((resolve) => {
      let child: BridgeChildProcess;
      try {
        child = this.spawnProcess(this.resolveExecutable(), POWERSHELL_BRIDGE_ARGUMENTS, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } catch {
        resolve({ kind: 'failed', error: bridgeFailure() });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const cleanups: Array<() => void> = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let killRequested = false;
      let cancelled = false;
      let timedOut = false;
      let overflow = false;
      let childFailed = false;
      let exitCode: number | null = null;

      const finish = (outcome: BridgeRunOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        for (const cleanup of cleanups.splice(0)) {
          cleanup();
        }
        payload.fill(0);
        for (const chunk of stdoutChunks) {
          chunk.fill(0);
        }
        resolve(outcome);
      };

      const addCleanup = (cleanup: () => void): void => {
        if (settled) {
          cleanup();
          return;
        }
        cleanups.push(cleanup);
      };

      const settle = (): void => {
        if (cancelled) {
          finish({ kind: 'cancelled' });
          return;
        }
        if (timedOut) {
          finish({ kind: 'failed', error: bridgeTimeoutFailure() });
          return;
        }
        if (overflow || childFailed || exitCode !== 0) {
          finish({ kind: 'failed', error: bridgeFailure() });
          return;
        }
        const collected = Buffer.concat(stdoutChunks, stdoutBytes);
        const stdout = collected.toString('utf8');
        collected.fill(0);
        finish({ kind: 'exited', stdout });
      };

      /**
       * Request termination of the child, at most once.
       *
       * A `false` return value or a throw means the signal was not delivered, which is **not**
       * evidence that the process is gone. Nothing settles here either way: only `close` may
       * complete the invocation.
       */
      const terminate = (): void => {
        if (killRequested) {
          return;
        }
        killRequested = true;
        try {
          if (child.kill('SIGKILL') === false) {
            childFailed = true;
          }
        } catch {
          childFailed = true;
        }
      };

      child.on('error', () => {
        // The `spawn` event is asynchronous, so an error here never proves that no process exists.
        // Termination is requested, but `close` still decides when the call may settle.
        childFailed = true;
        terminate();
      });
      child.on('close', (code: unknown) => {
        exitCode = typeof code === 'number' && Number.isInteger(code) ? code : null;
        settle();
      });

      child.stdout.on('data', (chunk: unknown) => {
        if (settled) {
          return;
        }
        const buffer = toBuffer(chunk);
        if (overflow) {
          // The cap was already crossed; nothing more may be retained, counted or accumulated.
          buffer.fill(0);
          return;
        }
        if (buffer.length > this.maxStdoutBytes - stdoutBytes) {
          // The hard cap is enforced before retention: this chunk is discarded and wiped, and every
          // later chunk is wiped as it arrives, however long the child ignores termination.
          overflow = true;
          buffer.fill(0);
          terminate();
          return;
        }
        stdoutBytes += buffer.length;
        stdoutChunks.push(buffer);
      });
      child.stderr.on('data', (chunk: unknown) => {
        if (settled || overflow) {
          return;
        }
        // stderr is counted, never retained: child diagnostics may quote anything.
        stderrBytes += toBuffer(chunk).length;
        if (stderrBytes > this.maxStderrBytes) {
          overflow = true;
          terminate();
        }
      });
      child.stdin.on('error', () => {
        childFailed = true;
      });

      try {
        child.stdin.write(payload, (error?: unknown) => {
          payload.fill(0);
          if (error) {
            childFailed = true;
          }
        });
        child.stdin.end();
      } catch {
        childFailed = true;
        terminate();
      }

      addCleanup(
        token.onCancel(() => {
          cancelled = true;
          terminate();
        }),
      );
      addCleanup(
        this.setTimer(() => {
          timedOut = true;
          terminate();
        }, this.timeoutMs),
      );
    });
  }
}

/** Build the hidden PowerShell credential bridge. */
export function createPowerShellCredentialBridge(
  options: PowerShellCredentialBridgeOptions = {},
): PowerShellCredentialBridge {
  return new PowerShellCredentialBridge(options);
}
