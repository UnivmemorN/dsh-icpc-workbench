/** Dispose every contribution in reverse order, once, even when one cleanup fails. */
export function disposeAll(disposers: readonly (() => void | Promise<void>)[]): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= (async () => {
    const failures: unknown[] = [];
    for (const dispose of [...disposers].reverse()) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'ICPC cleanup failed');
  })();
}
/** Preserve activation failure together with any cleanup failure. */
export async function rollback(error: unknown, disposers: readonly (() => void | Promise<void>)[]): Promise<never> {
  try { await disposeAll(disposers)(); }
  catch (cleanup) { throw new AggregateError([error, cleanup], 'ICPC activation and cleanup failed'); }
  throw error;
}