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
function deviceName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Problem(400, 'Enter a device name of up to 80 characters');
  return name;
}
const DEVICE_LINK_LIFETIME = 5 * 60000;
const DEVICE_LINK_LIMIT = 10;

export class Auth {
  constructor(store, { origin, bootstrapToken, development = false, legacyRPID }) {
    this.store = store;
    this.origin = origin;
    this.rpID = new URL(origin).hostname;
    this.legacyRPID = legacyRPID ?? this.rpID;
    this.bootstrapToken = bootstrapToken;
    this.development = development;
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
    // Public per-client throttling runs at NGINX, before client addresses are lost.
    // This separate ceiling bounds total authentication work per origin.
    const key = 'global',
      now = Date.now();
    for (const [k, times] of this.rates)
      if (!times.some((t) => now - t < 60000)) this.rates.delete(k);
    if (this.rates.size > 1000) throw new Problem(429, 'Try again in a minute');
    const list = (this.rates.get(key) ?? []).filter((t) => now - t < 60000);
    if (list.length >= 1000) throw new Problem(429, 'Too many sign-in attempts. Wait a minute.');
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
  registrationOptions() {
    return generateRegistrationOptions({
      rpName: 'Proxy',
      rpID: this.rpID,
      userID: Buffer.from('proxy-owner'),
      userName: 'owner',
      attestationType: 'none',
      supportedAlgorithmIDs: [-7, -257, -8],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: this.localCredentials().map((c) => ({ id: c.id, transports: c.transports })),
    });
  }
  deviceLinks() {
    const now = Date.now();
    return this.store.get('deviceTokens', []).filter((link) => link.expires > now);
  }
  deviceLink(token) {
    const key = hash(typeof token === 'string' ? token : '');
    const link = this.deviceLinks().find(
      (candidate) => candidate.token === key && candidate.origin === this.origin,
    );
    if (!link) throw new Problem(403, 'This device link is invalid or has expired');
    return link;
  }
  challenge(req, res, value) {
    const now = Date.now();
    const id = randomToken();
    this.store.transaction(() => {
      const pending = this.store.get('authChallenges', []).filter((p) => p.expires >= now);
      if (pending.filter((p) => p.origin === this.origin).length >= 100)
        throw new Problem(429, 'Too many pending sign-ins');
      pending.push({ ...value, key: hash(id), origin: this.origin,
        epoch: this.store.get('authEpoch', 0), expires: now + 300000 });
      this.store.set('authChallenges', pending);
    });
    this.cookie(res, 'proxy_challenge', id, 300);
  }
  consume(req, res, type) {
    const key = hash(
        cookies(req)[this.development ? 'proxy_challenge' : '__Host-proxy_challenge'] ?? '',
      );
    const pending = this.store.transaction(() => {
      const challenges = this.store.get('authChallenges', []);
      const value = challenges.find((p) => p.key === key && p.origin === this.origin);
      this.store.set('authChallenges', challenges.filter((p) => p !== value));
      return value;
    });
    this.cookie(res, 'proxy_challenge', '', 0);
    if (!pending || pending.type !== type || pending.expires < Date.now())
      throw new Problem(400, 'Sign-in expired. Start again.');
    this.checkEpoch(pending);
    return pending;
  }
  checkEpoch(pending) {
    if (pending.epoch !== this.store.get('authEpoch', 0))
      throw new Problem(403, 'Authorization changed. Start again.');
  }
  revokeAuthorizations() {
    this.store.set('sessions', []);
    this.store.set('deviceTokens', []);
    this.store.set('authEpoch', this.store.get('authEpoch', 0) + 1);
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
      const options = await this.registrationOptions();
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
      this.checkEpoch(pending);
      if (!pending.initial && this.require(req, true).token !== pending.session)
        throw new Problem(403, 'Enrollment state changed. Start again.');
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
      return this.issue(req, res);
    }
    if (path === '/api/auth/devices/link') {
      this.require(req, true);
      const token = randomToken(),
        expires = Date.now() + DEVICE_LINK_LIFETIME;
      this.store.set('deviceTokens', [
        ...this.deviceLinks().slice(-(DEVICE_LINK_LIMIT - 1)),
        { token: hash(token), origin: this.origin, expires },
      ]);
      return { url: `${this.origin}/device#${token}`, expires: new Date(expires).toISOString() };
    }
    if (path === '/api/auth/devices/options') {
      this.deviceLink(body.token);
      const name = deviceName(body.name),
        options = await this.registrationOptions();
      this.challenge(req, res, {
        type: 'device',
        challenge: options.challenge,
        token: hash(body.token),
        name,
      });
      return options;
    }
    if (path === '/api/auth/devices/verify') {
      const pending = this.consume(req, res, 'device');
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
        throw new Problem(400, 'Device registration could not be verified');
      }
      if (!result.verified || !result.registrationInfo)
        throw new Problem(400, 'Device registration failed');
      this.checkEpoch(pending);
      const c = result.registrationInfo.credential;
      this.store.transaction(() => {
        const links = this.store.get('deviceTokens', []);
        if (
          !links.some(
            (link) =>
              link.token === pending.token &&
              link.origin === this.origin &&
              link.expires > Date.now(),
          )
        )
          throw new Problem(403, 'This device link is invalid or has expired');
        const latest = this.credentials();
        if (latest.length >= 10 || latest.some((p) => p.id === c.id))
          throw new Problem(400, 'Device already registered or limit reached');
        this.store.set(
          'deviceTokens',
          links.filter((link) => link.token !== pending.token),
        );
        this.store.set('credentials', [
          ...latest,
          {
            id: c.id,
            rpID: this.rpID,
            publicKey: Buffer.from(c.publicKey).toString('base64url'),
            counter: c.counter,
            transports: c.transports,
            ...(pending.name ? { name: pending.name } : {}),
            created: new Date().toISOString(),
          },
        ]);
      });
      return this.issue(req, res);
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
      this.checkEpoch(pending);
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
        !this.credentials().length ||
        typeof this.bootstrapToken !== 'string' || this.bootstrapToken.length < 32 ||
        !equalSecret(body.code, this.bootstrapToken)
      )
        throw new Problem(403, 'Invalid recovery code');
      this.store.transaction(() => {
        this.store.set('recovery', null);
        this.revokeAuthorizations();
      });
      return this.issue(req, res);
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
      return this.credentials().map((c) => ({ id: c.id, name: c.name ?? '', created: c.created, hostname: c.rpID ?? this.legacyRPID }));
    }
    if (path === '/api/auth/passkeys/rename') {
      this.require(req, true);
      const name = deviceName(body.name);
      if (!name) throw new Problem(400, 'Enter a device name of 1–80 characters');
      const credentials = this.credentials();
      const credential = credentials.find((c) => c.id === body.id);
      if (!credential) throw new Problem(404, 'Device not found');
      credential.name = name;
      this.store.set('credentials', credentials);
      return { ok: true };
    }
    if (path === '/api/auth/passkeys/remove') {
      this.require(req, true);
      const credentials = this.credentials();
      if (credentials.length < 2)
        throw new Problem(400, 'Add another device before removing the last one');
      if (!credentials.some((c) => c.id === body.id)) throw new Problem(404, 'Device not found');
      this.store.transaction(() => {
        this.store.set('credentials', credentials.filter((c) => c.id !== body.id));
        this.revokeAuthorizations();
      });
      this.cookie(res, 'proxy_session', '', 0);
      return { ok: true };
    }
    throw new Problem(404, 'Not found');
  }
}
