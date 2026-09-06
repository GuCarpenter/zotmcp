/**
 * Serializes every mutation through one queue.
 *
 * Zotero's data layer is effectively single-threaded, and MCP `tools/call`
 * invocations arrive concurrently and independently (the endpoint is stateless).
 * Without a queue, two calls can interleave transactions (spec E-2). The wait is
 * bounded so a stuck queue surfaces as an actionable timeout rather than a
 * request that never returns.
 */

import { TimeoutError } from "../errors";
import type { ZoteroGateway } from "./zoteroGateway";

export const DEFAULT_QUEUE_WAIT_MS = 45_000;

export class MutationService {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly waitMs: number = DEFAULT_QUEUE_WAIT_MS,
  ) {}

  /** Number of operations queued but not yet finished. */
  public get pending(): number {
    return this.depth;
  }

  public async enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.depth += 1;

    const run = this.tail.then(
      () => this.withDeadline(label, fn),
      () => this.withDeadline(label, fn),
    );

    // The queue must not stall on a rejected predecessor, so the chain tail
    // swallows failures; the caller still receives its own rejection.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await run;
    } finally {
      this.depth -= 1;
    }
  }

  /** Enqueues `fn` and runs it inside a Zotero DB transaction. */
  public async enqueueTransaction<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(label, () => this.gateway.executeTransaction(fn));
  }

  private async withDeadline<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`Write "${label}"`, this.waitMs)),
        this.waitMs,
      );
    });

    try {
      return await Promise.race([fn(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
