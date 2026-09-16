import type { ActionName, ResourceName } from '../../domain/types.js';
import type { RbacEvaluator } from './rbac.evaluator.js';

export const ACTIONS: ActionName[] = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'assign', 'transfer', 'unmask'];
export const RESOURCES: ResourceName[] = [
  'employee',
  'lead',
  'opportunity',
  'unit',
  'payment_plan_template',
  'payment_schedule',
  'contract',
  'broker_company',
  'audit_log',
  'role',
];

export interface PermissionManifestEntry {
  resource: ResourceName;
  action: ActionName;
  allowed: boolean;
  scope: string;
}

export interface PermissionManifest {
  userId: string;
  entries: PermissionManifestEntry[];
}

// Live view of exactly what a user can do, used by GET /api/me/manifest and
// the frontend's Permission Manifest viewer.
export async function buildPermissionManifest(evaluator: RbacEvaluator, userId: string): Promise<PermissionManifest> {
  const entries: PermissionManifestEntry[] = [];
  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      const listScope = await evaluator.getListAccessScope(userId, action, resource);
      entries.push({
        resource,
        action,
        allowed: listScope.kind !== 'none',
        scope: listScope.kind,
      });
    }
  }
  return { userId, entries };
}
