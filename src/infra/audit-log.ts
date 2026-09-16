import { randomUUID } from 'node:crypto';
import type { AuditLogEntry } from '../domain/types.js';
import type { Repository } from './repository.js';

// Append-only: no update/delete method is exposed at all.
export class AuditLog {
  constructor(private readonly repo: Repository<AuditLogEntry>) {}

  async record(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<AuditLogEntry> {
    const full: AuditLogEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.repo.save(full);
  }

  async listForCompany(companyId: string): Promise<AuditLogEntry[]> {
    return this.repo.findAll((e) => e.companyId === companyId);
  }
}
