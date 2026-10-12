import { randomUUID } from 'node:crypto';
import type { Company, PasswordResetToken, User, UserType } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { hashPassword, verifyPassword, signToken, encryptSecret, decryptSecret, hashToken, generateRawToken } from '../../infra/security.js';
import { generateTotpSecret, verifyTotpCode, buildTotpUri, generateRecoveryCodes } from '../../infra/totp.js';
import { SlidingWindowRateLimiter } from '../../infra/rate-limiter.js';
import { ValidationError, TokenError, NotFoundError, RateLimitError } from '../../infra/errors.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
// Keyed by companyId:email, independent of the IP-keyed rate limiter at the
// HTTP layer (http-server.ts) — this one throttles repeated attempts
// against one specific account regardless of how many different IPs they
// come from, which an IP-only limiter cannot do.
const LOGIN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = 15;

export interface RegisterInput {
  companyId: string;
  email: string;
  password: string;
  userType: UserType;
  locale: 'en' | 'ar';
  employeeId?: string;
  brokerEmployeeId?: string;
  brokerCompanyId?: string;
  customerId?: string;
}

export interface LoginInput {
  companyId: string;
  email: string;
  password: string;
  /** Required on this same endpoint (re-submit the identical call with this
   * filled in) whenever the account has totpEnabled — see login()'s
   * 'mfa_required' branch below. Accepts either a live 6-digit TOTP code or
   * one of the user's one-time recovery codes. */
  totpCode?: string;
}

export class AuthService {
  private readonly loginRateLimiter = new SlidingWindowRateLimiter(LOGIN_RATE_LIMIT_WINDOW_MS, LOGIN_RATE_LIMIT_MAX);

  constructor(
    private readonly users: Repository<User>,
    private readonly tokenSecret: string,
    private readonly companies?: Repository<Company>,
    /** Key for encrypting totpSecretEncrypted at rest (infra/security.ts
     * encryptSecret). Falls back to tokenSecret when unset, same convention
     * as AutomationService's secretStoreKey (see app.ts). */
    private readonly encryptionSecret?: string,
    private readonly passwordResetTokens?: Repository<PasswordResetToken>,
  ) {}

  private get secretKey(): string {
    return this.encryptionSecret ?? this.tokenSecret;
  }

  private validateCredentials(email: string, password: string): void {
    if (!EMAIL_PATTERN.test(email)) {
      throw new ValidationError('invalid email format');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  async register(input: RegisterInput): Promise<User> {
    this.validateCredentials(input.email, input.password);
    const email = input.email.trim().toLowerCase();

    // Unique per (companyId, email), not globally unique.
    const existing = await this.users.findAll((u) => u.companyId === input.companyId && u.email === email);
    if (existing.length > 0) {
      throw new ValidationError('a user with this email already exists in this company');
    }

    const user: User = {
      id: randomUUID(),
      companyId: input.companyId,
      email,
      passwordHash: hashPassword(input.password),
      userType: input.userType,
      employeeId: input.employeeId,
      brokerEmployeeId: input.brokerEmployeeId,
      brokerCompanyId: input.brokerCompanyId,
      customerId: input.customerId,
      locale: input.locale,
      failedLoginCount: 0,
      createdAt: new Date().toISOString(),
      totpEnabled: false,
    };
    return this.users.save(user);
  }

  async login(input: LoginInput): Promise<{ token: string; user: User }> {
    const email = input.email.trim().toLowerCase();

    if (!this.loginRateLimiter.consume(`${input.companyId}:${email}`).allowed) {
      throw new RateLimitError('too many login attempts for this account, try again later');
    }

    const [user] = await this.users.findAll((u) => u.companyId === input.companyId && u.email === email);

    // Constant-shaped failure: don't reveal whether the account exists.
    if (!user) {
      throw new TokenError('invalid email or password');
    }

    const now = Date.now();
    if (user.lockedUntil && Date.parse(user.lockedUntil) > now) {
      throw new TokenError('account locked due to too many failed login attempts, try again later');
    }

    // Platform-owner-controlled suspension (see platform-admin.service.ts) —
    // blocks every login for every user in a suspended company without
    // deleting any data. Checked before the password itself so a suspended
    // tenant's users get the same generic failure either way (no signal
    // about whether the password was even right).
    if (this.companies) {
      const company = await this.companies.findById(user.companyId);
      if (company?.status === 'suspended') {
        throw new TokenError('this company has been suspended');
      }
    }

    const valid = verifyPassword(input.password, user.passwordHash);
    if (!valid) {
      const failedLoginCount = user.failedLoginCount + 1;
      const locked = failedLoginCount >= MAX_FAILED_ATTEMPTS;
      const updated: User = {
        ...user,
        failedLoginCount: locked ? 0 : failedLoginCount,
        lockedUntil: locked ? new Date(now + LOCKOUT_WINDOW_MS).toISOString() : user.lockedUntil,
      };
      await this.users.save(updated);
      throw new TokenError('invalid email or password');
    }

    // MFA, checked only after the password is already confirmed correct —
    // same single-endpoint retry shape as the rest of login(): a missing
    // code gets a distinct 'mfa_required' response so the client knows to
    // re-submit this exact call with totpCode filled in, rather than a
    // second pending-token type with its own TTL/verify function. A wrong
    // code (or a wrong recovery code) increments the same failedLoginCount/
    // lockout counter as a wrong password — deliberately reusing it instead
    // of a parallel MFA-attempt counter.
    let recoveryCodesAfterLogin = user.recoveryCodesHashed;
    if (user.totpEnabled) {
      if (!input.totpCode) {
        throw new TokenError('mfa_required');
      }
      const secret = user.totpSecretEncrypted ? decryptSecret(user.totpSecretEncrypted, this.secretKey) : undefined;
      const totpValid = secret ? verifyTotpCode(secret, input.totpCode) : false;
      const recoveryCodeIndex = !totpValid
        ? (user.recoveryCodesHashed ?? []).findIndex((hashed) => verifyPassword(input.totpCode!, hashed))
        : -1;
      if (!totpValid && recoveryCodeIndex === -1) {
        const failedLoginCount = user.failedLoginCount + 1;
        const locked = failedLoginCount >= MAX_FAILED_ATTEMPTS;
        await this.users.save({
          ...user,
          failedLoginCount: locked ? 0 : failedLoginCount,
          lockedUntil: locked ? new Date(now + LOCKOUT_WINDOW_MS).toISOString() : user.lockedUntil,
        });
        throw new TokenError('invalid authentication code');
      }
      if (recoveryCodeIndex !== -1) {
        recoveryCodesAfterLogin = (user.recoveryCodesHashed ?? []).filter((_, i) => i !== recoveryCodeIndex);
      }
    }

    // Reset on success.
    const updated: User = {
      ...user,
      failedLoginCount: 0,
      lockedUntil: undefined,
      recoveryCodesHashed: recoveryCodesAfterLogin,
    };
    await this.users.save(updated);

    const token = signToken(
      { sub: user.id, companyId: user.companyId, userType: user.userType },
      this.tokenSecret,
    );
    return { token, user: updated };
  }

  /** Issues a fresh token for a user outside the login flow — used by
   * signup, where a newly created account should start authenticated
   * without a separate login round-trip. */
  issueTokenForUser(user: User): string {
    return signToken({ sub: user.id, companyId: user.companyId, userType: user.userType }, this.tokenSecret);
  }

  // ---- MFA (TOTP) self-service enrollment ----
  //
  // Two-step on purpose: starting enrollment only stores a *pending* secret
  // (totpEnabled stays false) so a user who never finishes setup — closes
  // the tab after scanning the QR code, say — hasn't silently locked
  // themselves into needing a code login() will then demand. totpEnabled
  // only flips to true once confirmTotpEnrollment proves the user can
  // actually generate a real code from what they saved.

  async enrollTotp(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('user not found');
    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret, this.secretKey);
    await this.users.save({ ...user, totpSecretEncrypted: encrypted, totpEnabled: false });
    return { secret, otpauthUri: buildTotpUri(secret, user.email) };
  }

  async confirmTotpEnrollment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('user not found');
    if (!user.totpSecretEncrypted) throw new ValidationError('call enrollTotp first');
    const secret = decryptSecret(user.totpSecretEncrypted, this.secretKey);
    if (!verifyTotpCode(secret, code)) {
      throw new ValidationError('invalid authentication code');
    }
    const recoveryCodes = generateRecoveryCodes();
    await this.users.save({
      ...user,
      totpEnabled: true,
      recoveryCodesHashed: recoveryCodes.map((c) => hashPassword(c)),
    });
    return { recoveryCodes };
  }

