import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { PurchasingService } from './purchasing.service.js';
import type { PurchaseOrder, Vendor } from '../../domain/types.js';

function freshService() {
  const vendors = new InMemoryRepository<Vendor>();
  const purchaseOrders = new InMemoryRepository<PurchaseOrder>();
  return { svc: new PurchasingService(vendors, purchaseOrders) };
}

test('registering a vendor starts active', async () => {
  const { svc } = freshService();
  const vendor = await svc.registerVendor({ companyId: 'c1', name: 'Acme Supplies', category: 'materials' });
  assert.equal(vendor.status, 'active');
});

test('creating a purchase order for a nonexistent vendor is rejected', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.createPurchaseOrder({ companyId: 'c1', vendorId: 'nope', description: 'Cement', amount: 1000, createdByUserId: 'u1' }));
});

test('creating a purchase order for a vendor belonging to a different company is rejected (cross-tenant)', async () => {
  const { svc } = freshService();
  const vendor = await svc.registerVendor({ companyId: 'c1', name: 'Acme Supplies', category: 'materials' });
  await assert.rejects(() => svc.createPurchaseOrder({ companyId: 'c2', vendorId: vendor.id, description: 'Cement', amount: 1000, createdByUserId: 'u1' }));
});

test('creating a purchase order for an inactive vendor is rejected', async () => {
  const { svc } = freshService();
  const vendor = await svc.registerVendor({ companyId: 'c1', name: 'Acme Supplies', category: 'materials' });
  await svc.deactivateVendor(vendor.id, 'c1');
  await assert.rejects(() => svc.createPurchaseOrder({ companyId: 'c1', vendorId: vendor.id, description: 'Cement', amount: 1000, createdByUserId: 'u1' }));
});

test('a new purchase order starts draft', async () => {
  const { svc } = freshService();
  const vendor = await svc.registerVendor({ companyId: 'c1', name: 'Acme Supplies', category: 'materials' });
  const order = await svc.createPurchaseOrder({ companyId: 'c1', vendorId: vendor.id, description: 'Cement', amount: 1000, createdByUserId: 'u1' });
  assert.equal(order.status, 'draft');
});

test('lifecycle: draft -> approved -> fulfilled', async () => {
  const { svc } = freshService();
  const vendor = await svc.registerVendor({ companyId: 'c1', name: 'Acme Supplies', category: 'materials' });
  const order = await svc.createPurchaseOrder({ companyId: 'c1', vendorId: vendor.id, description: 'Cement', amount: 1000, createdByUserId: 'u1' });
  const approved = await svc.approvePurchaseOrder(order.id, 'c1');
  assert.equal(approved.status, 'approved');
  const fulfilled = await svc.fulfillPurchaseOrder(order.id, 'c1');
  assert.equal(fulfilled.status, 'fulfilled');
});

test('fulfilling a draft order is rejected (must be approved first)', async () => {
  const { svc } = freshService();
  const vendor = await svc.registerVendor({ companyId: 'c1', name: 'Acme Supplies', category: 'materials' });
  const order = await svc.createPurchaseOrder({ companyId: 'c1', vendorId: vendor.id, description: 'Cement', amount: 1000, createdByUserId: 'u1' });
  await assert.rejects(() => svc.fulfillPurchaseOrder(order.id, 'c1'));
});

test('cancelling a fulfilled order is rejected', async () => {
  const { svc } = freshService();
  const vendor = await svc.registerVendor({ companyId: 'c1', name: 'Acme Supplies', category: 'materials' });
  const order = await svc.createPurchaseOrder({ companyId: 'c1', vendorId: vendor.id, description: 'Cement', amount: 1000, createdByUserId: 'u1' });
  await svc.approvePurchaseOrder(order.id, 'c1');
  await svc.fulfillPurchaseOrder(order.id, 'c1');
  await assert.rejects(() => svc.cancelPurchaseOrder(order.id, 'c1'));
});

test('approvePurchaseOrder rejects an order belonging to a different company (cross-tenant)', async () => {
  const { svc } = freshService();
  const vendor = await svc.registerVendor({ companyId: 'c1', name: 'Acme Supplies', category: 'materials' });
  const order = await svc.createPurchaseOrder({ companyId: 'c1', vendorId: vendor.id, description: 'Cement', amount: 1000, createdByUserId: 'u1' });
  await assert.rejects(() => svc.approvePurchaseOrder(order.id, 'c2'));
});
