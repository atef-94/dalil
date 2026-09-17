import { randomUUID } from 'node:crypto';
import type { Contract, LegalDocument, LegalDocumentType } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { LegalError, NotFoundError, ValidationError } from '../../infra/errors.js';

export interface AddDocumentInput {
  companyId: string;
  contractId: string;
  type: LegalDocumentType;
  name: string;
  notes?: string;
  uploadedByUserId: string;
}

export class LegalService {
  constructor(
    private readonly documents: Repository<LegalDocument>,
    private readonly contracts: Repository<Contract>,
  ) {}

  async addDocument(input: AddDocumentInput): Promise<LegalDocument> {
    if (!input.name?.trim()) throw new ValidationError('name is required');
    const contract = await this.contracts.findById(input.contractId);
    if (!contract || contract.companyId !== input.companyId) throw new NotFoundError('contract not found');

    const document: LegalDocument = {
      id: randomUUID(),
      companyId: input.companyId,
      contractId: input.contractId,
      type: input.type,
      name: input.name.trim(),
      status: 'pending',
      notes: input.notes?.trim() || undefined,
      uploadedByUserId: input.uploadedByUserId,
      createdAt: new Date().toISOString(),
    };
    return this.documents.save(document);
  }

  async listForContract(contractId: string, companyId: string): Promise<LegalDocument[]> {
    return this.documents.findAll((d) => d.contractId === contractId && d.companyId === companyId);
  }

  async listForCompany(companyId: string): Promise<LegalDocument[]> {
    return this.documents.findAll((d) => d.companyId === companyId);
  }

  async markReceived(id: string, companyId: string): Promise<LegalDocument> {
    const document = await this.documents.findById(id);
    if (!document || document.companyId !== companyId) throw new NotFoundError('document not found');
    if (document.status !== 'pending') {
      throw new LegalError(`only a pending document can be marked received (current status: ${document.status})`);
    }
    return this.documents.save({ ...document, status: 'received' });
  }

  async verifyDocument(id: string, companyId: string): Promise<LegalDocument> {
    const document = await this.documents.findById(id);
    if (!document || document.companyId !== companyId) throw new NotFoundError('document not found');
    if (document.status !== 'received') {
      throw new LegalError(`only a received document can be verified (current status: ${document.status})`);
    }
    return this.documents.save({ ...document, status: 'verified', verifiedAt: new Date().toISOString() });
  }

  async rejectDocument(id: string, companyId: string, notes?: string): Promise<LegalDocument> {
    const document = await this.documents.findById(id);
    if (!document || document.companyId !== companyId) throw new NotFoundError('document not found');
    if (document.status === 'verified') {
      throw new LegalError('a verified document cannot be rejected');
    }
    return this.documents.save({ ...document, status: 'rejected', notes: notes?.trim() || document.notes });
  }
}
