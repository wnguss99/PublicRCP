import { getLogger } from './logger';

const logger = getLogger('operation-tracking');

/**
 * Tracks pending async operations for coordinated shutdown
 */
export class PendingOperationsTracker {
  private readonly pendingOperations: Set<Promise<unknown>> = new Set();
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Track a promise and automatically remove when complete
   */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pendingOperations.add(promise);

    // `.finally()` returns a *new* promise that inherits the rejection. Throwing
    // it away with `void` left that derived promise unhandled, so one failed
    // conversation write became an unhandled rejection — which terminates the
    // process under Node's default policy. A transient disk error would take the
    // whole instance down.
    //
    // The caller still receives the original promise and remains responsible for
    // its rejection; this catch only silences the bookkeeping copy.
    promise
      .finally(() => {
        this.pendingOperations.delete(promise);
        logger.debug(`${this.name}: Operation completed`, {
          remaining: this.pendingOperations.size,
        });
      })
      .catch(() => {
        // Owned by the caller of track().
      });

    return promise;
  }

  /**
   * Get count of pending operations
   */
  get size(): number {
    return this.pendingOperations.size;
  }

  /**
   * Wait for all pending operations to complete
   */
  async flush(): Promise<void> {
    while (this.pendingOperations.size > 0) {
      logger.debug(`${this.name}: Flushing operations`, {
        count: this.pendingOperations.size,
      });

      // allSettled, not all: flush means "wait until the queue drains". With
      // Promise.all a single failed write threw out of the loop, leaving the
      // remaining operations untracked — and shutdown paths that flush before
      // exiting would fail instead of draining. Individual failures are already
      // reported to whoever called track().
      await Promise.allSettled(Array.from(this.pendingOperations));
    }

    logger.debug(`${this.name}: All operations flushed`);
  }

  /**
   * Clear all pending operations without waiting
   */
  clear(): void {
    this.pendingOperations.clear();
  }
}

/**
 * Write queue manager for serializing operations on entities
 */
export class WriteQueueManager<K = string> {
  private readonly writeQueues: Map<K, Promise<void>> = new Map();
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Execute operation with exclusive lock on key
   */
  async withLock<T>(
    key: K,
    operation: () => Promise<T>
  ): Promise<T> {
    const previousOperation = this.writeQueues.get(key) || Promise.resolve();

    const newOperation = previousOperation.then(operation, operation);

    // What the next caller queues behind. Deliberately never rejects, so one
    // failed operation cannot poison the queue for that key.
    const settled = newOperation.then(
      () => {},
      () => {}
    );

    this.writeQueues.set(key, settled);

    // Clean up once this is the last operation for the key, otherwise the map
    // keeps one entry per conversation for the life of the process.
    //
    // This compared against `newOperation` before, but what was stored is
    // `settled` — a different promise — so the condition was always false and the
    // entry was never removed. Waiting on `settled` also matters because
    // `newOperation.finally()` returns a promise that inherits the rejection, and
    // discarding it with `void` made a failed write an unhandled rejection, which
    // terminates the process under Node's default policy.
    void settled.finally(() => {
      if (this.writeQueues.get(key) === settled) {
        this.writeQueues.delete(key);
      }
    });

    return newOperation;
  }

  /**
   * Wait for all queued operations to complete
   */
  async flush(): Promise<void> {
    if (this.writeQueues.size > 0) {
      logger.debug(`${this.name}: Flushing write queues`, {
        count: this.writeQueues.size,
      });
      await Promise.all(Array.from(this.writeQueues.values()));
    }
  }

  /**
   * Get count of active write queues
   */
  get size(): number {
    return this.writeQueues.size;
  }

  /**
   * Clear all write queues without waiting
   */
  clear(): void {
    this.writeQueues.clear();
  }
}