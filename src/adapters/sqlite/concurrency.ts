/**
 * Connection serialization for the SQLite store.
 *
 * `node:sqlite` is synchronous, but the port's `transaction()` takes an **async** callback:
 * without serialization the callback's `await` points would let an unrelated `save…` call
 * run on the same connection and be committed or rolled back with the transaction it never
 * asked to join. Two mechanisms keep that impossible:
 *
 * - a {@link FifoMutex} that admits one connection-owning operation at a time, in call
 *   order, so a queued write can never interleave with a transaction;
 * - an {@link AsyncLocalStorage} transaction scope, so operations *inside* the transaction
 *   callback reuse the connection directly (no deadlock) while operations invoked after the
 *   transaction finished are rejected loudly instead of writing outside their transaction.
 *
 * The mutex is never held across `await` by anything except the transaction callback itself,
 * so a callback that awaits unrelated work simply keeps its exclusive turn — it cannot block
 * another operation on the same store, because such an operation must wait for the
 * transaction to end.
 *
 * There is deliberately **no savepoint support**. Parallel `transaction()` calls inside one
 * callback would share the single connection and could release or roll back each other's
 * savepoints, so a nested `transaction()` call is rejected (`nested_transaction`) before its
 * callback executes instead of being approximated. Ordinary reads and writes invoked inside a
 * callback still run on the owned connection and observe the transaction's own writes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Marks the transaction an operation is running inside. */
export interface TransactionScope {
  /** The store that owns the connection; a scope from another store must not be reused. */
  readonly store: object;
  /** False once the owner committed or rolled back: later operations must not reuse it. */
  active: boolean;
}

/** FIFO async mutex: `run` calls execute one at a time in the order they were requested. */
export class FifoMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => gate);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/** Transaction-scope storage plus the two lookups the store performs on every operation. */
export class TransactionScopes {
  private readonly storage = new AsyncLocalStorage<TransactionScope>();

  /** The scope this call runs inside, if any (own store or a different one). */
  current(): TransactionScope | undefined {
    return this.storage.getStore();
  }

  /** True when this call runs inside an active transaction of `store`. */
  isActiveOwner(store: object): boolean {
    const scope = this.current();
    return scope !== undefined && scope.store === store && scope.active;
  }

  /** Run `work` with `scope` visible to every nested call, including across `await`. */
  run<T>(scope: TransactionScope, work: () => Promise<T>): Promise<T> {
    return this.storage.run(scope, work);
  }
}
