import { describe, expect, it, vi } from 'vitest';
import { CartogramWorker } from '../src/worker/client.ts';
import type { WorkerRequest, WorkerResponse } from '../src/worker/protocol.ts';
import { fc, squareFeature } from './helpers.ts';

/**
 * A stand-in for the browser's Worker, so the client's message protocol is tested
 * without a browser. It records what was posted and lets a test push replies back.
 */
class FakeWorker {
  posted: WorkerRequest[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
}

const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 4)]);
const options = { method: 'olson', value: 'value' } as never;

function setup() {
  const fake = new FakeWorker();
  const client = new CartogramWorker(() => fake as unknown as Worker);
  return { fake, client };
}

describe('worker client', () => {
  it('posts the run and resolves with the result', async () => {
    const { fake, client } = setup();
    const promise = client.run(input, options);

    expect(fake.posted).toHaveLength(1);
    const request = fake.posted[0]!;
    expect(request.type).toBe('run');

    const result = { metrics: { areaError: { mean: 0 } } };
    fake.reply({ type: 'done', id: request.id, result: result as never });
    await expect(promise).resolves.toBe(result);
  });

  it('reports progress without resolving', async () => {
    const { fake, client } = setup();
    const onProgress = vi.fn();
    const promise = client.run(input, options, { onProgress });
    const id = fake.posted[0]!.id;

    fake.reply({ type: 'progress', id, iteration: 3, meanError: 0.2 });
    expect(onProgress).toHaveBeenCalledWith(3, 0.2);

    fake.reply({ type: 'done', id, result: {} as never });
    await promise;
  });

  it('rejects on a worker-side error', async () => {
    const { fake, client } = setup();
    const promise = client.run(input, options);
    fake.reply({ type: 'error', id: fake.posted[0]!.id, message: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('forwards cancellation as a message rather than killing the worker', async () => {
    // Terminating would mean paying to start a fresh worker on the next run, which is
    // the common case in the harness: every parameter change supersedes the last run.
    const { fake, client } = setup();
    const controller = new AbortController();
    void client.run(input, options, { signal: controller.signal }).catch(() => {});
    controller.abort();

    expect(fake.terminated).toBe(false);
    expect(fake.posted.map((m) => m.type)).toEqual(['run', 'cancel']);
    expect(fake.posted[1]!.id).toBe(fake.posted[0]!.id);
  });

  it('reuses one worker across runs and gives each run its own id', async () => {
    const { fake, client } = setup();
    const first = client.run(input, options);
    const second = client.run(input, options);
    expect(fake.posted).toHaveLength(2);
    expect(fake.posted[0]!.id).not.toBe(fake.posted[1]!.id);

    // Replies may arrive out of order; each must land on its own run.
    fake.reply({ type: 'done', id: fake.posted[1]!.id, result: { tag: 2 } as never });
    fake.reply({ type: 'done', id: fake.posted[0]!.id, result: { tag: 1 } as never });
    await expect(first).resolves.toEqual({ tag: 1 });
    await expect(second).resolves.toEqual({ tag: 2 });
  });

  it('rejects in-flight runs when terminated', async () => {
    const { fake, client } = setup();
    const promise = client.run(input, options);
    client.terminate();
    expect(fake.terminated).toBe(true);
    await expect(promise).rejects.toThrow('terminated');
  });
});
