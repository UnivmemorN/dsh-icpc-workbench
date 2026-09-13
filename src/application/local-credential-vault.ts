/**
 * Local OS-protected credential vault port (Sprint 17b).
 *
 * This module is the seam between the application/plugin layers and an OS credential store such
 * as the Windows Credential Manager. It carries only an **opaque reference** in and a **secret
 * string** out; it never exposes a backend type, a file path, a registry location or a native
 * handle.
 *
 * ## What a caller may and may not do with `read`
 *
 * `read` returns the stored secret **only to the credential-consuming adapter** that needs it for
 * one authenticated request (for example the Luogu session provider). The returned string must
 * never be placed into a business-API DTO, a progress/status object, a log line, a model prompt or
 * a durable record: the UI and the model layers address credentials through the account metadata
 * they already hold, never through secret material. Implementations must keep the secret out of
 * every error, and this port deliberately offers **no enumeration**: a caller can address exactly
 * the references it already knows and cannot list what exists.
 *
 * ## Failure contract
 *
 * - A missing entry is not an error: `read` resolves `null` and `remove` resolves normally, so
 *   disconnecting an account twice is safe.
 * - Failures are {@link LocalCredentialVaultError} with one of three sanitized codes
 *   (`unsupported`, `invalid_input`, `unavailable`). The messages are fixed, so no backend text,
 *   secret or path can leak through them.
 * - Cancellation is the shared control-flow signal, not a vault failure: it rejects with a
 *   `cancelled` {@link DomainError} exactly like every other cancellable operation in this
 *   codebase, so callers keep one cancellation discriminant.
 * - Cancellation never claims rollback. If a `write` or `remove` was already committed by the OS
 *   when cancellation arrived, the operation still reports `cancelled` and the stored state may
 *   have changed; callers that need certainty re-read after cancelling.
 */
import { DomainError, type CancellationToken } from '../domain/index.js';

/** Stable, sanitized failure codes of a local credential vault. */
export type LocalCredentialVaultErrorCode = 'unsupported' | 'invalid_input' | 'unavailable';

export const LOCAL_CREDENTIAL_VAULT_ERROR_CODES: readonly LocalCredentialVaultErrorCode[] = [
  'unsupported',
  'invalid_input',
  'unavailable',
];

/**
 * Fixed failure text per code.
 *
 * The strings are constants by design: an error crossing this port can never quote a credential
 * reference, a secret byte, a target name, a path or a backend message.
 */
const VAULT_ERROR_MESSAGES: Readonly<Record<LocalCredentialVaultErrorCode, string>> = {
  unsupported: 'the OS credential vault is not supported on this platform',
  invalid_input: 'the credential request was rejected',
  unavailable: 'the OS credential vault operation failed',
};

const MAX_ERROR_DETAIL_CHARS = 160;
const UNSAFE_ERROR_TEXT = /[\u0000-\u001f\u007f]+/gu;
const WHITESPACE_RUN = /\s+/gu;

/**
 * Sanitize an optional human-readable reason.
 *
 * Only fixed, secret-free strings are passed internally; the sanitization is defense in depth so a
 * future caller cannot smuggle control characters or an unbounded message into a surfaced error.
 */
function sanitizeDetail(detail: string | undefined, fallback: string): string {
  if (typeof detail !== 'string') {
    return fallback;
  }
  const cleaned = detail.replace(UNSAFE_ERROR_TEXT, ' ').replace(WHITESPACE_RUN, ' ').trim();
  if (cleaned.length === 0) {
    return fallback;
  }
  return cleaned.length <= MAX_ERROR_DETAIL_CHARS ? cleaned : `${cleaned.slice(0, MAX_ERROR_DETAIL_CHARS)}...`;
}

/**
 * One sanitized vault failure.
 *
 * `code` is the contract callers branch on; construction replaces the message with the fixed
 * per-code text unless a short sanitized reason is supplied.
 */
export class LocalCredentialVaultError extends Error {
  readonly code: LocalCredentialVaultErrorCode;

  constructor(code: LocalCredentialVaultErrorCode, detail?: string) {
    const message = sanitizeDetail(detail, VAULT_ERROR_MESSAGES[code]);
    super(message);
    this.name = 'LocalCredentialVaultError';
    this.code = code;
  }
}

/**
 * The single cancellation failure every vault operation rejects with.
 *
 * A fixed message is used instead of the caller's reason so a caller-supplied string can never be
 * echoed back through a shared error path.
 */
