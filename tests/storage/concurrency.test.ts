/**
 * Transaction isolation, rollback and scope rejection.
 *
 * The port's `transaction()` takes an async callback, which is exactly where a naive
 * implementation corrupts data: the callback's `await` points would let an unrelated save
 * run on the same connection and be committed or rolled back with a transaction it never
 * joined. These cases pin that down from the outside: what a failing transaction leaves
 * behind, what a concurrent writer observes, that a nested transaction request is rejected
 * before its callback runs, and that operations which outlive their transaction — or queue
 * behind a close — fail loudly instead of touching a connection they no longer own.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { StorageError } from '../../src/adapters/sqlite/errors.js';
import * as fx from './fixtures.js';

type Paths = { readonly path: string; readonly dir: string };

async function withStore(run: (store: SqliteTrainingStore, paths: Paths) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await run(store, paths);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Fail loudly instead of hanging the suite when the connection deadlocks. */
async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within 5s`)), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

void test('a throwing transaction rolls back every write it made', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const kept = fx.makeProblem(fx.makeRef(scope.instance, 'KEEP'));
    const doomed = fx.makeProblem(fx.makeRef(scope.instance, 'DOOMED'));
    await store.upsertProblems([kept]);

    await assert.rejects(
      deadline(
        store.transaction(async () => {
          await store.upsertProblems([doomed]);
          const visible = await store.listProblems({ limit: 10, cursor: null });
          assert.equal(visible.items.length, 2, 'the transaction reads its own uncommitted write');
          throw new Error('transaction aborted');
        }),
        'failing transaction',
      ),
      /transaction aborted/,
    );

    const after = await store.listProblems({ limit: 10, cursor: null });
    assert.deepEqual(
      after.items.map((problem) => problem.key),
      [kept.key],
    );
    // The connection is still usable and the rollback released the mutex.
    await store.upsertProblems([doomed]);
    assert.equal((await store.listProblems({ limit: 10, cursor: null })).items.length, 2);
  });
});

void test('a write issued while a transaction runs survives that transaction rolling back', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('hydro', 'hydro.example.edu', 'alice', 'P1');
    const insider = fx.makeProblem(fx.makeRef(scope.instance, 'INSIDE'));
    const outsider = fx.makeProblem(fx.makeRef(scope.instance, 'OUTSIDE'));
    const insideWritten = deferred();
    const releaseInsider = deferred();

    const transaction = store.transaction(async () => {
      await store.upsertProblems([insider]);
      insideWritten.resolve();
      await releaseInsider.promise;
      throw new Error('insider failed');
    });

    await insideWritten.promise;
    const outsideWrite = store.upsertProblems([outsider]);
    releaseInsider.resolve();
    await assert.rejects(transaction, /insider failed/);
    await deadline(outsideWrite, 'outside write');

    const items = await store.listProblems({ limit: 10, cursor: null });
    assert.deepEqual(
      items.items.map((problem) => problem.key),
      [outsider.key],
      'the outside write is committed and the insider write is not',
    );
  });
});

void test('a read issued during a transaction waits and never sees uncommitted rows', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const insider = fx.makeProblem(fx.makeRef(scope.instance, 'INSIDE'));
    const insideWritten = deferred();
    const releaseInsider = deferred();

    const transaction = store.transaction(async () => {
      await store.upsertProblems([insider]);
      insideWritten.resolve();
      await releaseInsider.promise;
    });
    await insideWritten.promise;
    const outsideRead = store.listProblems({ limit: 10, cursor: null });
    releaseInsider.resolve();
    await deadline(transaction, 'transaction');
    const page = await deadline(outsideRead, 'outside read');
    assert.equal(page.items.length, 1, 'uncommitted rows are invisible to other callers');
  });
});

void test('manual revision advances inside the transaction and rolls back with it', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('luogu', 'luogu.com.cn', 'alice', 'P1001');
    const decision = fx.makeManualDecision(scope.problem, fx.GREEDY_TAG, 'accept');

    await assert.rejects(
      store.transaction(async () => {
        await store.saveManualDecision(decision);
        assert.equal(await store.getManualRevision(scope.problem.key), 1);
        throw new Error('rollback the decision');
      }),
      /rollback the decision/,
    );
    assert.equal(await store.getManualRevision(scope.problem.key), 0);
    assert.deepEqual(await store.listManualDecisions(scope.problem.key), []);

    await store.transaction(async () => {
      await store.saveManualDecision(decision);
    });
    assert.equal(await store.getManualRevision(scope.problem.key), 1);
  });
});

void test('a nested transaction is rejected before its callback runs and leaves the outer write intact', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const outer = fx.makeProblem(fx.makeRef(scope.instance, 'OUTER'));
    const inner = fx.makeProblem(fx.makeRef(scope.instance, 'INNER'));
    let innerRuns = 0;

    await store.transaction(async () => {
      await store.upsertProblems([outer]);
      await assert.rejects(
        store.transaction(async () => {
          innerRuns += 1;
          await store.upsertProblems([inner]);
        }),
        (error) => error instanceof StorageError && error.code === 'nested_transaction',
      );
      const inside = await store.listProblems({ limit: 10, cursor: null });
      assert.equal(inside.items.length, 1, 'ordinary reads inside the transaction still work');
      assert.deepEqual(
        inside.items.map((problem) => problem.key),
        [outer.key],
        'the outer write is intact after the rejected nested request',
      );
    });

    assert.equal(innerRuns, 0, 'the nested callback never executed');
    const committed = await store.listProblems({ limit: 10, cursor: null });
    assert.deepEqual(
      committed.items.map((problem) => problem.key),
      [outer.key],
      'the outer transaction committed its own write',
    );
  });
});

void test('parallel nested transaction requests are all rejected before any callback executes', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('hydro', 'hydro.example.edu', 'alice', 'P1');
    const problem = fx.makeProblem(fx.makeRef(scope.instance, 'NESTED-PARALLEL'));
    let callbacks = 0;

    await store.transaction(async () => {
      await store.upsertProblems([problem]);
      // Requested together, as an application would: sharing one connection would let these
      // savepoints release or roll back each other, so every one is refused up front.
      const requests = [0, 1, 2].map(() =>
        store.transaction(async () => {
          callbacks += 1;
          await store.upsertProblems([problem]);
        }),
      );
      const outcomes = await Promise.all(
        requests.map((request) =>
          request.then(
            () => 'resolved',
            (error: unknown) => error,
          ),
        ),
      );
      assert.equal(callbacks, 0, 'no nested callback body ran');
      for (const outcome of outcomes) {
        assert.ok(outcome instanceof StorageError, `expected a storage error, got ${String(outcome)}`);
        assert.equal(outcome.code, 'nested_transaction');
      }
      assert.equal((await store.listProblems({ limit: 10, cursor: null })).items.length, 1);
    });

    assert.equal(callbacks, 0);
    assert.equal((await store.listProblems({ limit: 10, cursor: null })).items.length, 1);
  });
});

void test('parallel operations inside a transaction complete without deadlock', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const problem = fx.makeProblem(fx.makeRef(scope.instance, 'PARALLEL'));
    const snapshot = fx.makeSnapshot(problem);
    await store.saveManualDecision(fx.makeManualDecision(scope.problem, fx.GREEDY_TAG, 'accept'));

    const result = await deadline(
      store.transaction(async () => {
        await store.upsertProblems([problem]);
        await store.saveSnapshot(snapshot);
        const [revision, problems, head] = await Promise.all([
          store.getManualRevision(scope.problem.key),
          store.listProblems({ limit: 10, cursor: null }),
          store.getCurrentSnapshotHead(problem.ref),
        ]);
        return { revision, count: problems.items.length, head: head?.snapshotId ?? null };
      }),
      'transaction with parallel operations',
    );
    assert.deepEqual(result, { revision: 1, count: 1, head: snapshot.snapshotId });
  });
});

void test('an operation that outlives its transaction is rejected instead of writing outside it', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const late = fx.makeProblem(fx.makeRef(scope.instance, 'LATE'));
    const escaped: { outcome: Promise<unknown> | null } = { outcome: null };

    await store.transaction(async () => {
      setTimeout(() => {
        // Handle the rejection immediately: the point of the case is that the call is
        // refused, not that it produces an unhandled rejection.
        escaped.outcome = store.upsertProblems([late]).then(
          () => 'resolved',
          (error: unknown) => error,
        );
      }, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const outcome = escaped.outcome;
    assert.ok(outcome, 'the late operation really ran after the transaction');
    const settled = await outcome;
    assert.ok(settled instanceof StorageError, `expected a storage error, got ${String(settled)}`);
    assert.equal(settled.code, 'transaction_scope_escaped');
    assert.equal((await store.listProblems({ limit: 10, cursor: null })).items.length, 0);
  });
});

void test('a transaction requested from an async callback after the owner committed is rejected', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const late = fx.makeProblem(fx.makeRef(scope.instance, 'LATE-TRANSACTION'));
    let callbacks = 0;
    const escaped: { outcome: Promise<unknown> | null } = { outcome: null };

    await store.transaction(async () => {
      setTimeout(() => {
        escaped.outcome = store
          .transaction(async () => {
            callbacks += 1;
            await store.upsertProblems([late]);
            return 'ran';
          })
          .then(
            () => 'resolved',
            (error: unknown) => error,
          );
      }, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const outcome = escaped.outcome;
    assert.ok(outcome, 'the late transaction really ran after the owner committed');
    const settled = await outcome;
    assert.ok(settled instanceof StorageError, `expected a storage error, got ${String(settled)}`);
    assert.equal(settled.code, 'transaction_scope_escaped');
    assert.equal(callbacks, 0, 'the escaped callback never executed');
    assert.equal((await store.listProblems({ limit: 10, cursor: null })).items.length, 0);
  });
});

void test('a backupTo requested inside its own transaction is rejected instead of deadlocking', async () => {
  await withStore(async (store, paths) => {
    const target = join(paths.dir, 'from-transaction.sqlite');
    const scope = fx.makeScope('luogu', 'luogu.com.cn', 'alice', 'P1001');

    const result = await deadline(
      store.transaction(async () => {
        await store.upsertProblems([scope.problem]);
        await assert.rejects(store.backupTo(target), (error) => {
          return error instanceof StorageError && error.code === 'backup_in_transaction';
        });
        return 'outer-committed';
      }),
      'transaction with an inner backup',
    );

    assert.equal(result, 'outer-committed');
    assert.equal(existsSync(target), false, 'the rejected backup wrote nothing');
    // The rejected call never queued on the mutex, so the store is still fully usable.
    await store.backupTo(target);
    assert.equal(existsSync(target), true, 'a later backup outside the transaction still works');
  });
});

void test('a backupTo left over from a finished transaction is rejected as escaped', async () => {
  await withStore(async (store, paths) => {
    const target = join(paths.dir, 'escaped-backup.sqlite');
    const escaped: { outcome: Promise<unknown> | null } = { outcome: null };

    await store.transaction(async () => {
      setTimeout(() => {
        escaped.outcome = store.backupTo(target).then(
          () => 'resolved',
          (error: unknown) => error,
        );
      }, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const outcome = escaped.outcome;
    assert.ok(outcome, 'the late backup really ran after the transaction');
    const settled = await outcome;
    assert.ok(settled instanceof StorageError, `expected a storage error, got ${String(settled)}`);
    assert.equal(settled.code, 'transaction_scope_escaped');
    assert.equal(existsSync(target), false);
  });
});

void test('reads and transactions queued behind a close report closed instead of a driver error', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const holding = deferred();
    const release = deferred();

    // The transaction owns the mutex. `close()` queues first, so the read and the
    // transaction request that queue behind it are accepted while the store still looks
    // open, but reach the connection only after it is closed.
    const transaction = store.transaction(async () => {
      await store.upsertProblems([scope.problem]);
      holding.resolve();
      await release.promise;
    });
    await holding.promise;

    const closing = store.close();
    const queuedRead = store.listProblems({ limit: 10, cursor: null }).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    const queuedTransaction = store
      .transaction(async () => {
        await store.upsertProblems([scope.problem]);
        return 'ran';
      })
      .then(
        () => 'resolved',
        (error: unknown) => error,
      );

    release.resolve();
    await deadline(transaction, 'transaction that was closed behind');

    const readOutcome = await queuedRead;
    assert.ok(readOutcome instanceof StorageError, `expected a storage error, got ${String(readOutcome)}`);
    assert.equal(readOutcome.code, 'closed');
    const transactionOutcome = await queuedTransaction;
    assert.ok(
      transactionOutcome instanceof StorageError,
      `expected a storage error, got ${String(transactionOutcome)}`,
    );
    assert.equal(transactionOutcome.code, 'closed');
    await deadline(closing, 'close');
  });
});
