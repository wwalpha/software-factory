import { FactoryError } from '../domain/invariants.js';
export class Lane {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private capacity: number) {}
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (this.active < this.capacity) this.active++;
    else
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          this.waiters = this.waiters.filter((w) => w !== ready);
          reject(new FactoryError('cancelled', 'Queued call cancelled'));
        };
        this.waiters.push(ready);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    try {
      if (signal.aborted) throw new FactoryError('cancelled', 'Call cancelled');
      return await operation();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
