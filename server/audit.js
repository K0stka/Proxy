// Log operation names and outcomes only; never serialize requests or credentials.
const authEvents = new Map([
  ['register/options', 'auth.registration.started'],
  ['register/verify', 'auth.registration.completed'],
  ['login/options', 'auth.login.started'],
  ['login/verify', 'auth.login.completed'],
  ['recover', 'auth.recovery'],
  ['logout', 'auth.logout'],
  ['devices/link', 'auth.device.link'],
  ['devices/options', 'auth.device.started'],
  ['devices/verify', 'auth.device.completed'],
  ['passkeys/rename', 'auth.passkey.renamed'],
  ['passkeys/remove', 'auth.passkey.removed'],
]);

export function auditEvent(path, method) {
  if (method === 'GET') return null;
  if (path.startsWith('/api/auth/')) return authEvents.get(path.slice(10)) ?? null;
  if (/^\/api\/routes(?:\/[0-9a-f-]{36}(?:\/(publish|disable|sync))?)?$/.test(path))
    return 'admin.routes.changed';
  if (/^\/api\/(settings|preferences|pages(?:\/(404|500|502))?|domains(?:\/[^/]+)?|sites\/(config|pull)|reconcile|certificates\/retry)$/.test(path))
    return 'admin.configuration.changed';
  return null;
}
