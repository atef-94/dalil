import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyLimiter } from './concurrency-queue.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('runs jobs immediately while under the concurrency limit', async () => {
  const limiter = new ConcurrencyLimiter(2);
  let started = 0;
  const jobs = [1, 2].map(() =>
    limiter.run(async () => {
      started++;
      return started;
    }),
  );
  await Promise.all(jobs);
  assert.equal(started, 2);
});

test('queues jobs beyond the concurrency limit and runs them once a slot frees', async () => {
  const limiter = new ConcurrencyLimiter(1);
  const first = deferred<void>();
  let secondStarted = false;

  const firstJob = limiter.run(async () => {
    await first.promise;
    return 'first';
  });

  // Give the first job a tick to actually acquire its slot before queuing the second.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(limiter.activeCount, 1);

  const secondJob = limiter.run(async () => {
    secondStarted = true;
    return 'second';
  });

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(secondStarted, false, 'second job must not start while the first holds the only slot');
  assert.equal(limiter.queuedCount, 1);

  first.resolve();
  const [firstResult, secondResult] = await Promise.all([firstJob, secondJob]);
  assert.equal(firstResult, 'first');
  assert.equal(secondResult, 'second');
  assert.equal(secondStarted, true);
});

test('releases the slot even when the job throws', async () => {
  const limiter = new ConcurrencyLimiter(1);
  await assert.rejects(() => limiter.run(async () => { throw new Error('boom'); }));
  assert.equal(limiter.activeCount, 0);
  const result = await limiter.run(async () => 'ok after failure');
  assert.equal(result, 'ok after failure');
});

test('rejects a non-positive concurrency limit', () => {
  assert.throws(() => new ConcurrencyLimiter(0));
});
