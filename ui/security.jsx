import React, { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Group, Paper, Select, Skeleton, Stack, Switch, Table, TextInput, Textarea } from '@mantine/core';
import { ShieldCheck, ShieldOff, ShieldAlert, Activity, RefreshCw, Plus, Trash2, ArrowUpRight, Search } from 'lucide-react';
import { Button } from './controls.jsx';
import Modal from './dialog.jsx';
import Help from './help.jsx';
import { useToast } from './toasts.jsx';
import { formatDateTime } from './date-time.js';
import { logPeriod, logPeriods } from './log-period.js';
import Monitoring from './monitoring.jsx';
import { api } from './api.js';
import { subscribeUpdates } from './events.js';

const initialPolicy = { mode: 'block', waf: true, behavior: true, reputation: true, updates: true, duration: '4h', failure: 'allow', routes: {}, appsecExceptions: { umamiDelete: true, socketIo: true } };
function readPreview() {
  try { return JSON.parse(sessionStorage.getItem('proxy-security-preview') ?? '{}'); } catch { return {}; }
}
const modes = [{ value: 'block', label: 'Monitor & block' }, { value: 'monitor', label: 'Monitor only' }, { value: 'off', label: 'Off' }];
const crowdsecAppsecGuide = 'https://docs.crowdsec.net/docs/appsec/crs/intro/';
const anomalyGuide = 'https://coreruleset.org/docs/concepts/anomaly_scoring/';
function explainDecision(decision) {
  const rule = String(decision.rule ?? '');
  const score = [rule, String(decision.reason ?? '')].map((value) => value.match(/^anomaly score block:\s*(?:(rce|sqli|xss|lfi):\s*(\d+),\s*)?anomaly:\s*(\d+)/i)).find(Boolean);
  if (score) {
    const category = score[1]?.toLowerCase();
    const names = { rce: 'remote code execution (RCE)', sqli: 'SQL injection', xss: 'cross-site scripting (XSS)', lfi: 'local file inclusion' };
    return {
      threat: `OWASP CRS detected patterns associated with ${names[category] ?? 'a web attack'}.`,
      rule: `${category ? `${category.toUpperCase()} score: ${score[2]} · ` : ''}Total anomaly score: ${score[3]}.`,
      detail: 'CRS adds points when request rules match and blocks when the total reaches its threshold. A score indicates suspicious patterns; it does not prove that code ran.',
      link: crowdsecAppsecGuide, linkLabel: 'CrowdSec guide to AppSec and CRS',
      secondaryLink: anomalyGuide, secondaryLinkLabel: 'How OWASP CRS anomaly scoring works',
    };
  }
  if (decision.engine === 'WAF' && rule && !/^(crowdsec(?: application security rule| match)|crowdsecurity\/appsec-native)$/i.test(rule)) return {
    threat: decision.reason, rule,
    detail: 'The request was stopped at the edge before reaching the service.',
    link: crowdsecAppsecGuide, linkLabel: 'About CrowdSec AppSec and OWASP CRS',
  };
  if (decision.engine === 'WAF') return {
    threat: 'CrowdSec’s web application firewall matched this request to an attack pattern.',
    rule: 'The AppSec verdict does not include the individual matched rule name, so it is not available in this record.',
    detail: 'The request was stopped at the edge before reaching the service.',
    link: crowdsecAppsecGuide, linkLabel: 'About CrowdSec AppSec and OWASP CRS',
  };
  const scenario = rule.match(/^([a-z0-9_-]+)\/([a-z0-9_-]+)$/i);
  if (scenario) {
    const name = scenario[2].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      threat: `${name} detection`, rule,
      link: `https://app.crowdsec.net/hub/author/${encodeURIComponent(scenario[1])}/scenarios/${encodeURIComponent(scenario[2])}`,
      linkLabel: 'View this detection on CrowdSec Hub',
    };
  }
  return { threat: decision.reason, rule: rule || decision.reason, link: crowdsecAppsecGuide, linkLabel: 'Browse CrowdSec rules and documentation' };
}
const reasons = [
  ['Application firewall match', 'CrowdSec application security rule', '/.env', 'WAF', 'home.example.net'],
  ['HTTP scanning', 'Repeated requests to missing resources', '/wp-admin', 'Behavior', 'Unmatched hosts'],
  ['Remote code execution', 'anomaly score block: rce: 10, anomaly: 10,', '/?exec=whoami', 'WAF', 'home.example.net'],
  ['Known malicious IP', 'Community reputation decision', '/login', 'Reputation', 'media.example.net'],
  ['Path traversal', 'OWASP CRS · directory traversal', '/assets/../../etc/passwd', 'WAF', 'home.example.net'],
  ['HTTP probing', 'Repeated sensitive path requests', '/.git/config', 'Behavior', 'Unmatched hosts'],
];
const seedDecisions = reasons.map(([reason, rule, path, engine, host], i) => ({ id: i + 1, reason, rule, path, engine, host,
  ip: `198.51.100.${24 + i * 17}`, requests: [482, 317, 186, 123, 72, 0][i], age: [2, 8, 14, 26, 41, 56][i],
  action: i === 5 ? 'Detected' : 'Blocked', banned: i === 3 }));

