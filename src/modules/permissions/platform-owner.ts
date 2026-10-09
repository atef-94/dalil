/**
 * Platform-owner identity is derived by comparing an email against the two
 * boot-configured owner addresses (OWNER_EMAIL_1/OWNER_EMAIL_2) — it is
 * never stored as a mutable flag on any row. There is no `User.isOwner`
 * column, no grantable "platform" resource, and no code path that writes
 * owner status anywhere: the only way to become a platform owner is for an
 * operator to set the env var and restart the process. This is what
 * guarantees no ordinary user, tenant admin, or API request can ever
 * self-grant or be granted owner privileges — there is nothing to mutate.
 *
 * Owners still have a real `User` row (for password/MFA) scoped to the
 * sentinel `PLATFORM_COMPANY_ID` company (see infra/seed.ts's
 * seedPlatformOwners) — that row carries no Role/PermissionGrant at all,
 * since the tenant-scoped RBAC grant system has no platform concept (see
 * RbacEvaluator). Routes that need "is this caller a platform owner"
 * authorization call isPlatformOwner(actor.email) directly, entirely
 * outside rbac.can().
 */
export function isPlatformOwner(email: string, ownerEmails: readonly [string, string]): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return ownerEmails.some((owner) => owner.trim().toLowerCase() === normalized);
}

/** The sentinel Company every platform owner's User.companyId points at.
 * Must be a real, seeded Company row (Company.id === Company.companyId is
 * an existing invariant — domain/types.ts), never a bare string, so any
 * code that resolves a user's company by id still finds a real row. Because
 * this is a real companyId distinct from every tenant's, RbacEvaluator's
 * existing cross-tenant wall (target.companyId !== user.companyId -> deny)
 * already blocks an owner from every tenant-scoped resource automatically. */
export const PLATFORM_COMPANY_ID = '__platform__';
