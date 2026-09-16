import { randomUUID } from 'node:crypto';
import type { PurchaseOrder, Vendor } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, PurchasingError, ValidationError } from '../../infra/errors.js';

export interface RegisterVendorInput {
  companyId: string;
  name: string;
  category: string;
  contactPhone?: string;
  contactEmail?: string;
}

export interface CreatePurchaseOrderInput {
  companyId: string;
  vendorId: string;
  projectId?: string;
  description: string;
  amount: number;
  createdByUserId: string;
}

export class PurchasingService {
  constructor(
    private readonly vendors: Repository<Vendor>,
    private readonly purchaseOrders: Repository<PurchaseOrder>,
  ) {}

  async registerVendor(input: RegisterVendorInput): Promise<Vendor> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    if (!input.category?.trim()) throw new ValidationError('category is required');
    const vendor: Vendor = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name.trim(),
      category: input.category.trim(),
      contactPhone: input.contactPhone?.trim() || undefined,
      contactEmail: input.contactEmail?.trim() || undefined,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    return this.vendors.save(vendor);
  }

  async listVendors(companyId: string): Promise<Vendor[]> {
    return this.vendors.findAll((v) => v.companyId === companyId);
  }

  async deactivateVendor(id: string, companyId: string): Promise<Vendor> {
    const vendor = await this.vendors.findById(id);
    if (!vendor || vendor.companyId !== companyId) throw new NotFoundError('vendor not found');
    return this.vendors.save({ ...vendor, status: 'inactive' });
  }

  async createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    if (!input.description?.trim()) throw new ValidationError('description is required');
    if (!(input.amount > 0)) throw new ValidationError('amount must be positive');
    const vendor = await this.vendors.findById(input.vendorId);
    if (!vendor || vendor.companyId !== input.companyId) throw new NotFoundError('vendor not found');
    if (vendor.status !== 'active') throw new PurchasingError('vendor is not active');

    const order: PurchaseOrder = {
      id: randomUUID(),
      companyId: input.companyId,
      vendorId: input.vendorId,
      projectId: input.projectId,
      description: input.description.trim(),
      amount: input.amount,
      status: 'draft',
      createdByUserId: input.createdByUserId,
      createdAt: new Date().toISOString(),
    };
    return this.purchaseOrders.save(order);
  }

  async listPurchaseOrders(companyId: string): Promise<PurchaseOrder[]> {
    return this.purchaseOrders.findAll((p) => p.companyId === companyId);
  }

  async getPurchaseOrder(id: string): Promise<PurchaseOrder | undefined> {
    return this.purchaseOrders.findById(id);
  }

  async approvePurchaseOrder(id: string, companyId: string): Promise<PurchaseOrder> {
    const order = await this.purchaseOrders.findById(id);
    if (!order || order.companyId !== companyId) throw new NotFoundError('purchase order not found');
    if (order.status !== 'draft') throw new PurchasingError(`only a draft order can be approved (current status: ${order.status})`);
    return this.purchaseOrders.save({ ...order, status: 'approved', approvedAt: new Date().toISOString() });
  }

  async fulfillPurchaseOrder(id: string, companyId: string): Promise<PurchaseOrder> {
    const order = await this.purchaseOrders.findById(id);
    if (!order || order.companyId !== companyId) throw new NotFoundError('purchase order not found');
    if (order.status !== 'approved') throw new PurchasingError(`only an approved order can be fulfilled (current status: ${order.status})`);
    return this.purchaseOrders.save({ ...order, status: 'fulfilled', fulfilledAt: new Date().toISOString() });
  }

  async cancelPurchaseOrder(id: string, companyId: string): Promise<PurchaseOrder> {
    const order = await this.purchaseOrders.findById(id);
    if (!order || order.companyId !== companyId) throw new NotFoundError('purchase order not found');
    if (order.status === 'fulfilled' || order.status === 'cancelled') {
      throw new PurchasingError(`a ${order.status} order cannot be cancelled`);
    }
    return this.purchaseOrders.save({ ...order, status: 'cancelled' });
  }
}
