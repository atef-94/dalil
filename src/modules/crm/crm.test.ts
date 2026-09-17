import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { CrmService } from './crm.service.js';
import type { Lead } from '../../domain/types.js';

function freshService() {
  return new CrmService(new InMemoryRepository<Lead>());
}

test('creating a lead with a duplicate phone in the same company is rejected', async () => {
  const svc = freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.createLead({ companyId: 'c1', fullName: 'Client B', phone: '0100' }));
});

test('creating a lead with a duplicate email in the same company is rejected', async () => {
  const svc = freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', email: 'a@x.com' });
  await assert.rejects(() => svc.createLead({ companyId: 'c1', fullName: 'Client B', phone: '0200', email: 'a@x.com' }));
});

test('dedup is scoped per company: the same phone is allowed in a different company', async () => {
  const svc = freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const second = await svc.createLead({ companyId: 'c2', fullName: 'Client B', phone: '0100' });
  assert.equal(second.phone, '0100');
});

test('lead status only transitions forward, never backward', async () => {
  const svc = freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  await svc.updateStatus(lead.id, 'contacted');
  await svc.updateStatus(lead.id, 'qualified');
  await assert.rejects(() => svc.updateStatus(lead.id, 'contacted'));
});

test('marking a lead lost requires a lostReason and locks it from further changes', async () => {
  const svc = freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.updateStatus(lead.id, 'lost'));
  const lost = await svc.updateStatus(lead.id, 'lost', 'Went with a competitor');
  assert.equal(lost.status, 'lost');
  assert.equal(lost.lostReason, 'Went with a competitor');
  await assert.rejects(() => svc.updateStatus(lead.id, 'contacted'));
});

test('assignOwner reassigns a lead to a new owner', async () => {
  const svc = freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  const reassigned = await svc.assignOwner(lead.id, 'c1', 'emp-2');
  assert.equal(reassigned.ownerEmployeeUserId, 'emp-2');
});

test('assignOwner rejects a lead belonging to a different company (cross-tenant)', async () => {
  const svc = freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.assignOwner(lead.id, 'c2', 'emp-2'));
});

test('creating a lead with a duplicate national ID is rejected even when phone and email differ', async () => {
  const svc = freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', email: 'a@x.com', nationalId: 'NID-1' });
  await assert.rejects(() => svc.createLead({ companyId: 'c1', fullName: 'Client B (same person, fake details)', phone: '0999', email: 'fake@x.com', nationalId: 'NID-1' }));
});

test('national ID dedup is scoped per company, like phone/email', async () => {
  const svc = freshService();
  await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', nationalId: 'NID-1' });
  const second = await svc.createLead({ companyId: 'c2', fullName: 'Client B', phone: '0200', nationalId: 'NID-1' });
  assert.equal(second.nationalId, 'NID-1');
});

test('resolveCommissionOwner returns the original owner within the 60-day protection window, even after reassignment', async () => {
  const svc = freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', ownerEmployeeUserId: 'agent-original' });
  await svc.assignOwner(lead.id, 'c1', 'agent-new');
  const day30 = new Date(Date.parse(lead.createdAt) + 30 * 24 * 60 * 60 * 1000);
  const owner = await svc.resolveCommissionOwner(lead.id, 'c1', day30);
  assert.equal(owner, 'agent-original');
});

test('resolveCommissionOwner falls back to the current owner once the 60-day window has passed', async () => {
  const svc = freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', ownerEmployeeUserId: 'agent-original' });
  await svc.assignOwner(lead.id, 'c1', 'agent-new');
  const day61 = new Date(Date.parse(lead.createdAt) + 61 * 24 * 60 * 60 * 1000);
  const owner = await svc.resolveCommissionOwner(lead.id, 'c1', day61);
  assert.equal(owner, 'agent-new');
});

test('resolveCommissionOwner returns the current owner unchanged when the lead was never reassigned', async () => {
  const svc = freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100', ownerEmployeeUserId: 'agent-1' });
  const owner = await svc.resolveCommissionOwner(lead.id, 'c1');
  assert.equal(owner, 'agent-1');
});

test('resolveCommissionOwner rejects a lead belonging to a different company (cross-tenant)', async () => {
  const svc = freshService();
  const lead = await svc.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });
  await assert.rejects(() => svc.resolveCommissionOwner(lead.id, 'c2'));
});