function Metric({ label, value, detail, icon: Icon }) {
  return <Paper withBorder className="logs-metric"><div className="logs-metric-label">{label}<Icon size={17} /></div><strong>{value}</strong><span>{detail}</span></Paper>;
}

export default function Security({ state, onLogout }) {
  const preview = !!document.querySelector('meta[name="proxy-preview"]');
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const initialized = useRef(false);
  const report = useToast();
  const [tab, setTab] = useState('overview'), [period, setPeriod] = useState('today'), [filterTarget, setFilterTarget] = useState(null), [query, setQuery] = useState(''),
    [saved, setSaved] = useState(() => readPreview().saved ?? initialPolicy), [policy, setPolicy] = useState(() => readPreview().saved ?? initialPolicy),
    [decisions, setDecisions] = useState(() => readPreview().decisions ?? seedDecisions), [exceptions, setExceptions] = useState(() => readPreview().exceptions ?? [{ id: 1, ip: '192.0.2.18', note: 'Office connection', scope: 'All HTTP services' }]),
    [dialog, setDialog] = useState(null), [address, setAddress] = useState(''), [note, setNote] = useState(''), [formError, setFormError] = useState(''),
    [updated, setUpdated] = useState(Date.now() - 19 * 60000);
  useEffect(() => {
    if (!preview) return;
    try { sessionStorage.setItem('proxy-security-preview', JSON.stringify({ saved, decisions, exceptions })); } catch { /* Preview still works when browser storage is unavailable. */ }
  }, [saved, decisions, exceptions]);
  async function load(accept = () => true) {
    const next = await api(`/security?${new URLSearchParams(logPeriod(period))}`);
    if (!accept()) return;
    setData(next); setError(''); setDecisions(next.decisions);
    setSaved(next.policy); setExceptions(next.policy.exceptions.map((e) => ({ ...e, id: e.ip, scope: 'All HTTP services' })));
    if (!initialized.current) { setPolicy(next.policy); initialized.current = true; }
  }
  useEffect(() => {
    if (preview) return;
    let active = true, inFlight = false;
    const refresh = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try { await load(() => active); }
      catch (e) { if (active) { setError(e.message); if (e.status === 401) onLogout(); } }
      finally { inFlight = false; }
    };
    refresh();
    const unsubscribeSecurity = subscribeUpdates(refresh, 'security'), unsubscribeAlerts = subscribeUpdates(refresh, 'alerts');
    return () => { active = false; unsubscribeSecurity(); unsubscribeAlerts(); };
  }, [period]);
  async function persist(value) {
    if (preview) { setSaved(structuredClone(value)); return; }
    await api('/security/policy', { method: 'PUT', body: value });
    setPolicy(value); setSaved(value); await load();
  }
  async function perform(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { report(e.message, true); } finally { setBusy(false); }
  }
  async function release(decision) {
    if (preview) setDecisions((items) => items.map((d) => d.id === decision.id ? { ...d, action: 'Ban removed', banned: false } : d));
    else { await api('/security/release', { method: 'POST', body: { ip: decision.ip } }); await load(); }
    setDialog(null); report('IP ban removed');
  }
  async function removeException(item) {
    if (preview) setExceptions((items) => items.filter((e) => e.id !== item.id));
    else await persist({ ...saved, exceptions: saved.exceptions.filter((e) => e.ip !== item.ip) });
    setDialog(null); report('Allowed address removed');
  }
  function expiry(d) { return preview ? d.banned ? 'In 3 hours' : '—' : d.expires || '—'; }
  const dirty = JSON.stringify(saved) !== JSON.stringify(policy);
  const active = decisions.filter((d) => d.banned);
  const visible = decisions.filter((d) => `${d.ip} ${d.reason} ${d.host}`.toLowerCase().includes(query.toLowerCase()));
  const bounds = logPeriod(period);
  const factor = (Date.parse(bounds.to) - Date.parse(bounds.from)) / 86400000 * 8;
  const blockedBySource = preview ? [780, 305, 133].map((count) => Math.round(count * factor)) : ['WAF', 'Behavior', 'Reputation', 'Availability'].map((key) => data?.counts.sources[key] ?? 0);
  const blocked = preview ? blockedBySource.reduce((sum, count) => sum + count, 0) : data?.counts.blocked ?? 0, inspected = preview ? Math.round(24816 * factor) : data?.counts.inspected ?? 0;
  const periodLabel = logPeriods.find(([value]) => value === period)[1];
  const weights = Array.from({ length: 36 }, (_, i) => 8 + Math.round((1 + Math.sin(i * 1.8)) * 8) + (i > 18 && i < 25 ? 85 - Math.abs(i - 21) * 17 : 0));
  const weightTotal = weights.reduce((sum, n) => sum + n, 0);
  const counts = preview ? weights.map((n) => Math.floor(n * blocked / weightTotal)) : [...(data?.buckets ?? weights.map(() => 0))];
  counts[counts.length - 1] += blocked - counts.reduce((sum, n) => sum + n, 0);
  const chartPeak = Math.max(10, Math.ceil(Math.max(...counts) / 10) * 10);
  function change(key, value) { setPolicy((p) => ({ ...p, [key]: value })); }
  function openException(ip = '') { setAddress(ip); setNote(''); setFormError(''); setDialog({ kind: 'exception' }); }
  async function addException(e) {
    e.preventDefault();
    const ip = address.trim();
    if (preview && (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split('.').some((v) => Number(v) > 255))) {
      setFormError('Enter an IPv4 address, for example 192.0.2.18.'); return;
    }
    if (exceptions.some((item) => item.ip === ip)) { setFormError('This address is already allowed.'); return; }
    if (!preview) {
      await perform(async () => {
        await persist({ ...saved, exceptions: [...saved.exceptions, { ip, note: note.trim() }] });
        await api('/security/release', { method: 'POST', body: { ip } });
        setDialog(null); report('Address allowed');
      }); return;
    }
    setExceptions((items) => [...items, { id: Date.now(), ip, note: note.trim(), scope: 'All HTTP services' }]);
    setDecisions((items) => items.map((d) => d.ip === ip ? { ...d, action: 'Allowed' } : d));
    setDialog(null); report('Address allowed and existing block removed');
  }
  if (!preview && !data) return error ? <Alert color="red">{error}</Alert> : <Stack gap="lg" aria-label="Loading security"><Skeleton height={34} width="30%" /><div className="logs-metrics">{[1, 2, 3, 4].map((n) => <Skeleton key={n} height={105} radius="md" />)}</div><Skeleton height={280} radius="md" /></Stack>;
  return <section className="monitoring logs-dashboard security-page" aria-label="Security">
    {(error || (!preview && data.error)) && <Alert color="yellow">{error || data.error}</Alert>}
    <Paper withBorder className="security-health">
      <span className="security-health-icon">{saved.mode === 'block' ? <ShieldCheck size={24} /> : <ShieldOff size={24} />}</span>
      <div className="security-health-copy"><h2>{!preview && !data.available ? 'Protection unavailable' : saved.mode === 'block' ? 'Protection is active' : saved.mode === 'monitor' ? 'Monitoring only' : 'Protection is off'}</h2><p>{!preview && !data.available ? `Requests follow your configured ${saved.failure === 'allow' ? 'allow' : 'deny'} fallback while CrowdSec recovers.` : saved.mode === 'block' ? 'Malicious HTTP requests are blocked before reaching your services.' : saved.mode === 'monitor' ? 'Threats are recorded. Requests are allowed through.' : 'HTTP inspection and automatic blocking are paused.'}</p></div>
      <a className="security-guide" href="https://docs.crowdsec.net/docs/appsec/intro/" target="_blank" rel="noreferrer">CrowdSec guide <ArrowUpRight size={14} /></a>
    </Paper>
    <Group justify="space-between" className="security-toolbar"><div className="filter-tabs" aria-label="Security views">{[['overview', 'Overview'], ['alerts', 'Alerts'], ['protection', 'Protection'], ['exceptions', 'Allowed addresses'], ['audit', 'Audit logs']].map(([value, label]) => <Button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</Button>)}</div>
      {tab === 'overview' && <Select aria-label="Security period" value={period} onChange={setPeriod} allowDeselect={false} data={logPeriods.map(([value, label]) => ({ value, label }))} />}
      {tab === 'alerts' || tab === 'audit' ? <div className="security-toolbar-filters" ref={setFilterTarget} /> : null}
    </Group>
    {tab === 'overview' && <>
      <div className="logs-metrics">
        <Metric label="Blocked requests" value={blocked.toLocaleString()} detail={`${(inspected ? blocked / inspected * 100 : 0).toFixed(1)}% of inspected HTTP requests`} icon={ShieldCheck} />
        <Metric label="Detected threats" value={(preview ? Math.round(1386 * factor) : data.counts.detected).toLocaleString()} detail="Includes blocked and monitor-only matches" icon={ShieldAlert} />
        <Metric label="Active banned IPs" value={preview ? active.length : data.observedBans} detail="Seen this period" icon={ShieldOff} />
        <Metric label="Inspected requests" value={inspected.toLocaleString()} detail="HTTP traffic across protected services" icon={Activity} />
      </div>
      <div className="logs-chart-grid">
        <Paper withBorder className="logs-surface"><div className="logs-panel-heading"><h2>Blocked requests</h2><Help label="About blocked requests">Counts requests stopped by WAF rules or an IP ban. A detected threat is not necessarily blocked.</Help></div>
          <div className="logs-chart-reading"><strong>{blocked.toLocaleString()}</strong><span>{periodLabel}</span></div>
          <svg viewBox="0 0 640 200" className="logs-traffic-chart security-chart" role="img" aria-label={`Blocked requests over the selected period; ${blocked.toLocaleString()} total`}>
            {[40, 95, 150].map((y, i) => <g key={y}><line x1="36" y1={y} x2="626" y2={y} className="logs-grid-line" /><text x="0" y={y + 4} className="logs-axis-label">{[chartPeak, chartPeak / 2, 0][i]}</text></g>)}
            {counts.map((count, i) => { const height = count / chartPeak * 110; return <rect key={i} x={40 + i * 16.1} y={150 - height} height={height} width="9" rx="3" fill={i > 18 && i < 25 ? '#e7af55' : '#38b89a'}><title>{count} blocked requests</title></rect>; })}
            <text x="36" y="181" className="logs-axis-label">{period === 'today' ? '00:00' : periodLabel}</text><text x="600" y="181" className="logs-axis-label">Now</text>
          </svg>{preview && <span className="logs-caption">A scanning burst accounts for most blocked requests in this period.</span>}
        </Paper>
        <Paper withBorder className="logs-surface"><div className="logs-panel-heading"><h2>What we stopped</h2><Help label="Detection sources">WAF inspects requests. Behavior identifies repeated abuse. Reputation uses known malicious IP decisions.</Help></div><div className="security-breakdown">{[['WAF rules', 64], ['Behavioral detection', 25], ['IP reputation', 11], ...(!preview && data.counts.sources.Availability ? [['Engine unavailable', 0]] : [])].map(([label, percent], index) => <div key={label}><div><span>{label}</span><strong>{blockedBySource[index].toLocaleString()}</strong></div><div className="security-bar"><span style={{ width: `${preview ? percent : blocked ? blockedBySource[index] / blocked * 100 : 0}%` }} /></div></div>)}</div></Paper>
      </div>
      <Paper withBorder className="logs-surface logs-events"><div className="logs-panel-heading"><h2>Recent decisions</h2><Badge color="gray" variant="light">{decisions.length} addresses</Badge></div>
        <Group justify="space-between"><TextInput leftSection={<Search size={15} />} aria-label="Search decisions" placeholder="Search IP, threat, or service" value={query} onChange={(e) => setQuery(e.currentTarget.value)} /></Group>
        <Table.ScrollContainer minWidth={850}><Table className="logs-table" verticalSpacing="md"><Table.Thead><Table.Tr>{['Source', 'Threat / service', 'Source of decision', 'Action', 'Blocked requests', 'Expires', ''].map((label, i) => <Table.Th key={i}>{label}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{visible.map((d) => <Table.Tr key={d.id}>
          <Table.Td><button className="logs-ip-filter" onClick={() => setDialog({ kind: 'detail', decision: d })}><code>{d.ip}</code></button><div className="logs-caption">{preview ? `${d.age} min ago` : formatDateTime(d.time)}</div></Table.Td>
          <Table.Td><strong>{d.reason}</strong><div className="logs-caption">{d.host}</div></Table.Td><Table.Td>{d.engine}</Table.Td><Table.Td><Badge color={d.banned ? 'red' : d.action === 'Blocked' ? 'orange' : d.action === 'Allowed' ? 'teal' : 'gray'} variant="light">{d.banned ? 'IP ban active' : d.action === 'Blocked' ? 'Request blocked' : d.action === 'Detected' ? 'Detection only' : d.action === 'Released' ? 'Ban removed' : d.action}</Badge></Table.Td><Table.Td>{d.requests}</Table.Td><Table.Td>{expiry(d)}</Table.Td><Table.Td><Button className="secondary small" onClick={() => setDialog({ kind: 'detail', decision: d })}>Details</Button></Table.Td>
        </Table.Tr>)}{!visible.length && <Table.Tr><Table.Td colSpan={7}>No decisions match your search.</Table.Td></Table.Tr>}</Table.Tbody></Table></Table.ScrollContainer>
      </Paper>
      <Paper withBorder className="logs-surface security-updates"><div><h3>{!preview && data.error ? 'Rules need attention' : !preview && !data.updated ? 'Rules installed' : 'Rules are up to date'}</h3><p>Last successful update {preview ? formatDateTime(updated) : data.updated ? formatDateTime(data.updated) : 'Not yet checked'} · {saved.updates ? 'Automatic updates daily' : 'Automatic updates paused'}</p></div><Button className="secondary" disabled={busy || (!preview && data.updating)} onClick={() => perform(async () => { if (preview) setUpdated(Date.now()); else { await api('/security/update', { method: 'POST' }); await load(); } report('Rule update requested'); })}><RefreshCw size={15} />Check for updates</Button></Paper>
    </>}
    {tab === 'alerts' && filterTarget && <Monitoring key="alerts" state={state} onLogout={onLogout} view="alert" toolbarTarget={filterTarget} serviceFilter />}
    {tab === 'audit' && filterTarget && <Monitoring key="audit" state={state} onLogout={onLogout} audit toolbarTarget={filterTarget} serviceFilter />}
    {tab === 'protection' && <form onSubmit={(e) => { e.preventDefault(); perform(async () => { await persist(policy); report('Protection settings saved'); }); }}>
      <div className="security-settings-grid"><Paper withBorder className="logs-surface"><Stack gap="xl"><div><h2>Protection policy</h2><p>Choose how suspicious HTTP traffic is handled.</p></div>
        <Select label="Default protection" description="Applies to HTTP services unless overridden below." value={policy.mode} onChange={(value) => change('mode', value)} allowDeselect={false} data={modes} />
        {policy.mode !== 'block' && <Alert color="yellow">{policy.mode === 'monitor' ? 'Monitor only records threats without blocking requests.' : 'Off stops inspection and blocking for services using the default policy.'}</Alert>}
        <Select label="IP ban duration" description="Default for locally detected behavioral abuse. Reputation decisions keep their upstream expiry." value={policy.duration} onChange={(value) => change('duration', value)} allowDeselect={false} data={[{ value: '1h', label: '1 hour' }, { value: '4h', label: '4 hours' }, { value: '24h', label: '24 hours' }]} />
        <Select label="If the security engine is unavailable" description="Choose between service availability and strict enforcement." value={policy.failure} onChange={(value) => change('failure', value)} allowDeselect={false} data={[{ value: 'allow', label: 'Allow requests and raise an alert' }, { value: 'deny', label: 'Deny requests until the engine recovers' }]} />
      </Stack></Paper><Paper withBorder className="logs-surface"><Stack gap="xl"><div><h2>Detection & updates</h2><p>Use maintained CrowdSec rules and reputation data.</p></div>
        {[['waf', 'Web application firewall', 'Inspect paths, query strings, headers, and supported request bodies for exploits.'], ['behavior', 'Behavioral detection', 'Detect scanning, repeated failures, and abusive request patterns.'], ['reputation', 'Community IP reputation', 'Apply CrowdSec decisions for known malicious IP addresses.'], ['updates', 'Automatic rule updates', 'Check daily, apply new rules, and alert if an update fails.']].map(([key, label, description]) => <Switch key={key} label={label} description={description} checked={policy[key]} onChange={(e) => change(key, e.currentTarget.checked)} />)}
        <div><h3>WAF compatibility exceptions</h3><p>Allow these application methods for their specific endpoints. Other WAF checks still apply.</p>
          {[['umamiDelete', 'Umami website deletion', 'Allow DELETE on logs.krychlic.com/api/websites/<website UUID>.'], ['socketIo', 'Socket.IO plain text requests', 'Skip CRS rule 920420 for plain text POSTs to /socket.io/.']].map(([key, label, description]) => <Switch key={key} label={label} description={description} checked={policy.appsecExceptions?.[key] ?? true} onChange={(e) => change('appsecExceptions', { ...policy.appsecExceptions, [key]: e.currentTarget.checked })} />)}
        </div>
      </Stack></Paper></div>
      <Paper withBorder className="logs-surface security-route-policy"><div className="logs-panel-heading"><h2>Service overrides</h2><Help label="About service overrides">Use monitor only while tuning a service. Off bypasses inspection and blocking for that service.</Help></div><p>Temporarily relax a service without changing protection everywhere else.</p>
        {[...state.routes.filter((r) => ['http', 'static', 'redirect'].includes(r.kind)), { id: 'catch-all', name: 'Unmatched hosts', hostname: 'Default and wildcard catch-all' }].map((r) => <div className="security-policy-row" key={r.id}><div><h3>{r.name}</h3><span className="logs-caption">{r.hostname}</span></div><Select aria-label={`${r.name} protection`} value={policy.routes[r.id] ?? 'inherit'} onChange={(value) => change('routes', { ...policy.routes, [r.id]: value })} allowDeselect={false} data={[{ value: 'inherit', label: 'Use default' }, ...modes]} /></div>)}
      </Paper><Group className="security-save" justify="flex-end"><span className="logs-caption" role="status">{dirty ? 'Unsaved changes' : 'All changes saved'}</span><Button className="secondary" disabled={!dirty || busy} onClick={() => setPolicy(structuredClone(saved))}>Discard</Button><Button className="primary" type="submit" disabled={!dirty || busy}>Save protection</Button></Group>
    </form>}
    {tab === 'exceptions' && <Paper withBorder className="logs-surface logs-events"><div className="logs-panel-heading"><h2>Allowed addresses</h2><Button className="primary" onClick={() => openException()}><Plus size={16} />Allow address</Button></div><p>Trusted addresses bypass WAF and IP blocking across HTTP services. Allow only addresses you control.</p>
      {exceptions.map((item) => <div className="security-policy-row" key={item.id}><div><h3><code>{item.ip}</code></h3><p>{item.note || 'No note'} · {item.scope}</p></div><Button className="icon-button" aria-label={`Remove ${item.ip}`} onClick={() => setDialog({ kind: 'remove', exception: item })}><Trash2 size={16} /></Button></div>)}{!exceptions.length && <p>No allowed addresses. All clients follow the protection policy.</p>}
    </Paper>}
    {dialog?.kind === 'exception' && <Modal title="Allow address" onClose={() => setDialog(null)}><form onSubmit={addException}><Stack gap="lg"><TextInput autoFocus label="IP address" placeholder="192.0.2.18" value={address} onChange={(e) => setAddress(e.currentTarget.value)} error={formError} required /><Textarea label="Note" placeholder="Why is this address trusted?" value={note} onChange={(e) => setNote(e.currentTarget.value)} /><Alert color="yellow">This address will bypass all HTTP protection. Any current ban will be removed.</Alert><Group justify="flex-end"><Button className="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button className="primary" type="submit">Allow address</Button></Group></Stack></form></Modal>}
    {dialog?.kind === 'remove' && <Modal title="Remove allowed address" onClose={() => setDialog(null)}><p><code>{dialog.exception.ip}</code> will be inspected and may be blocked by the protection policy.</p><Group justify="flex-end"><Button className="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button className="primary" disabled={busy} onClick={() => perform(() => removeException(dialog.exception))}>Remove address</Button></Group></Modal>}
    {dialog?.kind === 'detail' && (() => {
      const decision = dialog.decision, explanation = explainDecision(decision);
      return <Modal title="Security decision" onClose={() => setDialog(null)}>
        <Badge variant="light" color={decision.banned ? 'red' : decision.action === 'Blocked' ? 'orange' : 'gray'}>
          {decision.banned ? 'IP ban active' : decision.action === 'Blocked' ? 'Request blocked' : decision.action === 'Released' ? 'Ban removed' : decision.action}
        </Badge>
        <dl className="security-detail">{[
          ['Source', decision.ip], ['Threat', explanation.threat], ['Rule', explanation.rule], ['Service', decision.host],
          ['Request', `${decision.method || 'Request'} ${decision.path}`],
          ['Enforcement', decision.banned ? 'Active IP ban · requests stopped at the edge' : decision.action === 'Blocked' ? 'This request received HTTP 403 at the edge' : 'Request allowed'],
          ['Blocked requests', decision.requests], ['Expires', expiry(decision)],
        ].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
        {explanation.detail && <p>{explanation.detail}</p>}
        <p><a href={explanation.link} target="_blank" rel="noreferrer">{explanation.linkLabel} <ArrowUpRight size={14} /></a>
          {explanation.secondaryLink && <> · <a href={explanation.secondaryLink} target="_blank" rel="noreferrer">{explanation.secondaryLinkLabel} <ArrowUpRight size={14} /></a></>}
        </p>
        {decision.banned && <p>Removing a ban lets this address retry. New malicious requests can trigger another block.</p>}
        <Group justify="flex-end"><Button className="secondary" onClick={() => openException(decision.ip)}>Allow address</Button>
          {decision.banned && <Button className="primary" disabled={busy} onClick={() => perform(() => release(decision))}>Remove ban</Button>}
        </Group>
      </Modal>;
    })()}
  </section>;
}
