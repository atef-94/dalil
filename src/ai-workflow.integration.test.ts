import { test } from 'node:test';
import assert from 'node:assert/strict';
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

/** Real end-to-end exercise of the AI Workflow / Agentic Orchestration
 * Engine over actual HTTP: create a lead with real requirement/budget
 * fields, real matching inventory, and a real payment plan template, opt
 * the relevant action types into auto_execute, start the workflow through
 * the API, and confirm it genuinely walks the multi-step plan (not a
 * mock) — asserted against the real steps/run returned by the API, not a
 * hardcoded expectation. */
test('AI Workflow Engine: full lead-followup plan runs over real HTTP, waits, then completes on a real reply', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const headers = { 'x-demo-user': ceoUserId };
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    const project = await call(base, 'POST', '/api/inventory/projects', { name: `AiwfProj-${suffix}` }, headers);
    assert.equal(project.status, 201);
    const unit = await call(base, 'POST', '/api/inventory/units', {
      projectId: (project.body as { id: string }).id, code: `AIWF-${suffix}`, unitType: 'apartment', areaSqm: 110, listPrice: 1_200_000,
    }, headers);
    assert.equal(unit.status, 201);

    const template = await call(base, 'POST', '/api/payment-plan-templates', {
      name: `AiwfPlan-${suffix}`, downPaymentType: 'percentage', downPaymentValue: 10, frequency: 'monthly', termMonths: 12, fees: [],
    }, headers);
    assert.equal(template.status, 201);

    const stagesRes = await call(base, 'GET', '/api/crm/stages', undefined, headers);
    assert.equal(stagesRes.status, 200);
    const stages = (stagesRes.body as { items?: { id: string; key: string }[] }).items ?? (stagesRes.body as { id: string; key: string }[]);
    const qualifiedStage = (stages as { id: string; key: string }[]).find((s) => s.key === 'qualified')!;
    assert.ok(qualifiedStage, 'expected a seeded "qualified" stage');

    const leadRes = await call(base, 'POST', '/api/crm/leads', {
      fullName: `AI Workflow Lead ${suffix}`, phone: `+2010${suffix}`.slice(0, 14), email: `lead-${suffix}@example.com`,
      sourceId: 'campaign-aiwf', stageId: qualifiedStage.id, ownerEmployeeUserId: ceoUserId,
    }, headers);
    assert.equal(leadRes.status, 201);
    const lead = leadRes.body as { id: string; stageId: string };

    // Requirement/budget fields are captured progressively via the
    // dedicated details endpoint, not at creation time.
    const detailsRes = await call(base, 'PATCH', `/api/crm/leads/${lead.id}/details`, {
      propertyTypeWanted: 'apartment', minAreaSqm: 80, maxAreaSqm: 140, maxDownPayment: 200_000, maxInstallment: 100_000,
    }, headers);
    assert.equal(detailsRes.status, 200);

    // Opt the relevant action types into auto_execute so the workflow can
    // actually complete its steps instead of pausing on every one.
    for (const actionType of ['create_task', 'send_message', 'update_lead_status']) {
      const policyRes = await call(base, 'POST', '/api/ai/policies', { actionType, autonomyLevel: 'auto_execute' }, headers);
      assert.equal(policyRes.status, 200);
    }

    const startRes = await call(base, 'POST', '/api/ai/workflows', { goalType: 'high_value_lead_followup', subjectId: lead.id }, headers);
    assert.equal(startRes.status, 201);
    const run = startRes.body as { id: string; status: string; currentStepName?: string; resumeAt?: string };
    assert.equal(run.status, 'waiting');
    assert.equal(run.currentStepName, 'wait_for_response');
    assert.ok(run.resumeAt);

    const stepsRes = await call(base, 'GET', `/api/ai/workflows/${run.id}/steps`, undefined, headers);
    assert.equal(stepsRes.status, 200);
    const steps = stepsRes.body as { stepName: string; status: string }[];
    assert.deepEqual(steps.map((s) => s.stepName), [
      'analyze_lead', 'retrieve_history', 'identify_requirements', 'match_suitable_units',
      'analyze_payment_plans', 'select_sales_agent', 'create_task', 'generate_personalized_message',
      'send_message', 'wait_for_response',
    ]);
    assert.ok(steps.every((s) => s.status === 'succeeded'));

    const getRunRes = await call(base, 'GET', `/api/ai/workflows/${run.id}`, undefined, headers);
    assert.equal(getRunRes.status, 200);
    assert.equal((getRunRes.body as { status: string }).status, 'waiting');

    const listRes = await call(base, 'GET', `/api/ai/workflows?subjectId=${lead.id}`, undefined, headers);
    assert.equal(listRes.status, 200);
    const listedItems = (listRes.body as { items?: { id: string }[] }).items ?? (listRes.body as { id: string }[]);
    assert.ok((listedItems as { id: string }[]).some((r) => r.id === run.id));

    // A real reply gets logged internally against the lead by someone
    // other than the requester (run.requestedByUserId is the CEO here, so
    // the reply must come from a different user for "check_response" to
    // recognize it as genuine engagement).
    const salesManagerUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Manager')!.userId;
    const replyRes = await call(base, 'POST', '/api/communication/messages', {
      toUserId: ceoUserId, subject: 'Re: interested', body: 'Yes please, when can we view it?',
      relatedResource: 'lead', relatedResourceId: lead.id,
    }, { 'x-demo-user': salesManagerUserId });
    assert.equal(replyRes.status, 201);

    const resumeRes = await call(base, 'POST', `/api/ai/workflows/${run.id}/resume`, undefined, headers);
    assert.equal(resumeRes.status, 200);
    const resumed = resumeRes.body as { status: string; outcomeSummary?: string };
    assert.equal(resumed.status, 'completed');
    assert.match(resumed.outcomeSummary ?? '', /replied and was moved to/);

    const leadAfter = await call(base, 'GET', `/api/crm/leads/${lead.id}`, undefined, headers);
    assert.equal(leadAfter.status, 200);
    assert.notEqual((leadAfter.body as { stageId: string }).stageId, qualifiedStage.id);
  });
});

