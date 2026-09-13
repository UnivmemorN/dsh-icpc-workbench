/**
 * Windows Credential Manager vault adapter (Sprint 17b).
 *
 * ## Target namespacing
 *
 * A credential is addressed by a target name of the form
 * `dsh-icpc-workbench.<sha256 hex>` where the digest covers a version separator, the canonical
 * workspace data directory and the opaque reference. Consequences that matter:
 *
 * - another workspace (a different data directory) derives a different target, so it can never
 *   read or overwrite this workspace's credential;
 * - an arbitrary Windows credential cannot be addressed at all, because a caller can supply only
 *   the reference — never the target — and the digest makes every guess a different entry;
 * - the target itself discloses neither the data directory nor the reference, and there is no
 *   enumeration API anywhere in the port;
 * - the same `(dataDir, reference)` pair always derives the same target, so a restart finds what a
 *   previous run stored without keeping a lookup table.
 *
 * Canonicalization is explicit and deliberately conservative: the data directory must be an
 * absolute Windows path, is normalized with `path.win32` (separators, `.` and `..`) and is
 * case-folded, because Windows file names are case-insensitive. 8.3 short names, symlinks and
 * extended-length prefixes are **not** resolved; two such spellings of one directory would derive
 * two targets. That can only fail to find a credential, never address someone else's.
 *
 * ## Storage shape
 *
 * One generic credential (`Type = 1`) per reference, persistence `2` (local machine, i.e. this
 * Windows user, never roaming), with the secret as the credential blob. Values are never split
 * across several credentials to work around the 2560-byte blob cap: a longer value is refused with
 * `invalid_input`. There is no plaintext or alternate-file fallback.
 */
import { createHash } from 'node:crypto';
import { win32 as windowsPath } from 'node:path';
import {
  MAX_CREDENTIAL_SECRET_BYTES,
  LocalCredentialVaultError,
  credentialVaultCancelled,
  requireCredentialReference,
  requireCredentialSecret,
  type LocalCredentialVault,
  type LocalCredentialVaultCapabilities,
  type LocalCredentialVaultErrorCode,
} from '../../application/local-credential-vault.js';
import { DomainError, type CancellationToken } from '../../domain/index.js';
import {
  PowerShellCredentialBridge,
  type CredentialBridge,
  type CredentialBridgeRequest,
  type CredentialBridgeResult,
} from './credential-bridge.js';

/** Fixed prefix of every Windows Credential Manager target this plugin owns. */
export const CREDENTIAL_TARGET_PREFIX = 'dsh-icpc-workbench';

/** Digest domain separator; bumping it retires every previously derived target. */
const TARGET_SEPARATOR = 'dsh-icpc-workbench/credential-target/v1';
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
/** Drive-absolute (`C:\`, `C:/`) or a complete UNC share (`\\server\share`). */
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/])/u;
const UNSAFE_PATH_TEXT = /[\u0000-\u001f\u007f]/u;
const MAX_DATA_DIR_CHARS = 4096;

function invalidInput(detail: string): LocalCredentialVaultError {
  return new LocalCredentialVaultError('invalid_input', detail);
}

/**
 * Canonical namespace of one workspace data directory.
 *
 * Requires an absolute Windows path (`C:\...` or a UNC share) and returns a normalized,
 * case-folded form. Refused: a non-string, an empty or over-long value, a relative path, a
 * POSIX-rooted path such as `/data` (no drive, so it is not a stable workspace identity) and any
 * control character.
 */
export function canonicalCredentialNamespace(dataDir: string): string {
  if (typeof dataDir !== 'string' || dataDir.length === 0 || dataDir.length > MAX_DATA_DIR_CHARS) {
    throw invalidInput('the credential vault data directory must be a bounded non-empty string');
  }
  if (UNSAFE_PATH_TEXT.test(dataDir)) {
    throw invalidInput('the credential vault data directory contains control characters');
  }
  if (!WINDOWS_ABSOLUTE_PATH.test(dataDir)) {
    throw invalidInput('the credential vault data directory must be an absolute Windows path');
  }
  const normalized = windowsPath.normalize(dataDir);
  const withoutTrailingSeparator = normalized.length > 3 ? normalized.replace(/\\+$/u, '') : normalized;
  return withoutTrailingSeparator.toLowerCase();
}

