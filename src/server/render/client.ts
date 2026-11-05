import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { ServiceError } from "../canvas/errors.js";
import type { BoundsResult, HeadlessJob, HeadlessResult, NativeElement, RenderResult } from "./types.js";

type Job = { input: HeadlessJob; resolve: (value: HeadlessResult) => void; reject: (error: Error) => void; cleanup: () => void };

export class HeadlessService {
  private queue: Job[] = [];
  private active: { job: Job; worker: Worker; cancel: (error: Error) => void } | undefined;
  private closed = false;

  convert(elements: Record<string, unknown>[], signal?: AbortSignal) { return this.run({ kind: "convert", elements }, signal) as Promise<NativeElement[]>; }
  bounds(elements: NativeElement[], signal?: AbortSignal) { return this.run({ kind: "bounds", elements }, signal) as Promise<BoundsResult>; }
  bindings(elements: NativeElement[], changedIds: string[], simultaneousIds: string[], signal?: AbortSignal) { return this.run({ kind: "bindings", elements, changedIds, simultaneousIds }, signal) as Promise<NativeElement[]>; }
  render(input: Omit<Extract<HeadlessJob, { kind: "render" }>, "kind">, signal?: AbortSignal) { return this.run({ ...input, kind: "render" }, signal) as Promise<RenderResult>; }

  private run(input: HeadlessJob, signal?: AbortSignal): Promise<HeadlessResult> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new ServiceError(503, "Headless service is shutting down"));
    if (this.queue.length >= 4) return Promise.reject(new ServiceError(503, "Headless service is busy; retry later"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        const error = signal!.reason as Error;
        if (this.active?.job === job) this.active.cancel(error);
        else {
          const index = this.queue.indexOf(job);
          if (index < 0) return;
          this.queue.splice(index, 1);
          job.cleanup();
          reject(error);
        }
      };
      const job: Job = { input, resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.start();
    });
  }

  private start() {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    let worker: Worker;
    try { worker = new Worker(resolve("dist/headless/worker.mjs"), { workerData: job.input, execArgv: [], env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: "1" }, resourceLimits: { maxOldGenerationSizeMb: 256 } }); }
    catch { job.cleanup(); job.reject(new ServiceError(503, "Headless worker could not start")); this.start(); return; }
    let finished = false;
    const finish = (error?: Error, result?: HeadlessResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      job.cleanup();
      if (error) job.reject(error); else job.resolve(result!);
      void worker.terminate().finally(() => { this.active = undefined; this.start(); });
    };
    const timeout = setTimeout(() => finish(new ServiceError(503, "Headless operation timed out")), 15_000);
    this.active = { job, worker, cancel: error => finish(error) };
    worker.once("message", (message: { error?: string; result?: HeadlessResult }) => {
      finish(message.error ? new ServiceError(400, message.error) : undefined, message.result);
    });
    worker.once("error", () => finish(new ServiceError(503, "Headless worker failed")));
    worker.once("exit", () => { if (!finished) finish(new ServiceError(503, "Headless worker exited unexpectedly")); });
  }

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) { job.cleanup(); job.reject(new ServiceError(503, "Headless service is shutting down")); }
    this.active?.cancel(new ServiceError(503, "Headless service is shutting down"));
    if (this.active) await this.active.worker.terminate();
  }
}
