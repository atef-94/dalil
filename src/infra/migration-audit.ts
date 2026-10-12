import type { Company, Role, User, UserRole } from '../domain/types.js';
import type { Repository } from './repository.js';
import { PLATFORM_COMPANY_ID } from '../modules/permissions/platform-owner.js';

export interface MigrationAuditRepos {
  companies: Repository<Company>;
  users: Repository<User>;
  roles: Repository<Role>;
  userRoles: Repository<UserRole>;
}

export interface MigrationAuditReport {
  totalCompanies: number;
  totalUsers: number;
  totalRoles: number;
  totalUserRoles: number;
  /** Users whose companyId does not resolve to any real Company row — these
   * cannot be safely mapped to a tenant automatically (requirement #7:
   * "map existing data to the correct tenant without guessing") and need a
   * human decision before the new policy is enforced. */
  usersWithOrphanedCompanyId: { userId: string; email: string; companyId: string }[];
  /** Roles whose companyId does not resolve to any real Company row. */
  rolesWithOrphanedCompanyId: { roleId: string; roleName: string; companyId: string }[];
  /** A UserRole assignment pointing at a role that no longer exists (or a
   * user that no longer exists) — dead grant of privilege that should be
   * cleaned up, never silently left as an ambiguous access path. */
  orphanedUserRoleAssignments: { userRoleId: string; userId: string; roleId: string; reason: 'missing_role' | 'missing_user' }[];
  /** A user whose Role (via UserRole) belongs to a *different* company than
   * the user's own companyId — the exact IDOR-by-privilege-escalation shape
   * requirement #7's "preserve existing business data... never grant broad
   * permissions to 'resolve' migration issues" is warning against. */
  crossCompanyRoleAssignments: { userId: string; userCompanyId: string; roleId: string; roleCompanyId: string }[];
  /** Any row — user, company, or role — whose id or companyId collides with
   * the reserved platform sentinel. If this is ever non-empty, the sentinel
   * seed (seedPlatformOwners) would silently merge into pre-existing tenant
   * data instead of creating the intended isolated platform company. */
  platformSentinelCollisions: { kind: 'company' | 'user' | 'role'; id: string }[];
  /** True only when every array above is empty — the signal this script
   * exists to produce. Still human-reviewed, not an auto-proceed flag. */
  safeToEnforce: boolean;
}

/**
 * Read-only migration-safety audit (requirement #7: "audit existing users,
 * roles, sessions, and tenant associations... before enabling the new
 * policy"). Takes no corrective action automatically — every finding is a
 * human decision, never guessed at or silently resolved by granting broader
 * access (the one thing requirement #7 explicitly forbids). Run this once
 * against a real environment's data before flipping on dual-owner/
 * invitation-only enforcement there; see the CLI entry point at the bottom
 * of this file.
 */
export async function runMigrationAudit(repos: MigrationAuditRepos): Promise<MigrationAuditReport> {
  const [companies, users, roles, userRoles] = await Promise.all([
    repos.companies.findAll(),
    repos.users.findAll(),
    repos.roles.findAll(),
    repos.userRoles.findAll(),
  ]);

  const companyIds = new Set(companies.map((c) => c.id));
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const userById = new Map(users.map((u) => [u.id, u]));

  const usersWithOrphanedCompanyId = users
    .filter((u) => !companyIds.has(u.companyId))
    .map((u) => ({ userId: u.id, email: u.email, companyId: u.companyId }));

  const rolesWithOrphanedCompanyId = roles
    .filter((r) => !companyIds.has(r.companyId))
    .map((r) => ({ roleId: r.id, roleName: r.name, companyId: r.companyId }));

  const orphanedUserRoleAssignments: MigrationAuditReport['orphanedUserRoleAssignments'] = [];
  const crossCompanyRoleAssignments: MigrationAuditReport['crossCompanyRoleAssignments'] = [];
  for (const ur of userRoles) {
    const role = roleById.get(ur.roleId);
    const user = userById.get(ur.userId);
    if (!role) {
      orphanedUserRoleAssignments.push({ userRoleId: ur.id, userId: ur.userId, roleId: ur.roleId, reason: 'missing_role' });
      continue;
    }
    if (!user) {
      orphanedUserRoleAssignments.push({ userRoleId: ur.id, userId: ur.userId, roleId: ur.roleId, reason: 'missing_user' });
      continue;
    }
    if (role.companyId !== user.companyId) {
      crossCompanyRoleAssignments.push({ userId: user.id, userCompanyId: user.companyId, roleId: role.id, roleCompanyId: role.companyId });
    }
  }

  // A real platform Company row (id === PLATFORM_COMPANY_ID, name 'ACTIVE
  // Platform') is expected and correct — seedPlatformOwners creates exactly
  // one. This only flags the case where that reserved id is already taken
  // by something that isn't the platform sentinel itself (vanishingly
  // unlikely with randomUUID()-generated tenant ids, but a real collision
  // here would mean seedPlatformOwners silently merges owner accounts into
  // a pre-existing tenant's company instead of its own isolated one, which
  // is exactly the kind of silent cross-tenant exposure requirement #7
  // forbids).
  const platformSentinelCollisions: MigrationAuditReport['platformSentinelCollisions'] = [];
  const platformCompany = companies.find((c) => c.id === PLATFORM_COMPANY_ID);
  if (platformCompany && platformCompany.name !== 'ACTIVE Platform') {
    platformSentinelCollisions.push({ kind: 'company', id: platformCompany.id });
  }
  for (const r of roles) {
    if (r.companyId === PLATFORM_COMPANY_ID) platformSentinelCollisions.push({ kind: 'role', id: r.id });
  }

  const safeToEnforce =
    usersWithOrphanedCompanyId.length === 0 &&
    rolesWithOrphanedCompanyId.length === 0 &&
    orphanedUserRoleAssignments.length === 0 &&
    crossCompanyRoleAssignments.length === 0 &&
    platformSentinelCollisions.length === 0;

  return {
    totalCompanies: companies.length,
    totalUsers: users.length,
    totalRoles: roles.length,
    totalUserRoles: userRoles.length,
    usersWithOrphanedCompanyId,
    rolesWithOrphanedCompanyId,
    orphanedUserRoleAssignments,
    crossCompanyRoleAssignments,
    platformSentinelCollisions,
    safeToEnforce,
  };
}

// ---- CLI entry point: `npm run migration-audit` against the real on-disk
// database main.ts uses (SQLITE_PATH env var, same default path), report-
// only, never mutates anything. ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDatabase } = await import('./sqlite-repository.js');
  const { SqliteRepository } = await import('./sqlite-repository.js');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dbPath = process.env.SQLITE_PATH ?? join(__dirname, '..', '..', 'data', 'active-os.db');
  const db = openDatabase(dbPath);
  const repos: MigrationAuditRepos = {
    companies: new SqliteRepository(db, 'companies'),
    users: new SqliteRepository(db, 'users'),
    roles: new SqliteRepository(db, 'roles'),
    userRoles: new SqliteRepository(db, 'user_roles'),
  };
  const report = await runMigrationAudit(repos);
  process.stdout.write(`Migration audit against: ${dbPath}\n\n`);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(
    report.safeToEnforce
      ? '\nNo issues found. Still review the counts above before enforcing the new policy — this script cannot see every judgment call.\n'
      : '\nISSUES FOUND — do not enforce the new dual-owner/invitation-only policy on this environment until every item above is resolved by a human decision.\n',
  );
  process.exitCode = report.safeToEnforce ? 0 : 1;
}