/**
 * Derived Credential Manager target of one reference inside one canonical namespace.
 *
 * The reference is validated first, then hashed together with the namespace, so a malicious
 * reference cannot address another entry even if it looks like a target name. The digest is
 * domain-separated and versioned.
 */
export function credentialTargetName(namespace: string, reference: string): string {
  if (typeof namespace !== 'string' || namespace.length === 0 || namespace.length > MAX_DATA_DIR_CHARS) {
    throw invalidInput('the credential vault namespace must be a bounded non-empty string');
  }
  const validated = requireCredentialReference(reference);
  const digest = createHash('sha256')
    .update(TARGET_SEPARATOR, 'utf8')
    .update('\u0000', 'utf8')
    .update(namespace, 'utf8')
    .update('\u0000', 'utf8')
    .update(validated, 'utf8')
    .digest('hex');
  return `${CREDENTIAL_TARGET_PREFIX}.${digest}`;
}

export interface WindowsCredentialVaultOptions {
  /** Workspace data directory that namespaces every credential. */
  readonly dataDir: string;
  /** Platform to honour; defaults to `process.platform`. Tests inject a value. */
  readonly platform?: string;
  /** Backend seam; defaults to the hidden PowerShell bridge. */
  readonly bridge?: CredentialBridge;
}

/**
 * Sanitize anything the injected backend throws.
 *
 * The backend is a boundary the vault does not fully control — it may be replaced, wrapped or
 * broken — so its text is never forwarded. A `cancelled` domain error keeps its discriminant as
 * the fixed cancellation error; a vault error keeps only its allow-listed code; everything else is
 * a fixed `unavailable`. A backend message quoting a secret therefore cannot reach a caller.
 */
function sanitizeVaultFailure(cause: unknown): never {
  if (cause instanceof DomainError && cause.code === 'cancelled') {
    throw credentialVaultCancelled();
  }
  if (cause instanceof LocalCredentialVaultError) {
    const code = (cause as { readonly code?: unknown }).code;
    if (code === 'unsupported' || code === 'invalid_input' || code === 'unavailable') {
      throw new LocalCredentialVaultError(code as LocalCredentialVaultErrorCode);
    }
  }
  throw new LocalCredentialVaultError('unavailable');
}

/** Strictly decode a stored base64 blob into text; a corrupt value is a failure, never a guess. */
function decodeStoredSecret(secretBase64: unknown): string {
  if (typeof secretBase64 !== 'string' || secretBase64.length === 0 || !STRICT_BASE64.test(secretBase64)) {
    throw new LocalCredentialVaultError('unavailable', 'the credential backend answered an unusable read result');
  }
  const bytes = Buffer.from(secretBase64, 'base64');
  try {
    if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_SECRET_BYTES) {
      throw new LocalCredentialVaultError('unavailable', 'the stored credential exceeds the supported capacity');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    if (cause instanceof LocalCredentialVaultError) {
      throw cause;
    }
    throw new LocalCredentialVaultError('unavailable', 'the stored credential is not valid UTF-8 text');
  } finally {
    bytes.fill(0);
  }
}

/**
 * OS-protected credential vault backed by the Windows Credential Manager.
 *
 * Construction is inert: on a platform other than `win32` the instance reports an unimplemented
 * capability and every operation rejects with `unsupported`, without a bridge ever being consulted
 * and without throwing during activation. On Windows the data directory is validated eagerly, so a
 * misconfigured workspace fails loudly at composition time instead of silently namespacing
 * credentials somewhere unexpected.
 */
export class WindowsCredentialVault implements LocalCredentialVault {
  private readonly platform: string;
  private readonly supported: boolean;
  private readonly namespace: string | null;
  private readonly bridge: CredentialBridge | null;

  constructor(options: WindowsCredentialVaultOptions) {
    if (!options || typeof options !== 'object') {
      throw invalidInput('Windows credential vault options are required');
    }
    this.platform =
      typeof options.platform === 'string' && options.platform.length > 0 ? options.platform : process.platform;
    if (this.platform !== 'win32') {
      this.supported = false;
      this.namespace = null;
      this.bridge = null;
      return;
    }
    if (options.bridge !== undefined && typeof options.bridge.invoke !== 'function') {
      throw invalidInput('the credential vault bridge must expose invoke(request, token)');
    }
    this.namespace = canonicalCredentialNamespace(options.dataDir);
    this.bridge = options.bridge ?? new PowerShellCredentialBridge({ platform: this.platform });
    this.supported = true;
  }

