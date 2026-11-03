import { betterAuth } from 'better-auth';
import { phoneNumber, twoFactor } from 'better-auth/plugins';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { Kysely } from 'kysely';
import type { IdentityStore } from './store.ts';

export interface Delivery {
  email(message: { to: string; subject: string; text: string }): Promise<void>;
  sms(message: { to: string; text: string }): Promise<void>;
}
export interface IdentityConfig { origin: string; secret: string; production: boolean; edgeSecret?: string }

export function createIdentity(db: Kysely<unknown>, store: IdentityStore, delivery: Delivery, config: IdentityConfig) {
  return betterAuth({
    appName: 'Kavosh One', baseURL: config.origin, basePath: '/api/auth', secret: config.secret,
    trustedOrigins: [config.origin],
    database: { db, type: 'postgres', transaction: true },
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true, requireEmailVerification: true, autoSignIn: false,
      minPasswordLength: 15, maxPasswordLength: 128, resetPasswordTokenExpiresIn: 900,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, token }) {
        await delivery.email({ to: user.email, subject: 'Reset your Kavosh One password', text: `Use this private link within 15 minutes:\n${config.origin}/account/recover#token=${encodeURIComponent(token)}\nIf you did not request this, ignore it.` });
      },
      async onPasswordReset({ user }) { await store.revokeRecoverySessions(user.id); }
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false, expiresIn: 900,
      async sendVerificationEmail({ user, url }) {
        await delivery.email({ to: user.email, subject: 'Verify your Kavosh One email', text: `Verify the account you requested using this private link within 15 minutes:\n${url}\nVerification alone does not sign you in.` });
      }
    },
    user: { additionalFields: { mfaRequired: { type: 'boolean', defaultValue: false, input: false } } },
    session: { expiresIn: 86400, updateAge: 900, freshAge: 900, cookieCache: { enabled: false },
      additionalFields: { mfaVerified: { type: 'boolean', defaultValue: false, input: false, returned: false } } },
    account: { accountLinking: { enabled: false } },
    databaseHooks:{verification:{create:{before:async value=>{
      // The phone plugin consumes OTPs atomically but stores them verbatim by
      // default. Keyed digests preserve its attempt/replay logic without plaintext.
      if(/^\+[1-9]\d{7,14}$/.test(value.identifier)&&/^\d{6}(?::\d+)?$/.test(value.value)) {
        const [code,attempts='0']=value.value.split(':');
        return {data:{...value,value:store.digest(`phone-otp:${value.identifier}:${code}`)+':'+attempts}};
      }
      return {data:value};
    }}}},
    advanced: {
      database: { generateId: 'uuid' }, useSecureCookies: new URL(config.origin).protocol === 'https:',
      cookiePrefix: 'kavosh', defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['x-kavosh-client-ip'] }
    },
    // Shared hub Wi-Fi must not lock out every family after three sign-ins.
    // Gateway per-account budgets and plugin per-challenge attempts still apply.
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 600,
      customRules:{'/sign-in/*':{window:60,max:200},'/sign-up/*':{window:60,max:100},
        '/two-factor/*':{window:60,max:400},'/phone-number/*':{window:60,max:400},
        '/request-password-reset':{window:60,max:100},'/send-verification-email':{window:60,max:100}} },
    hooks: { before:createAuthMiddleware(async ctx=>{
      if(ctx.path==='/phone-number/verify'&&ctx.body?.code)
        return {context:{body:{...ctx.body,code:store.digest(`phone-otp:${ctx.body.phoneNumber}:${ctx.body.code}`)}}};
    }),after: createAuthMiddleware(async ctx => {
      const current=ctx.context.newSession;
      if (current && current.user.twoFactorEnabled && ['/sign-in/email','/two-factor/verify-otp','/two-factor/verify-totp','/two-factor/verify-backup-code'].includes(ctx.path)) {
        await store.markMfaSession(current.session.id,current.user.id);
      }
      if (current && ['/two-factor/enable','/two-factor/disable'].includes(ctx.path)) await store.revokeRecoverySessions(current.user.id,'mfa.changed');
    }) },
    plugins: [
      phoneNumber({
        otpLength: 6, expiresIn: 300, allowedAttempts: 3,
        phoneNumberValidator: value => /^\+[1-9]\d{7,14}$/.test(value),
        async sendOTP({ phoneNumber: to, code }) {
          await delivery.sms({ to, text: `Kavosh One verification code: ${code}. Expires in 5 minutes. Never share it.` });
        }
      }),
      twoFactor({
        issuer: 'Kavosh One', trustDeviceMaxAge: 30 * 86400, twoFactorCookieMaxAge: 300,
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
        backupCodeOptions: { amount: 10, length: 16, storeBackupCodes: 'encrypted' },
        otpOptions: { digits: 6, period: 5, storeOTP: 'hashed', async sendOTP({ user, otp }) {
          if (!await store.budget(`mfa-sms:${user.id}`,10,600)) throw new APIError('TOO_MANY_REQUESTS',{message:'Try again later.'});
          const verified = await store.verifiedPhone(user.id);
          if (!verified) throw new APIError('FORBIDDEN', { code: 'PHONE_VERIFICATION_REQUIRED', message: 'Verify your phone first.' });
          await delivery.sms({ to: verified, text: `Kavosh One sign-in code: ${otp}. Expires in 5 minutes. Never share it.` });
        } }
      })
    ]
  });
}
export type Identity = ReturnType<typeof createIdentity>;
