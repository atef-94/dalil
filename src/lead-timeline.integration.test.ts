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

interface TimelineEntry {
  type: string;
  at: string;
  summary: string;
  actorUserId?: string;
  actorName: string;
  actorType: string;
  detail?: Record<string, unknown>;
}
interface TimelinePage {
  items: TimelineEntry[];
  total: number;
  limit: number;
  offset: number;
}

test('Lead Timeline: the exact user-specified flow produces a complete, correctly-ordered, non-destructive history', async () => {
  await withServer(async (base, app) => {
    const ceoUserId = app.seedResult!.demoUsers.find((u) => u.label === 'CEO')!.userId;
    const salesAgentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
    const ceoHeaders = { 'x-demo-user': ceoUserId };

    // 1. Create Lead
    const leadRes = await call(base, 'POST', '/api/crm/leads', { fullName: 'Journey Client', phone: `01${Date.now()}`, ownerEmployeeUserId: ceoUserId }, ceoHeaders);
    assert.equal(leadRes.status, 201);
    const leadId = (leadRes.body as { id: string }).id;

    // 2. Add Comment
    const commentRes = await call(base, 'POST', '/api/communication/messages', {
      subject: 'Note', body: 'Client requested a 3-bedroom unit in October with a low down payment.',
      channel: 'note', relatedResource: 'lead', relatedResourceId: leadId,
    }, ceoHeaders);
    assert.equal(commentRes.status, 201);

    // 3. Change Stage (with a related reason/comment on the transition itself)
    const stagesRes = await call(base, 'GET', '/api/crm/stages', undefined, ceoHeaders);
    const stages = stagesRes.body as { id: string; key: string; name: string }[];
    const negotiation = stages.find((s) => s.key === 'meeting')!;
    const stageRes = await call(base, 'PATCH', `/api/crm/leads/${leadId}/stage`, { stageId: negotiation.id, note: 'Client confirmed budget, moving to meeting' }, ceoHeaders);
    assert.equal(stageRes.status, 200);

    // 4. Add Follow-up
    const taskRes = await call(base, 'POST', '/api/tasks', { title: 'Call back about pricing', relatedResource: 'lead', relatedResourceId: leadId }, ceoHeaders);
    assert.equal(taskRes.status, 201);
    const taskId = (taskRes.body as { id: string }).id;

    // 5. Complete Follow-up
    const completeRes = await call(base, 'POST', `/api/tasks/${taskId}/complete`, undefined, ceoHeaders);
    assert.equal(completeRes.status, 200);

    // 6. Change Owner
    const ownerRes = await call(base, 'PATCH', `/api/crm/leads/${leadId}/owner`, { ownerEmployeeUserId: salesAgentUserId }, ceoHeaders);
    assert.equal(ownerRes.status, 200);

    // 7. Update Budget (a real custom field — maxDownPayment)
    const detailsRes = await call(base, 'PATCH', `/api/crm/leads/${leadId}/details`, { maxDownPayment: 500000 }, ceoHeaders);
    assert.equal(detailsRes.status, 200);
    const detailsRes2 = await call(base, 'PATCH', `/api/crm/leads/${leadId}/details`, { maxDownPayment: 650000 }, ceoHeaders);
    assert.equal(detailsRes2.status, 200);

    // 8. Add another Comment
    const comment2Res = await call(base, 'POST', '/api/communication/messages', {
      subject: 'Call logged', body: 'Called client to confirm updated budget.', channel: 'call', relatedResource: 'lead', relatedResourceId: leadId,
    }, ceoHeaders);
    assert.equal(comment2Res.status, 201);

    // 9. Move to another Stage
    const proposal = stages.find((s) => s.key === 'offers')!;
    const stage2Res = await call(base, 'PATCH', `/api/crm/leads/${leadId}/stage`, { stageId: proposal.id }, ceoHeaders);
    assert.equal(stage2Res.status, 200);

    // ---- Verify the full timeline ----
    const timelineRes = await call(base, 'GET', `/api/crm/leads/${leadId}/timeline?limit=100`, undefined, ceoHeaders);
    assert.equal(timelineRes.status, 200);
    const page = timelineRes.body as TimelinePage;

    // Newest first.
    const types = page.items.map((e) => e.type);
    assert.equal(types[0], 'stage_changed'); // the very last thing that happened
    assert.ok(Date.parse(page.items[0]!.at) >= Date.parse(page.items[page.items.length - 1]!.at));
    for (let i = 1; i < page.items.length; i++) {
      assert.ok(Date.parse(page.items[i - 1]!.at) >= Date.parse(page.items[i]!.at), 'entries must be strictly newest-first');
    }

    // Every event from the script is present.
    assert.ok(types.includes('lead_created'));
    assert.ok(types.filter((t) => t === 'message').length === 2, 'both comments must be permanently kept, never overwritten');
    assert.ok(types.filter((t) => t === 'stage_changed').length === 2, 'both stage moves must be kept as separate history rows');
    assert.ok(types.includes('task_created'));
    assert.ok(types.includes('task_completed'));
    assert.ok(types.includes('owner_changed'));
    assert.ok(types.filter((t) => t === 'lead_updated').length === 2, 'both budget edits recorded separately, not collapsed');

    // Stage-change detail: previous/new stage, time-in-previous-stage, and the note.
    const firstStageChange = page.items.find((e) => e.type === 'stage_changed' && e.detail?.toStageId === negotiation.id)!;
    assert.equal(firstStageChange.detail!.note, 'Client confirmed budget, moving to meeting');
    assert.ok(typeof firstStageChange.detail!.timeInPreviousStageMs === 'number' && (firstStageChange.detail!.timeInPreviousStageMs as number) >= 0);

    // Budget change detail: real previous/new values, not just a flag.
    const budgetChanges = page.items.filter((e) => e.type === 'lead_updated');
    const firstBudgetChange = budgetChanges[budgetChanges.length - 1]!; // oldest of the two, since list is newest-first
    assert.deepEqual((firstBudgetChange.detail!.previousValues as Record<string, unknown>).maxDownPayment, undefined);
    assert.equal((firstBudgetChange.detail!.newValues as Record<string, unknown>).maxDownPayment, 500000);
    const secondBudgetChange = budgetChanges[0]!;
    assert.equal((secondBudgetChange.detail!.previousValues as Record<string, unknown>).maxDownPayment, 500000);
    assert.equal((secondBudgetChange.detail!.newValues as Record<string, unknown>).maxDownPayment, 650000);

    // Owner-change detail carries both the previous and new owner.
    const ownerChange = page.items.find((e) => e.type === 'owner_changed')!;
    assert.equal(ownerChange.detail!.newOwnerUserId, salesAgentUserId);
    assert.equal(ownerChange.detail!.previousOwnerUserId, ceoUserId);

    // Every entry names a real actor, resolved to a name — not just a raw id.
    for (const entry of page.items) {
      assert.ok(entry.actorName && entry.actorName.length > 0);
    }
    const ceoEntry = page.items.find((e) => e.actorUserId === ceoUserId)!;
    assert.notEqual(ceoEntry.actorName, ceoUserId, 'actor name must be resolved, not the raw user id');

    // ---- Filters ----
    const byType = await call(base, 'GET', `/api/crm/leads/${leadId}/timeline?type=message`, undefined, ceoHeaders);
    const byTypePage = byType.body as TimelinePage;
    assert.ok(byTypePage.items.every((e) => e.type === 'message'));
    assert.equal(byTypePage.items.length, 2);

    const bySearch = await call(base, 'GET', `/api/crm/leads/${leadId}/timeline?q=budget`, undefined, ceoHeaders);
    const bySearchPage = bySearch.body as TimelinePage;
    assert.ok(bySearchPage.items.length >= 1);

    const byUser = await call(base, 'GET', `/api/crm/leads/${leadId}/timeline?userId=${ceoUserId}`, undefined, ceoHeaders);
    const byUserPage = byUser.body as TimelinePage;
    assert.ok(byUserPage.items.length > 0);
    assert.ok(byUserPage.items.every((e) => e.actorUserId === ceoUserId));

    // ---- Pagination ----
    const page1 = await call(base, 'GET', `/api/crm/leads/${leadId}/timeline?limit=2&offset=0`, undefined, ceoHeaders);
    const page1Body = page1.body as TimelinePage;
    assert.equal(page1Body.items.length, 2);
    assert.equal(page1Body.limit, 2);
    assert.ok(page1Body.total >= 9);
  });
});
