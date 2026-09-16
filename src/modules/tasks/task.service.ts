import { randomUUID } from 'node:crypto';
import type { MessageRelatedResource, Task } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { AutomationError, NotFoundError, ValidationError } from '../../infra/errors.js';

export interface CreateTaskInput {
  companyId: string;
  title: string;
  description?: string;
  dueAt?: string;
  assignedToUserId?: string;
  relatedResource?: MessageRelatedResource;
  relatedResourceId?: string;
  createdByUserId: string;
}

export class TaskService {
  constructor(private readonly tasks: Repository<Task>) {}

  async createTask(input: CreateTaskInput): Promise<Task> {
    if (!input.title?.trim()) throw new ValidationError('title is required');
    const task: Task = {
      id: randomUUID(),
      companyId: input.companyId,
      title: input.title.trim(),
      description: input.description?.trim() || undefined,
      dueAt: input.dueAt,
      assignedToUserId: input.assignedToUserId,
      relatedResource: input.relatedResource,
      relatedResourceId: input.relatedResourceId,
      status: 'open',
      createdByUserId: input.createdByUserId,
      createdAt: new Date().toISOString(),
    };
    return this.tasks.save(task);
  }

  async listForCompany(companyId: string): Promise<Task[]> {
    return this.tasks.findAll((t) => t.companyId === companyId);
  }

  async listForUser(userId: string, companyId: string): Promise<Task[]> {
    return this.tasks.findAll((t) => t.companyId === companyId && t.assignedToUserId === userId);
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.findById(id);
  }

  async completeTask(id: string, companyId: string): Promise<Task> {
    const task = await this.tasks.findById(id);
    if (!task || task.companyId !== companyId) throw new NotFoundError('task not found');
    if (task.status !== 'open') throw new AutomationError(`only an open task can be completed (current status: ${task.status})`);
    return this.tasks.save({ ...task, status: 'done', completedAt: new Date().toISOString() });
  }

  async cancelTask(id: string, companyId: string): Promise<Task> {
    const task = await this.tasks.findById(id);
    if (!task || task.companyId !== companyId) throw new NotFoundError('task not found');
    if (task.status !== 'open') throw new AutomationError(`only an open task can be cancelled (current status: ${task.status})`);
    return this.tasks.save({ ...task, status: 'cancelled' });
  }
}
