/**
 * One stock change at a time. Every path that reads a box, decides, and writes it
 * back runs inside this lock, so two scanners (or a scanner and a web save)
 * cannot both act on the same "before" picture.
 *
 * In-process: correct for the single backend instance this system is deployed
 * as. Running several instances would need a database lock instead.
 * Not re-entrant — never call a locked function from inside another one.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withStockLock<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => undefined);
  return run;
}
