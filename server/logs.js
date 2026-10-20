import { logQuery } from '../shared/log-store.js';
import { Problem } from '../shared/model.js';
import { defaultLogFilters } from '../shared/log-filters.js';

export function filteredLogQuery(params, filters = defaultLogFilters) {
  return { ...logQuery(params), hideUptimeKuma: filters.hideUptimeKuma,
    hideCS2Renderer: filters.hideCS2Renderer ?? defaultLogFilters.hideCS2Renderer,
    hideManagement: filters.hideManagement };
}

export function logCursor(value) {
  if (!value) return {};
  try {
    if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.entries(parsed).some(([k, v]) => !['edge', 'control'].includes(k) || !v ||
          !Number.isSafeInteger(v.id) || v.id < 0 || !Number.isFinite(Date.parse(v.time)))) throw Error();
    return parsed;
  } catch { throw new Problem(400, 'Invalid log cursor'); }
}
export function logParameters(query, before = query.before) {
  const paging = before && typeof before === 'object' ? { before: before.id, beforeTime: before.time } : { before };
  return new URLSearchParams(Object.entries({ ...query, columns: JSON.stringify(query.columns ?? {}), ...paging }).filter(([, value]) => value !== null && value !== undefined));
}
export async function logPage(archive, edge, query, cursor = {}, { strict = false } = {}) {
  const control = archive.history({ ...query, before: cursor.control?.id ?? null, beforeTime: cursor.control?.time ?? null });
  let traffic, edgeAvailable = true;
  try {
    traffic = await edge(`/logs?${logParameters(query, cursor.edge)}`, { timeout: 5000 });
    if (!Array.isArray(traffic.events)) throw new Problem(502, 'Edge logs unavailable');
  }
  catch (e) { if (strict) throw e; edgeAvailable = false; traffic = { events: [], next: null }; }
  const ordered = [...control.events.map((e) => ({ ...e, component: 'control' })),
    ...traffic.events.map((e) => ({ ...e, component: 'edge' }))]
    .sort((a, b) => b.time.localeCompare(a.time) || b.id - a.id || a.component.localeCompare(b.component));
  const events = ordered.slice(0, 100), next = { ...cursor };
  for (const event of events) next[event.component] = { id: event.id, time: event.time };
  return { events, edgeAvailable,
    next: ordered.length > 100 || control.next != null || traffic.next != null ? Buffer.from(JSON.stringify(next)).toString('base64url') : null };
}
export async function logView(archive, edge, params, filters) {
  const query = filteredLogQuery(params, filters), cursor = logCursor(params.get('cursor'));
  const page = await logPage(archive, edge, query, cursor);
  let traffic = null;
  try { traffic = await edge(`/log-summary?${logParameters(query)}`, { timeout: 5000 }); } catch {}
  const control = archive.summary(query), summary = traffic ?? { ...control,
    buckets: control.buckets.map((b) => ({ ...b, count: 0, alerts: 0, requests: 0, success: 0, clientErrors: 0, serverErrors: 0 })),
    totals: { count: 0, alerts: 0, requests: 0, success: 0, clientErrors: 0, serverErrors: 0 } };
  const totals = { ...summary.totals };
  for (const key of Object.keys(totals)) totals[key] += control.totals[key] ?? 0;
  const options = Object.fromEntries(['event', 'suspicious', 'method', 'severity', 'role'].map((field) =>
    [field, [...new Set([...(control.options?.[field] ?? []), ...(traffic?.options?.[field] ?? [])])].sort()]));
  return { ...page, edgeAvailable: page.edgeAvailable && traffic !== null, summary: { ...summary, totals, options },
    period: { from: control.from, to: control.to } };
}
