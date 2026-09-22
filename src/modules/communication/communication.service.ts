import { randomUUID } from 'node:crypto';
import type { Message, MessageChannel, MessageRelatedResource } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';

export interface SendMessageInput {
  companyId: string;
  fromUserId: string;
  toUserId?: string;
  subject: string;
  body: string;
  channel?: MessageChannel;
  relatedResource?: MessageRelatedResource;
  relatedResourceId?: string;
}

/**
 * A real internal message/notification log — not a fake external
 * integration. `channel: 'email' | 'whatsapp' | 'sms'` records the intended
 * channel for a message so the UI/audit trail reflect intent, but no
 * external gateway is called; sending through a real provider remains a
 * documented, not-yet-built integration (see README).
 */
export class CommunicationService {
  constructor(private readonly messages: Repository<Message>) {}

  async sendMessage(input: SendMessageInput): Promise<Message> {
    if (!input.subject?.trim()) throw new ValidationError('subject is required');
    if (!input.body?.trim()) throw new ValidationError('body is required');

    const message: Message = {
      id: randomUUID(),
      companyId: input.companyId,
      relatedResource: input.relatedResource,
      relatedResourceId: input.relatedResourceId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      subject: input.subject.trim(),
      body: input.body.trim(),
      channel: input.channel ?? 'internal',
      status: 'sent',
      createdAt: new Date().toISOString(),
    };
    return this.messages.save(message);
  }

  async listForCompany(companyId: string): Promise<Message[]> {
    return this.messages.findAll((m) => m.companyId === companyId);
  }

  async getMessage(id: string, companyId: string): Promise<Message | undefined> {
    const message = await this.messages.findById(id);
    return message && message.companyId === companyId ? message : undefined;
  }

  async listForUser(userId: string, companyId: string): Promise<Message[]> {
    return this.messages.findAll((m) => m.companyId === companyId && (m.toUserId === userId || m.fromUserId === userId));
  }

  async listForResource(relatedResource: MessageRelatedResource, relatedResourceId: string, companyId: string): Promise<Message[]> {
    return this.messages.findAll(
      (m) => m.companyId === companyId && m.relatedResource === relatedResource && m.relatedResourceId === relatedResourceId,
    );
  }

  async markRead(id: string, companyId: string, readerUserId: string): Promise<Message> {
    const message = await this.messages.findById(id);
    if (!message || message.companyId !== companyId) throw new NotFoundError('message not found');
    if (message.toUserId !== readerUserId) throw new NotFoundError('message not found');
    if (message.status === 'read') return message;
    return this.messages.save({ ...message, status: 'read', readAt: new Date().toISOString() });
  }
}
