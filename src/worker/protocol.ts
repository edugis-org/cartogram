import type { CartogramOptions, CartogramResult } from '../types.ts';
import type { FeatureCollection } from 'geojson';

/**
 * Options that survive being posted to a worker: functions and AbortSignals do not
 * survive structured cloning, so progress and cancellation are handled by messages
 * instead.
 */
export type WorkerOptions = Omit<CartogramOptions, 'onIteration' | 'signal'>;

export interface RunRequest {
  type: 'run';
  id: number;
  featureCollection: FeatureCollection;
  options: WorkerOptions;
}

export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export type WorkerRequest = RunRequest | CancelRequest;

export interface ProgressMessage {
  type: 'progress';
  id: number;
  iteration: number;
  meanError: number;
}

export interface DoneMessage {
  type: 'done';
  id: number;
  result: CartogramResult;
}

export interface ErrorMessage {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerResponse = ProgressMessage | DoneMessage | ErrorMessage;
