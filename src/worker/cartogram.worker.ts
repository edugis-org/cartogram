/// <reference lib="webworker" />
import { cartogram } from '../index.ts';
import type { CartogramOptions } from '../types.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

/**
 * Worker entry point. The heavy loops touch no DOM and allocate only typed arrays, so
 * they run here unchanged; the point is simply that a 15-second flow run must not
 * freeze the page that started it.
 */
const controllers = new Map<number, AbortController>();

function post(message: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;

  if (request.type === 'cancel') {
    controllers.get(request.id)?.abort();
    return;
  }

  const controller = new AbortController();
  controllers.set(request.id, controller);
  try {
    const result = cartogram(request.featureCollection, {
      ...request.options,
      signal: controller.signal,
      onIteration: (iteration: number, meanError: number) =>
        post({ type: 'progress', id: request.id, iteration, meanError }),
    } as CartogramOptions);
    post({ type: 'done', id: request.id, result });
  } catch (e) {
    post({ type: 'error', id: request.id, message: (e as Error).message });
  } finally {
    controllers.delete(request.id);
  }
};
