import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expectedHost, hostAllowed, parseHost, requireExpectedHost } from '../server/host.js';
import { createLimiter } from '../server/rate.js';
import { atLeast } from '../server/http.js';
import { MAX_INFLIGHT, reserve } from '../server/rate.js';

describe('host pinning', () => {
  test('"any" accepts anything, including a missing header', () => {
    assert.equal(hostAllowed('localhost:8787', 'any'), true);
    assert.equal(hostAllowed('10.0.0.4', 'ANY'), true);
    assert.equal(hostAllowed('', 'any'), true);
  });

  test('an unset expectation fails closed rather than accepting everything', () => {
    assert.equal(hostAllowed('localhost:8787', null), false);
    assert.equal(hostAllowed('journal.example.com', ''), false);
  });

  test('a JRNL_HOST that is a URL drops the https:// prefix', () => {
    const saved = process.env.JRNL_HOST;
    try {
      process.env.JRNL_HOST = 'https://journal.example.com';
      assert.equal(expectedHost(), 'journal.example.com');
      process.env.JRNL_HOST = 'https://journal.example.com/';
      assert.equal(expectedHost(), 'journal.example.com');
      assert.equal(hostAllowed('journal.example.com'), true);
    } finally {
      if (saved === undefined) delete process.env.JRNL_HOST;
      else process.env.JRNL_HOST = saved;
    }
  });

  test('requireExpectedHost throws when JRNL_HOST is unset', () => {
    const saved = process.env.JRNL_HOST;
    try {
      delete process.env.JRNL_HOST;
      assert.throws(() => requireExpectedHost(), /JRNL_HOST is not set/);
      process.env.JRNL_HOST = 'journal.example.com';
      assert.equal(requireExpectedHost(), 'journal.example.com');
    } finally {
      if (saved === undefined) delete process.env.JRNL_HOST;
      else process.env.JRNL_HOST = saved;
    }
  });

  test('hostname must match, case-insensitively, ignoring a trailing DNS dot', () => {
    assert.equal(hostAllowed('journal.example.com', 'journal.example.com'), true);
    assert.equal(hostAllowed('Journal.Example.COM', 'journal.example.com'), true);
    assert.equal(hostAllowed('journal.example.com.', 'journal.example.com'), true);
    assert.equal(hostAllowed('evil.example.com', 'journal.example.com'), false);
    assert.equal(hostAllowed('127.0.0.1:8787', 'journal.example.com'), false);
    assert.equal(hostAllowed('', 'journal.example.com'), false);
  });

  test('a port on JRNL_HOST is required; a port-less name accepts any port', () => {
    assert.equal(hostAllowed('journal.example.com:443', 'journal.example.com'), true);
    assert.equal(hostAllowed('journal.example.com:8443', 'journal.example.com:8443'), true);
    assert.equal(hostAllowed('journal.example.com:443', 'journal.example.com:8443'), false);
  });

  test('IPv6 literals parse', () => {
    assert.deepEqual(parseHost('[::1]:8787'), { hostname: '::1', port: '8787' });
    assert.equal(hostAllowed('[::1]:8787', '[::1]'), true);
  });
});

describe('global rate limit', () => {
  test('allows a burst, then refuses until tokens refill', () => {
    let now = 0;
    const limiter = createLimiter({ rps: 10, burst: 3, now: () => now });
    assert.equal(limiter.take(), true);
    assert.equal(limiter.take(), true);
    assert.equal(limiter.take(), true);
    assert.equal(limiter.take(), false);

    now += 100; // 1 token at 10 rps
    assert.equal(limiter.take(), true);
    assert.equal(limiter.take(), false);
  });

  test('the auth bucket allows one attempt per second', () => {
    let now = 0;
    const auth = createLimiter({ rps: 1, burst: 1, now: () => now });
    assert.equal(auth.take(), true);
    assert.equal(auth.take(), false, 'a second attempt in the same instant is refused');

    now += 500;
    assert.equal(auth.take(), false, 'half a token is not enough');
    now += 500;
    assert.equal(auth.take(), true, 'a full second refills exactly one attempt');
    assert.equal(auth.take(), false);
  });

  test('ten editors posting every 800ms stay under the default bucket', () => {
    let now = 0;
    const limiter = createLimiter({ rps: 30, burst: 80, now: () => now });
    // Cold loads for a few of them, then a minute of aligned scratch posts.
    for (let i = 0; i < 40; i++) assert.equal(limiter.take(), true, 'burst covers a couple of loads');
    for (let step = 0; step < 75; step++) {
      now += 800;
      for (let editor = 0; editor < 10; editor++) {
        assert.equal(limiter.take(), true, `editor ${editor} at t=${now}`);
      }
    }
  });
});

describe('geocoding admission', () => {
  test('slots are bounded, and released when the request finishes', () => {
    const held = [];
    for (let i = 0; i < MAX_INFLIGHT; i++) held.push(reserve());
    assert.throws(() => reserve(), /busy/, 'the queue refuses past its bound');

    held.pop()();
    const next = reserve();
    assert.throws(() => reserve(), /busy/, 'one slot freed admits exactly one');

    next();
    held.forEach((release) => release());
  });

  test('releasing twice does not leak a slot back into the pool', () => {
    const release = reserve();
    release();
    release();
    const all = [];
    for (let i = 0; i < MAX_INFLIGHT; i++) all.push(reserve());
    assert.throws(() => reserve(), /busy/, 'the double release did not inflate capacity');
    all.forEach((r) => r());
  });
});

describe('constant-time responses', () => {
  test('a fast result is held until the floor, so its duration says nothing', async () => {
    const started = Date.now();
    const value = await atLeast(120, () => 'immediate');
    assert.equal(value, 'immediate');
    assert.ok(Date.now() - started >= 115, 'padded up to the floor');
  });

  test('work slower than the floor is not delayed further', async () => {
    const started = Date.now();
    await atLeast(50, () => new Promise((resolve) => setTimeout(resolve, 140)));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 140 && elapsed < 260, `finished promptly at ${elapsed}ms`);
  });

  test('failures are padded too — a fast throw is as much of a signal', async () => {
    const started = Date.now();
    await assert.rejects(
      () =>
        atLeast(120, () => {
          throw new Error('no such user');
        }),
      /no such user/
    );
    assert.ok(Date.now() - started >= 115, 'the throw waits out the floor');
  });
});
