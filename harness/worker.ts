/// <reference lib="webworker" />
import initGoCart from 'go-cart-wasm';
import wasmUrl from 'go-cart-wasm/dist/cart.wasm?url';
import { cartogram } from '../src/index.ts';
import { goCartCartogram, type GoCartModule } from '../src/backends/go-cart.ts';
import type { CartogramOptions } from '../src/types.ts';
import type { WorkerRequest, WorkerResponse } from '../src/worker/protocol.ts';

/**
 * The harness's own worker.
 *
 * It speaks the same protocol as the library's built-in worker, and is handed to
 * `CartogramWorker` as a factory, so the harness gets one extra thing the library's
 * worker deliberately does not carry: the go-cart-wasm backend. Keeping it here means
 * the published package never pulls in 671 kB of WebAssembly for a comparison feature
 * that only this review tool needs.
 */
const controllers = new Map<number, AbortController>();
let goCart: GoCartModule | undefined;

function post(message: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

async function ensureGoCart(): Promise<GoCartModule> {
  if (!goCart) {
    goCart = (await initGoCart({ locateFile: () => wasmUrl })) as GoCartModule;
  }
  return goCart;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>): Promise<void> => {
  const request = event.data;
  if (request.type === 'cancel') {
    controllers.get(request.id)?.abort();
    return;
  }

  const controller = new AbortController();
  controllers.set(request.id, controller);
  // The harness adds one method the library does not have, so the discriminant is
  // widened here rather than in the library's own option types.
  const options = request.options as unknown as Omit<CartogramOptions, 'method'> & {
    method: CartogramOptions['method'] | 'go-cart';
  };

  try {
    if (options.method === 'go-cart') {
      // The reference implementation runs to completion in C: there is nothing to
      // report progress from and nothing to cancel part-way.
      const result = goCartCartogram(request.featureCollection, {
        ...(options as unknown as Record<string, unknown>),
        goCart: await ensureGoCart(),
      } as never);
      post({ type: 'done', id: request.id, result });
    } else {
      const result = cartogram(request.featureCollection, {
        ...(options as unknown as CartogramOptions),
        signal: controller.signal,
        onIteration: (iteration: number, meanError: number) =>
          post({ type: 'progress', id: request.id, iteration, meanError }),
      } as CartogramOptions);
      post({ type: 'done', id: request.id, result });
    }
  } catch (e) {
    post({ type: 'error', id: request.id, message: (e as Error).message });
  } finally {
    controllers.delete(request.id);
  }
};
