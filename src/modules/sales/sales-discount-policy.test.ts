import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { SalesService } from './sales.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import type { Contract, DiscountApprovalPolicy, Opportunity, PaymentScheduleLine, PaymentPlanTemplate, Project, Reservation, Unit, UnitHold } from '../../domain/types.js';

function freshService() {
  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const units = new InMemoryRepository<Unit>();
  const holds = new InMemoryRepository<UnitHold>();
  const reservations = new InMemoryRepository<Reservation>();
  const projects = new InMemoryRepository<Project>();
  const templates = new InMemoryRepository<PaymentPlanTemplate>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const discountApprovalPolicies = new InMemoryRepository<DiscountApprovalPolicy>();
  const inventory = new InventoryService(units, holds, reservations, projects);
  const paymentPlans = new PaymentPlansService(templates, scheduleLines);
  const svc = new SalesService(opportunities, contracts, inventory, paymentPlans, discountApprovalPolicies);
  return { svc, discountApprovalPolicies };
}

test('setDiscountApprovalPolicy rejects an out-of-range threshold', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.setDiscountApprovalPolicy('c1', -1));
  await assert.rejects(() => svc.setDiscountApprovalPolicy('c1', 101));
});

test('discountRequiresApproval is false when no policy is configured (no behavior change by default)', async () => {
  const { svc } = freshService();
  const requires = await svc.discountRequiresApproval('c1', 50);
  assert.equal(requires, false);
});

test('discountRequiresApproval is false for a discount at or below the configured threshold', async () => {
  const { svc } = freshService();
  await svc.setDiscountApprovalPolicy('c1', 10);
  assert.equal(await svc.discountRequiresApproval('c1', 5), false);
  assert.equal(await svc.discountRequiresApproval('c1', 10), false);
});

test('discountRequiresApproval is true for a discount above the configured threshold', async () => {
  const { svc } = freshService();
  await svc.setDiscountApprovalPolicy('c1', 10);
  assert.equal(await svc.discountRequiresApproval('c1', 15), true);
});

test('discountRequiresApproval is false when no discount is given at all', async () => {
  const { svc } = freshService();
  await svc.setDiscountApprovalPolicy('c1', 10);
  assert.equal(await svc.discountRequiresApproval('c1', undefined), false);
});

test('discountRequiresApproval is scoped per company', async () => {
  const { svc } = freshService();
  await svc.setDiscountApprovalPolicy('c1', 5);
  assert.equal(await svc.discountRequiresApproval('c2', 20), false);
});

test('getDiscountApprovalPolicy returns the saved policy', async () => {
  const { svc } = freshService();
  await svc.setDiscountApprovalPolicy('c1', 7.5);
  const policy = await svc.getDiscountApprovalPolicy('c1');
  assert.equal(policy?.maxDiscountPercentWithoutApproval, 7.5);
});
