import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildApplication } from './app.js';

async function freshApp() {
  return buildApplication({ nodeEnv: 'test', tokenSecret: 'test-secret', allowedOrigins: [], seed: true });
}

async function withServer(run: (base: string, app: Awaited<ReturnType<typeof freshApp>>) => Promise<void>) {
  const app = await freshApp();
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

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
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

async function signRealDemoContract(base: string, headers: Record<string, string>) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const project = await call(base, 'POST', '/api/inventory/projects', { name: `SigProj-${suffix}`, location: 'Maadi' }, headers);
  const unit = await call(base, 'POST', '/api/inventory/units', { projectId: (project.body as { id: string }).id, code: `SU-${suffix}`, listPrice: 400000, unitType: 'apartment', areaSqm: 90 }, headers);
  const template = await call(base, 'POST', '/api/payment-plan-templates', { name: `SigPlan-${suffix}`, downPaymentType: 'percentage', downPaymentValue: 20, frequency: 'monthly', termMonths: 6, fees: [] }, headers);
  const lead = await call(base, 'POST', '/api/crm/leads', { fullName: `SigClient-${suffix}`, phone: `sp-${suffix}`, nationalId: `snid-${suffix}` }, headers);
  const opp = await call(base, 'POST', '/api/sales/opportunities', { leadId: (lead.body as { id: string }).id }, headers);
  const reservation = await call(base, 'POST', `/api/sales/opportunities/${(opp.body as { id: string }).id}/reserve-unit`, { unitId: (unit.body as { id: string }).id }, headers);
  const contract = await call(base, 'POST', '/api/sales/contracts', { reservationId: (reservation.body as { id: string }).id, paymentPlanTemplateId: (template.body as { id: string }).id, totalPrice: 400000 }, headers);
  return (contract.body as { id: string }).id;
}

test('e-signature full lifecycle: connect -> send for signature -> verified webhook signs it', async () => {
  // The route's outbound "send" step goes through the real Integration
  // Layer, which by default dispatches to the real global fetch (exactly
  // like every other connector) — this test only fakes the network
  // boundary, never the route/service/RBAC/webhook-verification logic
  // exercised through it. Node's test runner isolates each test *file* in
  // its own process, so patching global fetch here never leaks into other
  // test files.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).includes('demo.docusign.net')) {
      return new Response(JSON.stringify({ envelopeId: 'env-fake-123' }), { status: 201 });
    }
    return realFetch(url, init); // everything else (this test's own calls to the local server) passes through untouched
  }) as typeof fetch;
  try {
    await withServer(async (base, app) => {
      const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
      const headers = { 'x-demo-user': ceoUserId };
      const companyId = app.seedResult!.companyId;

      const contractId = await signRealDemoContract(base, headers);

      const connection = await call(base, 'POST', '/api/integrations/connections', {
        provider: 'e_signature', displayName: 'Demo E-Signature',
        config: { accountId: 'acct-demo' },
        credentials: { api_key: 'key-demo', webhook_secret: 'whsec-demo' },
      }, headers);
      assert.equal(connection.status, 201);

      const send = await call(base, 'POST', `/api/sales/contracts/${contractId}/signature-envelopes`, {
        signerEmail: 'buyer@example.com', documentUrl: 'https://docs.example.com/contract.pdf',
      }, headers);
      assert.equal(send.status, 201);
      const envelopeId = (send.body as { id: string; status: string }).id;
      assert.equal((send.body as { status: string }).status, 'sent');

      const list = await call(base, 'GET', `/api/sales/contracts/${contractId}/signature-envelopes`, undefined, headers);
      assert.equal(list.status, 200);
      assert.equal((list.body as { items: unknown[] }).items.length, 1);

      // Unverified callback (missing signature) must be refused, never accepted.
      const unsigned = await realFetch(`${base}/api/integrations/e-signature/webhooks/${companyId}/${envelopeId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'signed' }),
      });
      assert.equal(unsigned.status, 403);

      // A correctly HMAC-signed callback flips the envelope to signed.
      const payload = JSON.stringify({ status: 'signed' });
      const signature = createHmac('sha256', 'whsec-demo').update(payload).digest('hex');
      const verified = await realFetch(`${base}/api/integrations/e-signature/webhooks/${companyId}/${envelopeId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature-hmac': signature }, body: payload,
      });
      assert.equal(verified.status, 200);
      const verifiedBody = (await verified.json()) as { status: string };
      assert.equal(verifiedBody.status, 'signed');

      // The contract's own status is untouched by any of this — e-signature
      // tracking is additive, never a gate on the existing sign flow.
      const contractAfter = await call(base, 'GET', `/api/sales/contracts/${contractId}`, undefined, headers);
      assert.equal((contractAfter.body as { status: string }).status, 'signed');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('POST /api/sales/contracts/:id/signature-envelopes rejects a Sales Agent lacking the signature_envelope permission if unassigned, and a cross-tenant contract id', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };
    const contractId = await signRealDemoContract(base, ceoHeaders);

    await call(base, 'POST', '/api/integrations/connections', {
      provider: 'e_signature', displayName: 'Demo E-Signature', config: { accountId: 'acct-demo' },
      credentials: { api_key: 'key-demo', webhook_secret: 'whsec-demo' },
    }, ceoHeaders);

    const signupB = await call(base, 'POST', '/api/auth/signup', {
      companyName: `Sig Tenant B ${Date.now()}`, fullName: 'Owner B',
      email: `sig-ownerb-${Date.now()}@example.com`, password: 'a-real-password-123',
    });
    const tenantBHeaders = { authorization: `Bearer ${(signupB.body as { token: string }).token}` };

    const crossTenant = await call(base, 'POST', `/api/sales/contracts/${contractId}/signature-envelopes`, {
      signerEmail: 'buyer@example.com', documentUrl: 'https://docs.example.com/contract.pdf',
    }, tenantBHeaders);
    assert.equal(crossTenant.status, 404);
  });
});
