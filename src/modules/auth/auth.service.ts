import { randomUUID } from 'node:crypto';
import type { User, UserType } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { hashPassword, verifyPassword, signToken } from '../../infra/security.js';
import { ValidationError, TokenError } from '../../infra/errors.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
}

export class AuthService {
  constructor(
    private readonly users: Repository<User>,
    private readonly tokenSecret: string,
  ) {}

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
    };
    return this.users.save(user);
  }

  async login(input: LoginInput): Promise<{ token: string; user: User }> {
    const email = input.email.trim().toLowerCase();
    const [user] = await this.users.findAll((u) => u.companyId === input.companyId && u.email === email);

    // Constant-shaped failure: don't reveal whether the account exists.
    if (!user) {
      throw new TokenError('invalid email or password');
    }

    const now = Date.now();
    if (user.lockedUntil && Date.parse(user.lockedUntil) > now) {
      throw new TokenError('account locked due to too many failed login attempts, try again later');
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

    // Reset on success.
    const updated: User = { ...user, failedLoginCount: 0, lockedUntil: undefined };
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
}
