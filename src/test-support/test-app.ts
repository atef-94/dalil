import assert from 'node:assert/strict';
import { buildApplication } from '../app.js';

/**
 * First shared test-util module in this codebase — every pre-existing
 * integration test duplicates its own freshApp/withServer/call helpers
 * (e.g. quotation.integration.test.ts, finance-refund.integration.test.ts).
 * New test files (the mandatory security-overhaul proof-point tests) use
 * this one instead of adding yet another copy; existing test files are left
 * as-is rather than retrofitted, to avoid risking already-green coverage
 * for a pass that doesn't need it.
 */

export type AppOverrides = Partial<Parameters<typeof buildApplication>[0]>;

export const OWNER_EMAIL_1 = 'owner1@platform.test';
export const OWNER_EMAIL_2 = 'owner2@platform.test';
export const OWNER_PASSWORD_1 = 'owner-1-password-123';
export const OWNER_PASSWORD_2 = 'owner-2-password-123';

/** Builds an app with both platform owners seeded by default (most security
 * tests need at least one owner) — pass `seed: true` explicitly for demo
 * tenant data too, or override owner fields to omit them entirely. */
export async function freshApp(overrides: AppOverrides = {}) {
  return buildApplication({
    nodeEnv: 'test',
    tokenSecret: 'test-secret',
    allowedOrigins: [],
    ownerEmail1: OWNER_EMAIL_1,
    ownerEmail2: OWNER_EMAIL_2,
    ownerPassword1: OWNER_PASSWORD_1,
    ownerPassword2: OWNER_PASSWORD_2,
    ...overrides,
  });
}

export async function withServer(
  run: (base: string, app: Awaited<ReturnType<typeof freshApp>>) => Promise<void>,
  overrides: AppOverrides = {},
) {
  const app = await freshApp(overrides);
  const server = app.httpServer.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`, app);
  } finally {
    await app.httpServer.close();
  }
}

export async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** Logs in as one of the two seeded platform owners (default: owner 1) and
 * returns its bearer-token header, ready to call any /api/platform/* or
 * /api/me/* route. */
export async function loginAsOwner(base: string, which: 1 | 2 = 1): Promise<{ authorization: string }> {
  const email = which === 1 ? OWNER_EMAIL_1 : OWNER_EMAIL_2;
  const password = which === 1 ? OWNER_PASSWORD_1 : OWNER_PASSWORD_2;
  const login = await call(base, 'POST', '/api/auth/login', { companyId: '__platform__', email, password });
  assert.equal(login.status, 200, `expected owner ${which} login to succeed: ${JSON.stringify(login.body)}`);
  return { authorization: `Bearer ${(login.body as { token: string }).token}` };
}

/** Creates a brand-new tenant via the owner-gated /api/platform/tenants
 * route (the only way to do this now that public signup is gone) and
 * returns the founding user's bearer-token header plus the new companyId —
 * a real HTTP round-trip, so this also doubles as live coverage of that
 * route itself. */
export async function createSecondTenant(base: string, namePrefix: string): Promise<{ headers: { authorization: string }; companyId: string; email: string }> {
  const ownerHeaders = await loginAsOwner(base);
  const email = `${namePrefix.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}@example.com`;
  const tenant = await call(base, 'POST', '/api/platform/tenants', {
    companyName: `${namePrefix} ${Date.now()}`,
    fullName: 'Owner B',
    email,
    password: 'a-real-password-123',
  }, ownerHeaders);
  assert.equal(tenant.status, 201, `expected tenant creation to succeed: ${JSON.stringify(tenant.body)}`);
  const body = tenant.body as { token: string; companyId: string };
  return { headers: { authorization: `Bearer ${body.token}` }, companyId: body.companyId, email };
}
