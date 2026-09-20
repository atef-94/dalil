import type { ActionName, ResourceName } from '../../domain/types.js';
import type { RbacEvaluator } from './rbac.evaluator.js';

export const ACTIONS: ActionName[] = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'assign', 'transfer', 'unmask'];
export const RESOURCES: ResourceName[] = [
  'employee',
  'lead',
  'crm_stage',
  'opportunity',
  'unit',
  'quotation',
  'payment_plan_template',
  'payment_schedule',
  'contract',
  'broker_company',
  'audit_log',
  'role',
  'branch',
  'department',
  'project',
  'leave_request',
  'maintenance_ticket',
  'legal_document',
  'vendor',
  'purchase_order',
  'campaign',
  'message',
  'analytics',
  'portal_access',
  'workflow',
  'workflow_run',
  'approval',
  'secret',
  'task',
  'ai_action',
  'integration_connection',
  'sales_commission',
  'forecast',
  'signature_envelope',
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
