import type { FeatureCollection } from 'geojson';
import type { CartogramResult } from '../types.ts';
import type { WorkerOptions, WorkerRequest, WorkerResponse } from './protocol.ts';

/** Kept in a variable on purpose; see the constructor's note on bundlers. */
const WORKER_ENTRY = './cartogram.worker.js';

export interface RunOptions {
  onProgress?: (iteration: number, meanError: number) => void;
  signal?: AbortSignal;
}

/**
 * Runs cartograms on a Web Worker, so a long transform does not block the page.
 *
 * The worker is created lazily and reused. Cancellation is forwarded as a message
 * rather than terminating the worker, so the next run does not pay to start one up.
 */
export class CartogramWorker {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (r: CartogramResult) => void;
      reject: (e: Error) => void;
      onProgress: RunOptions['onProgress'];
    }
  >();

  /**
   * @param workerFactory how to construct the worker.
   *
   * The default resolves the built worker next to this module, which is right for
   * plain ESM consumers loading the published `dist`. **Bundler users should pass
   * their own factory**, because bundlers only rewrite worker URLs when they can see
   * a literal `new URL('...', import.meta.url)` at the call site:
   *
   * ```ts
   * new CartogramWorker(() => new Worker(
   *   new URL('@edugis/cartogram/worker', import.meta.url), { type: 'module' },
   * ));
   * ```
   *
   * The URL here is deliberately built from a variable so that a bundler skips it
   * rather than failing the build trying to resolve a path that only exists after
   * compilation.
   */
  constructor(
    private readonly workerFactory: () => Worker = () =>
      new Worker(new URL(WORKER_ENTRY, import.meta.url), { type: 'module' }),
  ) {}

  run(
    featureCollection: FeatureCollection,
    options: WorkerOptions,
    run: RunOptions = {},
  ): Promise<CartogramResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;

    return new Promise<CartogramResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: run.onProgress });
      run.signal?.addEventListener('abort', () => {
        worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest);
      });
      worker.postMessage({ type: 'run', id, featureCollection, options } satisfies WorkerRequest);
    });
  }

  /** Release the worker. Any run still in flight rejects. */
  terminate(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const [, p] of this.pending) p.reject(new Error('worker terminated'));
    this.pending.clear();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.type === 'progress') {
        entry.onProgress?.(message.iteration, message.meanError);
        return;
      }
      this.pending.delete(message.id);
      if (message.type === 'done') entry.resolve(message.result);
      else entry.reject(new Error(message.message));
    };
    worker.onerror = (event: ErrorEvent) => {
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(new Error(event.message || 'worker error'));
      }
    };
    this.worker = worker;
    return worker;
  }
}
