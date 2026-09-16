import type { ListScope } from './rbac.evaluator.js';

export interface ScopeOwnerKeys {
  ownerUserId?: string;
  departmentId?: string;
  branchId?: string;
  managerEmployeeId?: string;
  brokerCompanyId?: string;
}

/**
 * Filters a company-scoped list of records down to what `scope` allows.
 * `resolveKeys` looks up the owning employee's department/branch/manager for
 * a given record — callers pass a cheap in-memory lookup since the acting
 * user's own scope is already resolved by getListAccessScope().
 */
export async function filterByListScope<T>(
  items: T[],
  scope: ListScope,
  resolveKeys: (item: T) => Promise<ScopeOwnerKeys>,
): Promise<T[]> {
  if (scope.kind === 'none') return [];
  if (scope.kind === 'company') return items;

  const results: T[] = [];
  for (const item of items) {
    const keys = await resolveKeys(item);
    switch (scope.kind) {
      case 'own':
        if (keys.ownerUserId === scope.userId) results.push(item);
        break;
      case 'department':
        if (keys.departmentId === scope.departmentId) results.push(item);
        break;
      case 'branch':
        if (keys.branchId === scope.branchId) results.push(item);
        break;
      case 'team':
        if (keys.managerEmployeeId === scope.managerEmployeeId) results.push(item);
        break;
      case 'broker_own':
        if (keys.brokerCompanyId === scope.brokerCompanyId) results.push(item);
        break;
    }
  }
  return results;
}