  async disableTotp(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('user not found');
    await this.users.save({ ...user, totpEnabled: false, totpSecretEncrypted: undefined, recoveryCodesHashed: undefined });
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('user not found');
    if (!user.totpEnabled) throw new ValidationError('MFA is not enabled for this account');
    const recoveryCodes = generateRecoveryCodes();
    await this.users.save({ ...user, recoveryCodesHashed: recoveryCodes.map((c) => hashPassword(c)) });
    return recoveryCodes;
  }

  // ---- Password reset ----
  //
  // No email/SMS provider exists anywhere in this codebase (see the plan's
  // own honest-risks section) — the raw token is handed back to the caller
  // (app.ts's route), which audit-logs it for an operator to relay
  // out-of-band, rather than ever putting it in the public HTTP response
  // (that response is observable by anyone who submits any email address,
  // so returning the token there would be a direct account-takeover path).

  /** Returns the user+rawToken only when the email matches a real account in
   * this company — but the caller must still always report generic success
   * to its own caller regardless, to avoid confirming whether the email
   * exists (same no-enumeration convention as login()'s own error). */
  async requestPasswordReset(companyId: string, email: string): Promise<{ user: User; rawToken: string } | undefined> {
    if (!this.passwordResetTokens) return undefined;
    const normalizedEmail = email.trim().toLowerCase();
    const [user] = await this.users.findAll((u) => u.companyId === companyId && u.email === normalizedEmail);
    if (!user) return undefined;
    const rawToken = generateRawToken();
    await this.passwordResetTokens.save({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString(),
      createdAt: new Date().toISOString(),
    });
    return { user, rawToken };
  }

  /** Resets the password and, as a side effect, force-logs-out every other
   * session the user holds (sessionsRevokedBefore) — a password reset is a
   * reasonable trigger to assume the old password/sessions may be
   * compromised, same security logic as most real-world "reset password"
   * flows. */
  async resetPassword(rawToken: string, newPassword: string): Promise<User> {
    if (!this.passwordResetTokens) throw new ValidationError('password reset is not available');
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const tokenHash = hashToken(rawToken);
    const now = Date.now();
    const [resetToken] = await this.passwordResetTokens.findAll(
      (t) => t.tokenHash === tokenHash && !t.usedAt && Date.parse(t.expiresAt) > now,
    );
    if (!resetToken) throw new ValidationError('reset link is invalid, expired, or already used');
    const user = await this.users.findById(resetToken.userId);
    if (!user) throw new NotFoundError('user not found');

    await this.users.save({
      ...user,
      passwordHash: hashPassword(newPassword),
      failedLoginCount: 0,
      lockedUntil: undefined,
      sessionsRevokedBefore: new Date().toISOString(),
    });
    await this.passwordResetTokens.save({ ...resetToken, usedAt: new Date().toISOString() });
    return user;
  }
}
