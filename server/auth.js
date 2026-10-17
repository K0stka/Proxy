import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { Problem } from '../shared/model.js';

export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = (v) => createHash('sha256').update(v).digest('hex');
export function equalSecret(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)))
  );
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((p) => p.trim().split('=')));
}

export class Auth {
  constructor(store, { origin, bootstrapToken, development = false, legacyRPID }) {
    this.store = store;
    this.origin = origin;
    this.rpID = new URL(origin).hostname;
    this.legacyRPID = legacyRPID ?? this.rpID;
    this.bootstrapToken = bootstrapToken;
    this.development = development;
    this.pending = new Map();
    this.rates = new Map();
  }
  cookie(res, name, value, age) {
    if (!this.development) name = `__Host-${name}`;
    const existing = res.getHeader('Set-Cookie') ?? [];
    res.setHeader('Set-Cookie', [
      ...existing,
      `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.development ? '' : '; Secure'}`,
    ]);
  }
  credentials() {
    return this.store.get('credentials', []);
  }
  localCredentials() {
    return this.credentials().filter((c) => (c.rpID ?? this.legacyRPID) === this.rpID);
  }
  session(req) {
    const token = cookies(req)[this.development ? 'proxy_session' : '__Host-proxy_session'];
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    const sessions = this.store.get('sessions', []);
    return sessions.find((s) => s.token === hash(token) && s.expires > Date.now() &&
      (s.origin === this.origin || (!s.origin && this.rpID === this.legacyRPID))) ?? null;
  }
  require(req, mutation = false) {
    const s = this.session(req);
    if (!s) throw new Problem(401, 'Sign in to manage your proxy');
    if (mutation && !equalSecret(req.headers['x-csrf-token'], s.csrf))
      throw new Problem(403, 'Invalid request token. Refresh and try again.');
    return s;
  }
  rate(req) {
    const key = req.socket.remoteAddress ?? 'local',
      now = Date.now();
    for (const [k, times] of this.rates)
      if (!times.some((t) => now - t < 60000)) this.rates.delete(k);
    if (this.rates.size > 1000) throw new Problem(429, 'Try again in a minute');
    const list = (this.rates.get(key) ?? []).filter((t) => now - t < 60000);
    if (list.length >= 20) throw new Problem(429, 'Too many sign-in attempts. Wait a minute.');
    list.push(now);
    this.rates.set(key, list);
  }
  issue(req, res) {
    const token = randomToken(),
      csrf = randomToken(),
      now = Date.now();
    const sessions = this.store
      .get('sessions', [])
      .filter((s) => s.expires > now)
      .slice(-9);
    sessions.push({ token: hash(token), csrf, expires: now + 12 * 3600000, origin: this.origin });
    this.store.set('sessions', sessions);
    this.cookie(res, 'proxy_session', token, 12 * 3600);
    return { authenticated: true, csrf };
  }
  challenge(req, res, value) {
    const now = Date.now();
    for (const [key, p] of this.pending) if (p.expires < now) this.pending.delete(key);
    if (this.pending.size > 100) throw new Problem(429, 'Too many pending sign-ins');
    const id = randomToken();
    this.pending.set(hash(id), { ...value, expires: now + 300000 });
    this.cookie(res, 'proxy_challenge', id, 300);
  }
  consume(req, res, type) {
    const key = hash(
        cookies(req)[this.development ? 'proxy_challenge' : '__Host-proxy_challenge'] ?? '',
      ),
      pending = this.pending.get(key);
    this.pending.delete(key);
    this.cookie(res, 'proxy_challenge', '', 0);
    if (!pending || pending.type !== type || pending.expires < Date.now())
      throw new Problem(400, 'Sign-in expired. Start again.');
    return pending;
  }
  async handle(path, req, res, body) {
    if (path === '/api/auth/status' && req.method === 'GET') {
      const s = this.session(req);
      return { enrolled: this.credentials().length > 0, originEnrolled: this.localCredentials().length > 0, authenticated: Boolean(s), csrf: s?.csrf };
    }
    if (req.method !== 'POST') throw new Problem(404, 'Not found');
    this.rate(req);
    if (path === '/api/auth/register/options') {
      const current = this.credentials(),
        session = this.session(req);
      if (current.length) this.require(req, true);
      else {
        const token = this.bootstrapToken;
        if (typeof token !== 'string' || token.length < 32) {
          throw new Problem(503, 'Enrollment token is not configured');
        }
        if (!equalSecret(body.token, token)) throw new Problem(403, 'Invalid enrollment token');
      }
      const options = await generateRegistrationOptions({
        rpName: 'Proxy',
        rpID: this.rpID,
        userID: Buffer.from('proxy-owner'),
        userName: 'owner',
        attestationType: 'none',
        supportedAlgorithmIDs: [-7, -257, -8],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: this.localCredentials().map((c) => ({ id: c.id, transports: c.transports })),
      });
      this.challenge(req, res, {
        type: 'register',
        challenge: options.challenge,
        initial: current.length === 0,
        session: session?.token ?? null,
      });
      return options;
    }
    if (path === '/api/auth/register/verify') {
      const pending = this.consume(req, res, 'register'),
        current = this.credentials();
      if (
        pending.initial ? current.length !== 0 : this.require(req, true).token !== pending.session
      )
        throw new Problem(403, 'Enrollment state changed. Start again.');
      let result;
      try {
        result = await verifyRegistrationResponse({
          response: body,
          expectedChallenge: pending.challenge,
          expectedOrigin: this.origin,
          expectedRPID: this.rpID,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7, -257, -8],
        });
      } catch {
        throw new Problem(400, 'Passkey registration could not be verified');
      }
      if (!result.verified || !result.registrationInfo)
        throw new Problem(400, 'Passkey registration failed');
      const c = result.registrationInfo.credential;
      const latest = this.credentials();
      if (pending.initial && latest.length)
        throw new Problem(
          409,
          'An administrator was already enrolled. Sign in to add another passkey.',
        );
      if (latest.length >= 10 || latest.some((p) => p.id === c.id))
        throw new Problem(400, 'Passkey already registered or limit reached');
      this.store.set('credentials', [
        ...latest,
        {
          id: c.id,
          rpID: this.rpID,
          publicKey: Buffer.from(c.publicKey).toString('base64url'),
          counter: c.counter,
          transports: c.transports,
          created: new Date().toISOString(),
        },
      ]);
      let recoveryCode;
      if (pending.initial) {
        recoveryCode = randomToken();
        this.store.set('recovery', hash(recoveryCode));
      }
      return { ...this.issue(req, res), recoveryCode };
    }
    if (path === '/api/auth/login/options') {
      const credentials = this.localCredentials();
      if (!credentials.length) throw new Problem(400, 'Enroll your first passkey');
      const options = await generateAuthenticationOptions({
        rpID: this.rpID,
        userVerification: 'required',
        allowCredentials: credentials.map((c) => ({ id: c.id, transports: c.transports })),
      });
      this.challenge(req, res, { type: 'login', challenge: options.challenge });
      return options;
    }
    if (path === '/api/auth/login/verify') {
      const pending = this.consume(req, res, 'login'),
        credentials = this.localCredentials(),
        credential = credentials.find((c) => c.id === body.id);
      if (!credential) throw new Problem(400, 'Passkey not recognized');
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response: body,
          expectedChallenge: pending.challenge,
          expectedOrigin: this.origin,
          expectedRPID: this.rpID,
          requireUserVerification: true,
          credential: { ...credential, publicKey: Buffer.from(credential.publicKey, 'base64url') },
        });
      } catch {
        throw new Problem(400, 'Passkey sign-in could not be verified');
      }
      if (!result.verified) throw new Problem(400, 'Passkey sign-in failed');
      const latest = this.credentials(),
        active = latest.find((c) => c.id === credential.id);
      if (!active || active.counter !== credential.counter)
        throw new Problem(409, 'Passkey state changed. Please sign in again.');
      active.counter = result.authenticationInfo.newCounter;
      this.store.set('credentials', latest);
      return this.issue(req, res);
    }
    if (path === '/api/auth/recover') {
      if (
        !this.store.get('recovery') ||
        !equalSecret(
          hash(typeof body.code === 'string' ? body.code : ''),
          this.store.get('recovery'),
        )
      )
        throw new Problem(403, 'Invalid recovery code');
      const recoveryCode = randomToken();
      this.store.transaction(() => {
        this.store.set('recovery', hash(recoveryCode));
        this.store.set('sessions', []);
      });
      return { ...this.issue(req, res), recoveryCode };
    }
    if (path === '/api/auth/logout') {
      const s = this.require(req, true);
      this.store.set(
        'sessions',
        this.store.get('sessions', []).filter((p) => p.token !== s.token),
      );
      this.cookie(res, 'proxy_session', '', 0);
      return { ok: true };
    }
    if (path === '/api/auth/passkeys') {
      this.require(req, true);
      return this.credentials().map((c) => ({ id: c.id, created: c.created, hostname: c.rpID ?? this.legacyRPID }));
    }
    if (path === '/api/auth/passkeys/remove') {
      this.require(req, true);
      const credentials = this.credentials();
      if (credentials.length < 2)
        throw new Problem(400, 'Add another passkey before removing the last one');
      if (!credentials.some((c) => c.id === body.id)) throw new Problem(404, 'Passkey not found');
      this.store.set(
        'credentials',
        credentials.filter((c) => c.id !== body.id),
      );
      this.store.set('sessions', []);
      this.cookie(res, 'proxy_session', '', 0);
      return { ok: true };
    }
    throw new Problem(404, 'Not found');
  }
}
