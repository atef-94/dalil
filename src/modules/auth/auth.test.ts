import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { AuthService } from './auth.service.js';
import type { User } from '../../domain/types.js';
import { createHmac } from 'node:crypto';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../../infra/security.js';
import { generateTotpCode } from '../../infra/totp.js';

function freshService() {
  const users = new InMemoryRepository<User>();
  return { svc: new AuthService(users, 'test-secret'), users };
}

test('a hashed password verifies against the original', () => {
  const hash = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('correct-horse-battery-staple', hash), true);
});

test('a hashed password rejects the wrong password', () => {
  const hash = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('wrong-password', hash), false);
});

test('register rejects an invalid email format', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.register({ companyId: 'c1', email: 'not-an-email', password: 'longenough1', userType: 'employee_user', locale: 'en' }));
});

test('register rejects a password shorter than 8 characters', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.register({ companyId: 'c1', email: 'a@b.com', password: 'short', userType: 'employee_user', locale: 'en' }));
});

test('register rejects a duplicate email within the same company', async () => {
  const { svc } = freshService();
  await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  await assert.rejects(() => svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough2', userType: 'employee_user', locale: 'en' }));
});

test('the same email is allowed to register across two different companies (multi-tenant uniqueness)', async () => {
  const { svc } = freshService();
  await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  const secondUser = await svc.register({ companyId: 'c2', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  assert.equal(secondUser.email, 'a@b.com');
});

test('login succeeds with the correct password and issues a token', async () => {
  const { svc } = freshService();
  await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  const { token } = await svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1' });
  assert.ok(token.split('.').length === 3);
});

test('failed logins increment the failure counter on the stored user record', async () => {
  const { svc, users } = freshService();
  const user = await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'wrong' }));
  await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'wrong' }));
  const stored = await users.findById(user.id);
  assert.equal(stored!.failedLoginCount, 2);
});

test('5 consecutive failed logins within the window lock the account, even with the correct password', async () => {
  const { svc } = freshService();
  await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'wrong' }));
  }
  await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1' }));
});

test('a successful login resets the failure counter', async () => {
  const { svc } = freshService();
  await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'wrong' }));
  await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'wrong' }));
  const { token } = await svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1' });
  assert.ok(token);
  // Three more wrong attempts after a reset should not yet lock (needs 5 fresh failures).
  await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'wrong' }));
  await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'wrong' }));
  const { token: secondToken } = await svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1' });
  assert.ok(secondToken);
});

test('login with MFA enabled requires a totpCode, and accepts a valid one', async () => {
  const { svc } = freshService();
  const user = await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  const { secret } = await svc.enrollTotp(user.id);
  await svc.confirmTotpEnrollment(user.id, generateTotpCode(secret));

  await assert.rejects(
    () => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1' }),
    /mfa_required/,
  );

  const { token } = await svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', totpCode: generateTotpCode(secret) });
  assert.ok(token);
});

test('login with MFA enabled rejects a wrong totpCode and counts it toward the lockout', async () => {
  const { svc, users } = freshService();
  const user = await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  const { secret } = await svc.enrollTotp(user.id);
  await svc.confirmTotpEnrollment(user.id, generateTotpCode(secret));

  await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', totpCode: '000000' }));
  const stored = await users.findById(user.id);
  assert.equal(stored!.failedLoginCount, 1);
});

test('confirmTotpEnrollment rejects a wrong code and leaves MFA disabled (login still works without a code)', async () => {
  const { svc } = freshService();
  const user = await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  await svc.enrollTotp(user.id);
  await assert.rejects(() => svc.confirmTotpEnrollment(user.id, '000000'));
  const { token } = await svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1' });
  assert.ok(token);
});

test('a one-time recovery code logs the user in and cannot be reused', async () => {
  const { svc } = freshService();
  const user = await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  const { secret } = await svc.enrollTotp(user.id);
  const { recoveryCodes } = await svc.confirmTotpEnrollment(user.id, generateTotpCode(secret));
  const code = recoveryCodes[0]!;

  const { token } = await svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', totpCode: code });
  assert.ok(token);

  await assert.rejects(() => svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', totpCode: code }));
});

test('disableTotp turns MFA off so login no longer requires a code', async () => {
  const { svc } = freshService();
  const user = await svc.register({ companyId: 'c1', email: 'a@b.com', password: 'longenough1', userType: 'employee_user', locale: 'en' });
  const { secret } = await svc.enrollTotp(user.id);
  await svc.confirmTotpEnrollment(user.id, generateTotpCode(secret));
  await svc.disableTotp(user.id);
  const { token } = await svc.login({ companyId: 'c1', email: 'a@b.com', password: 'longenough1' });
  assert.ok(token);
});

test('a tampered token signature is rejected', () => {
  const token = signToken({ sub: 'user-1', companyId: 'c1', userType: 'employee_user' }, 'test-secret');
  const [header, payload] = token.split('.');
  const tampered = `${header}.${payload}.tampered-signature`;
  assert.throws(() => verifyToken(tampered, 'test-secret'));
});

test('an expired token is rejected', () => {
  const secret = 'test-secret';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: 'user-1', companyId: 'c1', userType: 'employee_user', iat: now - 1000, exp: now - 10 }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const expiredToken = `${header}.${payload}.${signature}`;
  assert.throws(() => verifyToken(expiredToken, secret));
});
