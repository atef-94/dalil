import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { call, createSecondTenant, withServer } from './test-support/test-app.js';

// End-to-end coverage of the Facebook Instant Lead Forms webhook, over the
// real HTTP server (not the service harness — see
// modules/integrations/facebook-leads.service.test.ts for the deeper
// service-level unit tests of signature/idempotency/mapping logic). This
// file proves the actual wiring: raw-body signature verification through
// the real HTTP layer, the GET challenge handshake, and — the one thing
// only a real HTTP round trip can prove — that a leadgen webhook can never
// create a lead in any company other than the one whose Page it names.

const APP_SECRET = 'integration-test-facebook-app-secret';
const VERIFY_TOKEN = 'integration-test-verify-token';

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
}

function leadgenPayload(pageId: string, leadgenId: string, formId = 'form-1') {
  return {
    object: 'page',
    entry: [
      {
        id: pageId,
        time: Math.floor(Date.now() / 1000),
        changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, form_id: formId, page_id: pageId, created_time: Math.floor(Date.now() / 1000) } }],
      },
    ],
  };
}

async function postWebhook(base: string, rawBody: string, signatureHeader?: string) {
  const res = await fetch(`${base}/api/integrations/facebook/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signatureHeader ? { 'X-Hub-Signature-256': signatureHeader } : {}) },
    body: rawBody,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function connectFacebookPage(base: string, headers: { authorization: string }, pageId: string, token = 'page-access-token-value') {
  const res = await call(base, 'POST', '/api/integrations/connections', {
    provider: 'facebook_leads',
    displayName: 'Test Page',
    config: { pageId },
    credentials: { page_access_token: token },
  }, headers);
  assert.equal(res.status, 201, `expected the connection to be created: ${JSON.stringify(res.body)}`);
  return res.body as { id: string };
}

// ---- GET challenge handshake ----

test('GET webhook challenge succeeds and echoes the raw challenge text (not JSON)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/integrations/facebook/webhooks?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=echo-me-raw-123`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'echo-me-raw-123', 'the response body must be the literal challenge text, not JSON-quoted');
    assert.ok(res.headers.get('content-type')?.includes('text/plain'));
  }, { facebookAppSecret: APP_SECRET, facebookWebhookVerifyToken: VERIFY_TOKEN });
});

test('GET webhook challenge with a wrong verify_token is rejected', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/integrations/facebook/webhooks?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc`);
    assert.equal(res.status, 403);
  }, { facebookAppSecret: APP_SECRET, facebookWebhookVerifyToken: VERIFY_TOKEN });
});

test('GET webhook challenge is rejected when the integration is not configured at all', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/integrations/facebook/webhooks?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=abc`);
    assert.equal(res.status, 403);
  }); // no facebookAppSecret/facebookWebhookVerifyToken override — unconfigured by default
});

// ---- POST signature verification ----

test('POST webhook with no signature header is rejected', async () => {
  await withServer(async (base) => {
    const res = await postWebhook(base, JSON.stringify({ entry: [] }));
    assert.equal(res.status, 403);
  }, { facebookAppSecret: APP_SECRET, facebookWebhookVerifyToken: VERIFY_TOKEN });
});

test('POST webhook with an invalid signature is rejected', async () => {
  await withServer(async (base) => {
    const rawBody = JSON.stringify({ entry: [] });
    const res = await postWebhook(base, rawBody, 'sha256=' + '0'.repeat(64));
    assert.equal(res.status, 403);
  }, { facebookAppSecret: APP_SECRET, facebookWebhookVerifyToken: VERIFY_TOKEN });
});

test('POST webhook with a correctly signed empty payload is accepted and does nothing', async () => {
  await withServer(async (base) => {
    const rawBody = JSON.stringify({ object: 'page', entry: [] });
    const res = await postWebhook(base, rawBody, sign(rawBody));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: 0 });
  }, { facebookAppSecret: APP_SECRET, facebookWebhookVerifyToken: VERIFY_TOKEN });
});

test('a correctly signed webhook for an unconnected Page is accepted (200) but creates no lead', async () => {
  await withServer(async (base, app) => {
    const rawBody = JSON.stringify(leadgenPayload('never-connected-page', 'lead-unknown-1'));
    const res = await postWebhook(base, rawBody, sign(rawBody));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: 1 });

    const ceo = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!;
    const leads = await call(base, 'GET', '/api/crm/leads?limit=200', undefined, { 'x-demo-user': ceo.userId });
    const items = (leads.body as { items: { source?: string }[] }).items;
    assert.ok(!items.some((l) => l.source === 'facebook'), 'no facebook-sourced lead should exist anywhere');
  }, { facebookAppSecret: APP_SECRET, facebookWebhookVerifyToken: VERIFY_TOKEN });
});

// ---- End-to-end lead creation + cross-tenant isolation ----

test('a verified webhook for a connected Page creates a real lead in that company, and that company only', async () => {
  const originalFetch = globalThis.fetch;
  // Monkey-patched *before* withServer builds the app — IntegrationService's
  // fetchImpl parameter defaults to the global `fetch` identifier, resolved
  // once at construction time (inside buildApplication, which withServer
  // calls), so the patch must already be in place before that happens. No
  // real network call to graph.facebook.com is ever made; this proves the
  // full pipeline (raw-body signature verification -> company resolution by
  // Page id -> Graph API fetch -> CrmService.createLead) without depending
  // on live internet access from the test environment.
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('graph.facebook.com')) {
      return new Response(JSON.stringify({
        field_data: [
          { name: 'full_name', values: ['HTTP Test Lead'] },
          { name: 'phone_number', values: ['01098765432'] },
        ],
      }), { status: 200 });
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;

  try {
    await withServer(async (base, app) => {
      const tenantA = await createSecondTenant(base, 'Facebook Webhook Tenant A');
      const tenantB = await createSecondTenant(base, 'Facebook Webhook Tenant B');
      const connection = await connectFacebookPage(base, tenantA.headers, 'http-page-a');
      void app;

      const rawBody = JSON.stringify(leadgenPayload('http-page-a', 'lead-http-1'));
      const res = await postWebhook(base, rawBody, sign(rawBody));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { received: 1 });

      const leadsA = await call(base, 'GET', '/api/crm/leads?limit=200', undefined, tenantA.headers);
      const itemsA = (leadsA.body as { items: { fullName: string; source?: string }[] }).items;
      const created = itemsA.find((l) => l.fullName === 'HTTP Test Lead');
      assert.ok(created, 'tenant A must have received the real lead');
      assert.equal(created!.source, 'facebook');

      const leadsB = await call(base, 'GET', '/api/crm/leads?limit=200', undefined, tenantB.headers);
      const itemsB = (leadsB.body as { items: { fullName: string }[] }).items;
      assert.ok(!itemsB.some((l) => l.fullName === 'HTTP Test Lead'), 'tenant B must never see tenant A\'s Facebook lead');

      // Redelivering the exact same webhook (Meta's own retry behavior)
      // must not create a second lead.
      const retry = await postWebhook(base, rawBody, sign(rawBody));
      assert.equal(retry.status, 200);
      const leadsAAfterRetry = await call(base, 'GET', '/api/crm/leads?limit=200', undefined, tenantA.headers);
      const matches = (leadsAAfterRetry.body as { items: { fullName: string }[] }).items.filter((l) => l.fullName === 'HTTP Test Lead');
      assert.equal(matches.length, 1, 'a redelivered webhook must not create a duplicate lead');

      void connection;
    }, { facebookAppSecret: APP_SECRET, facebookWebhookVerifyToken: VERIFY_TOKEN });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
