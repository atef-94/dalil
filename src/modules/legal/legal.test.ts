import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { LegalService } from './legal.service.js';
import type { Contract, LegalDocument } from '../../domain/types.js';

function freshService() {
  const contracts = new InMemoryRepository<Contract>();
  const documents = new InMemoryRepository<LegalDocument>();
  return { svc: new LegalService(documents, contracts), contracts };
}

async function seedContract(contracts: InMemoryRepository<Contract>, companyId = 'c1'): Promise<Contract> {
  return contracts.save({
    id: 'contract-1',
    companyId,
    reservationId: 'res-1',
    unitId: 'unit-1',
    clientId: 'lead-1',
    creditedEmployeeUserId: 'u1',
    paymentPlanTemplateId: 'tpl-1',
    status: 'signed',
    createdAt: new Date().toISOString(),
  });
}

test('adding a document for a nonexistent contract is rejected', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.addDocument({ companyId: 'c1', contractId: 'nope', type: 'title_deed', name: 'Deed.pdf', uploadedByUserId: 'u1' }));
});

test('adding a document for a contract belonging to a different company is rejected (cross-tenant)', async () => {
  const { svc, contracts } = freshService();
  await seedContract(contracts, 'c1');
  await assert.rejects(() => svc.addDocument({ companyId: 'c2', contractId: 'contract-1', type: 'title_deed', name: 'Deed.pdf', uploadedByUserId: 'u1' }));
});

test('a new document starts pending', async () => {
  const { svc, contracts } = freshService();
  await seedContract(contracts);
  const doc = await svc.addDocument({ companyId: 'c1', contractId: 'contract-1', type: 'title_deed', name: 'Deed.pdf', uploadedByUserId: 'u1' });
  assert.equal(doc.status, 'pending');
});

test('lifecycle: pending -> received -> verified', async () => {
  const { svc, contracts } = freshService();
  await seedContract(contracts);
  const doc = await svc.addDocument({ companyId: 'c1', contractId: 'contract-1', type: 'title_deed', name: 'Deed.pdf', uploadedByUserId: 'u1' });
  const received = await svc.markReceived(doc.id, 'c1');
  assert.equal(received.status, 'received');
  const verified = await svc.verifyDocument(doc.id, 'c1');
  assert.equal(verified.status, 'verified');
  assert.ok(verified.verifiedAt);
});

test('verifying a still-pending document is rejected', async () => {
  const { svc, contracts } = freshService();
  await seedContract(contracts);
  const doc = await svc.addDocument({ companyId: 'c1', contractId: 'contract-1', type: 'nda', name: 'NDA.pdf', uploadedByUserId: 'u1' });
  await assert.rejects(() => svc.verifyDocument(doc.id, 'c1'));
});

test('rejecting a verified document is rejected', async () => {
  const { svc, contracts } = freshService();
  await seedContract(contracts);
  const doc = await svc.addDocument({ companyId: 'c1', contractId: 'contract-1', type: 'nda', name: 'NDA.pdf', uploadedByUserId: 'u1' });
  await svc.markReceived(doc.id, 'c1');
  await svc.verifyDocument(doc.id, 'c1');
  await assert.rejects(() => svc.rejectDocument(doc.id, 'c1'));
});

test('markReceived rejects a document belonging to a different company (cross-tenant)', async () => {
  const { svc, contracts } = freshService();
  await seedContract(contracts);
  const doc = await svc.addDocument({ companyId: 'c1', contractId: 'contract-1', type: 'nda', name: 'NDA.pdf', uploadedByUserId: 'u1' });
  await assert.rejects(() => svc.markReceived(doc.id, 'c2'));
});

test('listForContract returns only that contract\'s documents, scoped to the company', async () => {
  const { svc, contracts } = freshService();
  await seedContract(contracts);
  await contracts.save({ id: 'contract-2', companyId: 'c1', reservationId: 'res-2', unitId: 'unit-2', clientId: 'lead-2', creditedEmployeeUserId: 'u1', paymentPlanTemplateId: 'tpl-1', status: 'signed', createdAt: new Date().toISOString() });
  await svc.addDocument({ companyId: 'c1', contractId: 'contract-1', type: 'title_deed', name: 'A', uploadedByUserId: 'u1' });
  await svc.addDocument({ companyId: 'c1', contractId: 'contract-2', type: 'title_deed', name: 'B', uploadedByUserId: 'u1' });
  const results = await svc.listForContract('contract-1', 'c1');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.name, 'A');
});