export function credentialVaultCancelled(): DomainError {
  return new DomainError('cancelled', 'operation cancelled');
}

/** What a vault implementation can actually do; never advertise more than is implemented. */
export interface LocalCredentialVaultCapabilities {
  /** False when this platform has no supported OS-protected backend. */
  readonly implemented: boolean;
  /** Platform the implementation resolved, e.g. `win32`. */
  readonly platform: string;
  readonly notes: readonly string[];
}

/**
 * OS-protected storage for one secret string per opaque reference.
 *
 * Implementations must:
 * - validate a reference and a secret **before** touching the backend
 *   ({@link requireCredentialReference}, {@link requireCredentialSecret});
 * - return the secret only to their direct caller and keep it out of results, errors and logs;
 * - treat a missing entry as `null` (read) or a no-op (remove);
 * - observe the caller's {@link CancellationToken} and reject with `cancelled`;
 * - never fall back to a plaintext file, an environment variable or a command-line argument.
 */
export interface LocalCredentialVault {
  capabilities(): LocalCredentialVaultCapabilities;
  /**
   * Read the secret stored under `reference`.
   *
   * Resolves `null` when nothing is stored; rejects with `cancelled`, `invalid_input`,
   * `unsupported` or `unavailable`. The resolved string is secret material: it must stay inside
   * the credential-consuming adapter and out of DTOs, logs and model payloads.
   */
  read(reference: string, token: CancellationToken): Promise<string | null>;
  /** Store (or replace) the secret under `reference`. */
  write(reference: string, secret: string, token: CancellationToken): Promise<void>;
  /** Remove the entry under `reference`; removing a missing entry is a successful no-op. */
  remove(reference: string, token: CancellationToken): Promise<void>;
}

/** Longest accepted opaque credential reference. */
export const MAX_CREDENTIAL_REFERENCE_CHARS = 128;

/**
 * Accepted opaque references: `[A-Za-z0-9]` followed by at most 127 characters from
 * `[A-Za-z0-9._:-]`.
 *
 * The shape is deliberately narrow. A reference is *not* a path, a URL or a credential target: it
 * cannot contain a separator, a quote, whitespace or a control character, so a malicious reference
 * can never address another store entry, escape a namespace or smuggle text into the backend
 * protocol. References are hashed together with the workspace namespace before they are used as a
 * target, so even a reference that mimics a target name addresses only its own digest.
 */
export const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Validate an opaque credential reference, or throw `invalid_input`. */
export function requireCredentialReference(reference: unknown): string {
  if (typeof reference !== 'string' || !CREDENTIAL_REFERENCE_PATTERN.test(reference)) {
    throw new LocalCredentialVaultError(
      'invalid_input',
      'the credential reference must be 1-128 characters of [A-Za-z0-9._:-] starting with a letter or digit',
    );
  }
  return reference;
}

/**
 * Windows `CREDENTIALW.CredentialBlob` capacity for a generic credential, in bytes.
 *
 * The limit is a property of the OS store, not of the secret's character count, so every
 * implementation validates the **actual UTF-8 byte length** before it writes. A value is never
 * split across several entries to work around the cap.
 */
export const MAX_CREDENTIAL_SECRET_BYTES = 2560;

/**
 * Validate a secret for storage and return its exact UTF-8 bytes.
 *
 * Refused: a non-string, an empty string, a value whose UTF-8 encoding exceeds
 * {@link MAX_CREDENTIAL_SECRET_BYTES}, and text whose encoding does not round-trip (an unpaired
 * surrogate would otherwise be silently replaced on read). The caller owns the returned array and
 * must clear it after use; the vault adapter does that in a `finally`.
 */
export function requireCredentialSecret(secret: unknown): Uint8Array {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new LocalCredentialVaultError('invalid_input', 'the credential secret must be a non-empty string');
  }
  const bytes = new TextEncoder().encode(secret);
  try {
    if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_SECRET_BYTES) {
      throw new LocalCredentialVaultError(
        'invalid_input',
        `the credential secret must be at most ${MAX_CREDENTIAL_SECRET_BYTES} UTF-8 bytes`,
      );
    }
    // A lone surrogate encodes to U+FFFD, so reading it back would silently change the secret.
    if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== secret) {
      throw new LocalCredentialVaultError('invalid_input', 'the credential secret is not valid Unicode text');
    }
    return bytes;
  } catch (cause) {
    bytes.fill(0);
    throw cause;
  }
}