test('AI Workflow Engine rejects a request from a user without create:ai_action permission', async () => {
  await withServer(async (base, app) => {
    // The seeded Finance role carries no ai_action grants at all (see
    // seed.ts) — a genuine, unambiguous deny case, not a scope edge case.
    const financeUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Finance')!.userId;
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const leadRes = await call(base, 'POST', '/api/crm/leads', {
      fullName: 'Someone Elses Lead', phone: `+2011${Date.now()}`.slice(0, 14),
    }, { 'x-demo-user': ceoUserId });
    assert.equal(leadRes.status, 201);
    const lead = leadRes.body as { id: string };

    const startRes = await call(base, 'POST', '/api/ai/workflows', { goalType: 'high_value_lead_followup', subjectId: lead.id }, { 'x-demo-user': financeUserId });
    assert.equal(startRes.status, 403);
    assert.match(JSON.stringify(startRes.body), /permission/i);

    // Cross-tenant: a run created under one company is invisible to a
    // fresh, unrelated company/user pair even with a valid create grant.
    const startedRes = await call(base, 'POST', '/api/ai/workflows', { goalType: 'high_value_lead_followup', subjectId: lead.id }, { 'x-demo-user': ceoUserId });
    assert.equal(startedRes.status, 201);
    const runId = (startedRes.body as { id: string }).id;

    const otherSignup = await call(base, 'POST', '/api/auth/signup', {
      companyName: `Other Co ${Date.now()}`, fullName: 'Other CEO', email: `other-${Date.now()}@example.com`, password: 'Passw0rd!123',
    });
    const otherToken = (otherSignup.body as { token: string }).token;
    const getRes = await call(base, 'GET', `/api/ai/workflows/${runId}`, undefined, { Authorization: `Bearer ${otherToken}` });
    assert.equal(getRes.status, 404);
  });
});