  /** Honest capability statement; never advertises a backend the platform does not have. */
  capabilities(): LocalCredentialVaultCapabilities {
    if (!this.supported) {
      return {
        implemented: false,
        platform: this.platform,
        notes: [
          'This platform has no OS-protected credential backend in this plugin build, so connecting an account is unavailable here.',
        ],
      };
    }
    return {
      implemented: true,
      platform: this.platform,
      notes: [
        'Windows Credential Manager generic credentials (CredReadW/CredWriteW/CredDeleteW) with local machine persistence, scoped to this Windows user; no plaintext fallback and no reference enumeration.',
        'Credential targets are namespaced by the workspace data directory and the opaque reference, so another workspace or an arbitrary Windows credential cannot be addressed.',
      ],
    };
  }

  /**
   * Read the secret under `reference`, or `null` when nothing is stored.
   *
   * The resolved string is secret material for the credential-consuming adapter only; it must not
   * be copied into a DTO, a status object, a log line or a model payload.
   */
  async read(reference: string, token: CancellationToken): Promise<string | null> {
    const target = this.targetFor(reference);
    const result = await this.invokeBridge({ operation: 'read', target, secretBase64: null }, token);
    if (result.kind === 'absent') {
      return null;
    }
    if (result.kind !== 'secret') {
      throw new LocalCredentialVaultError('unavailable', 'the credential backend answered an unusable read result');
    }
    return decodeStoredSecret(result.secretBase64);
  }

  /**
   * Store (or replace) the secret under `reference`.
   *
   * The value is validated as UTF-8 **bytes** against the store capacity before anything is
   * written. Cancellation never rolls back: if the native write already committed, the operation
   * still reports `cancelled` and the stored value may have changed.
   */
  async write(reference: string, secret: string, token: CancellationToken): Promise<void> {
    const target = this.targetFor(reference);
    const bytes = requireCredentialSecret(secret);
    try {
      const copy = Buffer.from(bytes);
      let secretBase64: string;
      try {
        secretBase64 = copy.toString('base64');
      } finally {
        copy.fill(0);
      }
      const result = await this.invokeBridge({ operation: 'write', target, secretBase64 }, token);
      if (result.kind !== 'done') {
        throw new LocalCredentialVaultError('unavailable', 'the credential backend answered an unusable write result');
      }
    } finally {
      bytes.fill(0);
    }
  }

  /** Remove the entry under `reference`; a missing entry is a successful no-op. */
  async remove(reference: string, token: CancellationToken): Promise<void> {
    const target = this.targetFor(reference);
    const result = await this.invokeBridge({ operation: 'remove', target, secretBase64: null }, token);
    if (result.kind !== 'done') {
      throw new LocalCredentialVaultError('unavailable', 'the credential backend answered an unusable remove result');
    }
  }

  /** Validate the reference and derive its target, or refuse the operation. */
  private targetFor(reference: string): string {
    if (!this.supported || this.namespace === null) {
      throw new LocalCredentialVaultError('unsupported');
    }
    requireCredentialReference(reference);
    return credentialTargetName(this.namespace, reference);
  }

  /** One sanitized bridge call; cancellation is checked before and after the backend runs. */
  private async invokeBridge(
    request: CredentialBridgeRequest,
    token: CancellationToken,
  ): Promise<CredentialBridgeResult> {
    const bridge = this.bridge;
    if (bridge === null) {
      throw new LocalCredentialVaultError('unsupported');
    }
    if (token.cancelled) {
      throw credentialVaultCancelled();
    }
    let result: CredentialBridgeResult;
    try {
      result = await bridge.invoke(request, token);
    } catch (cause) {
      sanitizeVaultFailure(cause);
    }
    if (token.cancelled) {
      throw credentialVaultCancelled();
    }
    return result;
  }
}

/** Build the Windows credential vault. */
export function createWindowsCredentialVault(options: WindowsCredentialVaultOptions): WindowsCredentialVault {
  return new WindowsCredentialVault(options);
}
