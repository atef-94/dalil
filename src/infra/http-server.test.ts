import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpServer } from './http-server.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

// Phase 0 fix: clientIp() must ignore X-Forwarded-For by default (trustProxy
// unset/false) so a caller can't spoof a fresh rate-limit bucket on every
// request by sending a different X-Forwarded-For value each time — that
// would silently defeat both the global limiter and the auth brute-force
// limiter. It should only honor the header when the deployment explicitly
// opts in via trustProxy: true (meant for when the app sits behind a real,
// trusted reverse proxy that sets — not merely appends to — the header).
//
// These tests start a real HttpServer on an ephemeral loopback port and
// fire real HTTP requests at it (not a mocked IncomingMessage), so the
// "real socket address" path is exercised exactly as it runs in
// production, not simulated.

function startServer(trustProxy: boolean | undefined, maxHits: number): { server: HttpServer; port: number; close: () => Promise<void> } {
  const server = new HttpServer({
    allowedOrigins: [],
    nodeEnv: 'test',
    globalRateLimiter: new SlidingWindowRateLimiter(60_000, maxHits),
    authRateLimiter: new SlidingWindowRateLimiter(60_000, 1000),
    trustProxy,
  });
  server.get('/echo-ip', async (ctx) => ({ status: 200, body: { ip: ctx.ip } }));
  const httpServer = server.listen(0);
  const port = (httpServer.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () => server.close(),
  };
}

function request(port: number, xForwardedFor?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/echo-ip', method: 'GET', headers: xForwardedFor ? { 'x-forwarded-for': xForwardedFor } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('clientIp ignores a spoofed X-Forwarded-For header by default (trustProxy unset) — every request resolves to the same real socket address', async () => {
  const { port, close } = startServer(undefined, 1000);
  try {
    const a = await request(port, '1.1.1.1');
    const b = await request(port, '2.2.2.2');
    assert.equal(a.body.ip, b.body.ip, 'two requests from the same real socket with different spoofed X-Forwarded-For values must resolve to the same ip');
    assert.notEqual(a.body.ip, '1.1.1.1');
    assert.notEqual(b.body.ip, '2.2.2.2');
  } finally {
    await close();
  }
});

test('clientIp ignores X-Forwarded-For when trustProxy is explicitly false', async () => {
  const { port, close } = startServer(false, 1000);
  try {
    const res = await request(port, '9.9.9.9');
    assert.notEqual(res.body.ip, '9.9.9.9');
  } finally {
    await close();
  }
});

test('clientIp honors X-Forwarded-For only when trustProxy is explicitly true', async () => {
  const { port, close } = startServer(true, 1000);
  try {
    const a = await request(port, '1.1.1.1');
    const b = await request(port, '2.2.2.2');
    assert.equal(a.body.ip, '1.1.1.1');
    assert.equal(b.body.ip, '2.2.2.2');
  } finally {
    await close();
  }
});

test('Phase 0 fix: a spoofed X-Forwarded-For header cannot be used to dodge the rate limiter when trustProxy is off (default)', async () => {
  const { port, close } = startServer(undefined, 2); // only 2 requests allowed per window, real-IP-keyed
  try {
    const first = await request(port, 'spoof-1');
    const second = await request(port, 'spoof-2');
    const third = await request(port, 'spoof-3');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429, 'a third request must be rate-limited even though every request claimed a different X-Forwarded-For — they all share the same real socket address');
  } finally {
    await close();
  }
});

test('with trustProxy: true, a spoofed X-Forwarded-For header DOES dodge the rate limiter (opt-in trust, by design — only safe behind a real trusted proxy)', async () => {
  const { port, close } = startServer(true, 2);
  try {
    const first = await request(port, 'spoof-1');
    const second = await request(port, 'spoof-2');
    const third = await request(port, 'spoof-3');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 200, 'each spoofed X-Forwarded-For value gets its own rate-limit bucket when trustProxy is true');
  } finally {
    await close();
  }
});
