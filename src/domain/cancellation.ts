/**
 * Cancellation primitive.
 *
 * Domain and application code must not depend on a runtime's AbortController, so ports take
 * this minimal token instead: adapters bridge it to `AbortSignal`, tests can drive it
 * directly, and every long operation has one uniform way to observe cancellation.
 * Implementations are synchronous and side-effect free apart from notifying listeners.
 */
import { DomainError } from './errors.js';

export interface CancellationToken {
  readonly cancelled: boolean;
  /** Optional human-readable reason supplied by the caller of `cancel`. */
  readonly reason: string | null;
  /** Throws a `cancelled` {@link DomainError} when cancellation was requested. */
  throwIfCancelled(): void;
  /** Register a listener; returns an unsubscribe function. Fires immediately if already cancelled. */
  onCancel(listener: () => void): () => void;
}

export interface CancellationSource {
  readonly token: CancellationToken;
  cancel(reason?: string): void;
}

/** True when the token has been cancelled. */
export function isCancelled(token: CancellationToken | null | undefined): boolean {
  return token?.cancelled === true;
}

/** Throw a `cancelled` DomainError when cancellation has been requested. */
export function throwIfCancelled(token: CancellationToken | null | undefined): void {
  token?.throwIfCancelled();
}

/** Create a cancellation source plus its token. */
export function createCancellationSource(): CancellationSource {
  let cancelled = false;
  let reason: string | null = null;
  const listeners = new Set<() => void>();

  const token: CancellationToken = {
    get cancelled() {
      return cancelled;
    },
    get reason() {
      return reason;
    },
    throwIfCancelled() {
      if (cancelled) {
        throw new DomainError('cancelled', reason ? `operation cancelled: ${reason}` : 'operation cancelled', {
          reason,
        });
      }
    },
    onCancel(listener) {
      if (cancelled) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    token,
    cancel(cancelReason?: string) {
      if (cancelled) {
        return;
      }
      cancelled = true;
      reason = cancelReason?.trim() || null;
      for (const listener of [...listeners]) {
        listener();
      }
      listeners.clear();
    },
  };
}
