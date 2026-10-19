import React, { useEffect, useRef, useState } from 'react';
import { Alert, Checkbox, Group, Paper, Popover, Select, Table, TextInput, Tooltip } from '@mantine/core';
import { Activity, ShieldAlert, ListFilter, CircleCheck, Download, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';
import { Button } from './controls.jsx';
import { api } from './api.js';
import LogCharts from './log-charts.jsx';
import { logPeriod, logPeriods } from './log-period.js';
import { formatDateTime } from './date-time.js';

export default function Monitoring({ state, onLogout }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false),
    [period, setPeriod] = useState('hour'), [services, setServices] = useState(null),
    [kind, setKind] = useState('all'), [source, setSource] = useState(''), [sourceInput, setSourceInput] = useState(''),
    [page, setPage] = useState(null), [previous, setPrevious] = useState([]);
  const extraNames = useRef(new Map());
  const selection = services === null ? null : services.join(',');
  const scope = JSON.stringify([period, selection, kind, source]);
  useEffect(() => { setPage(null); setPrevious([]); setData(null); }, [scope]);
  useEffect(() => {
    let active = true, inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true; setBusy(true);
      const bounds = page?.bounds ?? logPeriod(period);
      const query = new URLSearchParams({ ...bounds, kind, source,
        ...(selection === null ? {} : { services: selection }), ...(page?.cursor ? { cursor: page.cursor } : {}) });
      try {
        const next = await api(`/logs/view?${query}`);
        if (active) {
          for (const e of next.events) if (!['catch-all', 'management'].includes(e.service))
            extraNames.current.set(e.service, `Previous route · ${e.service.slice(0, 8)}`);
          setData(next); setError('');
        }
      } catch (e) {
        if (active) { setError(e.message); if (e.status === 401) onLogout(); }
      } finally { inFlight = false; if (active) setBusy(false); }
    }
    load();
    const timer = page ? null : setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [scope, page]);
  const names = new Map([...extraNames.current, ['catch-all', 'Wildcard / unmatched'], ['management', 'Management'],
    ...state.routes.map((r) => [r.id, r.name])]);
  const selectedCount = services === null ? names.size : services.length;
  const summary = data?.summary, totals = summary?.totals;
  const periodLabel = logPeriods.find(([id]) => id === period)[1];
  const failures = totals ? totals.clientErrors + totals.serverErrors : 0;
  const metrics = [
    { label: 'Completed', value: totals?.requests.toLocaleString() ?? '—', detail: periodLabel, icon: Activity },
    { label: 'Success rate', value: totals?.requests ? `${(totals.success / totals.requests * 100).toFixed(1)}%` : '—', detail: totals ? `${failures.toLocaleString()} errors` : periodLabel, icon: CircleCheck },
    { label: 'Alerts', value: totals?.alerts.toLocaleString() ?? '—', detail: periodLabel, icon: ShieldAlert },
    { label: 'Events', value: totals?.count.toLocaleString() ?? '—', detail: periodLabel, icon: ListFilter },
  ];
  const download = new URLSearchParams({ ...(data?.period ?? logPeriod(period)), kind, source,
    ...(selection === null ? {} : { services: selection }) });
  return <section className="monitoring logs-dashboard">
    <div className="logs-top-filters">
      <div className="filter-tabs logs-periods" aria-label="Log period">{logPeriods.map(([value, label]) =>
        <Button key={value} aria-pressed={period === value} onClick={() => { setPeriod(value); setPage(null); setPrevious([]); }}>{label}</Button>)}</div>
      <Select className="logs-period-select" aria-label="Log period" value={period} allowDeselect={false}
        data={logPeriods.map(([value, label]) => ({ value, label }))}
        onChange={(value) => { setPeriod(value ?? 'hour'); setPage(null); setPrevious([]); }} />
      <Popover position="bottom-end" shadow="md" width={300}>
        <Popover.Target><Button className="secondary logs-service-select"><ListFilter size={15} />{services === null ? 'All services' : `${selectedCount} service${selectedCount === 1 ? '' : 's'}`}<ChevronDown size={14} /></Button></Popover.Target>
        <Popover.Dropdown>
          <Group justify="space-between" mb="sm"><Button className="text-button small" onClick={() => setServices(null)}>Select all</Button><Button className="text-button small" onClick={() => setServices([])}>Deselect all</Button></Group>
          <div className="logs-service-checkboxes">{[...names].map(([id, name]) => <Checkbox key={id} label={name}
            checked={services === null || services.includes(id)} onChange={(e) => {
              const checked = e.currentTarget.checked;
              setServices((old) => checked ? [...new Set([...(old ?? names.keys()), id])] : [...(old ?? names.keys())].filter((value) => value !== id));
            }} />)}</div>
        </Popover.Dropdown>
      </Popover>
    </div>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {data && !data.edgeAvailable && <Alert color="yellow">Edge logs unavailable. Showing administration events; complete download is unavailable.</Alert>}
    <div className="logs-metrics">{metrics.map(({ label, value, detail, icon: Icon }) => <Paper key={label} withBorder className="logs-metric">
      <div className="logs-metric-label">{label}<Icon size={17} /></div><strong>{value}</strong><span>{detail}</span>
    </Paper>)}</div>
    <LogCharts key={scope} summary={summary} periodLabel={periodLabel} />
    <Paper withBorder className="logs-surface logs-events">
      <div className="logs-panel-heading"><h2>Events</h2>
        <Button className="secondary logs-download" component="a" href={data?.edgeAvailable ? `/api/logs/download?${download}` : undefined} download
          aria-disabled={!data?.edgeAvailable} disabled={!data?.edgeAvailable}><Download size={15} />Download all</Button>
      </div>
      <form className="monitoring-filters" onSubmit={(e) => { e.preventDefault(); setSource(sourceInput.trim()); }}>
        <Select className="logs-event-filter" label="Event type" value={kind} onChange={(value) => setKind(value ?? 'all')} data={[
          { value: 'all', label: 'All events' }, { value: 'alert', label: 'Suspicious activity' },
          { value: 'traffic', label: 'Traffic' }, { value: 'audit', label: 'Administration' }, { value: 'operation', label: 'Edge operations' },
        ]} />
        <TextInput className="logs-client-filter" label="Client IP" placeholder="All addresses" value={sourceInput} onChange={(e) => setSourceInput(e.currentTarget.value)} />
        <Button type="submit" className="secondary logs-apply-filter">Apply</Button>
      </form>
      <Table.ScrollContainer minWidth={1000}><Table className="logs-table" verticalSpacing="sm">
        <Table.Thead><Table.Tr>{['Time', 'Service', 'Event', 'Client IP', 'Request URL', 'Status'].map((v) => <Table.Th key={v}>{v}</Table.Th>)}</Table.Tr></Table.Thead>
        <Table.Tbody>{data?.events.map((e) => <Table.Tr key={`${e.component}:${e.id}`}>
          <Table.Td className="logs-time">{formatDateTime(e.time)}</Table.Td>
          <Table.Td>{names.get(e.service) ?? 'Previous route'}</Table.Td>
          <Table.Td><span className={`logs-event-label ${e.type === 'alert' ? 'alert' : e.severity === 'warning' ? 'warning' : ''}`}>{e.type === 'alert' && <ShieldAlert size={13} />}{e.event}</span></Table.Td>
          <Table.Td>{e.source ? /[.:]/.test(e.source) ? <button type="button" className="logs-ip-filter" onClick={() => { setSource(e.source); setSourceInput(e.source); }}><code>{e.source}</code></button> : <code>{e.source}</code> : '—'}</Table.Td>
          <Table.Td className="logs-url">{e.url ? <><span className="logs-method">{e.method}</span><code>{e.url}</code></> : '—'}</Table.Td>
          <Table.Td><span className={`logs-status-code ${e.status >= 400 ? 'error' : ''}`}>{e.status ?? '—'}</span></Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table></Table.ScrollContainer>
      <Group justify="space-between"><span className="logs-caption">{data ? `${data.events.length} of ${totals.count.toLocaleString()} matching events` : 'Loading events…'}</span>
        <Group gap="xs" className="logs-pagination" aria-label="Event pages">
          <Tooltip label="Newest events"><Button className="secondary logs-page-button" aria-label="Newest events" disabled={busy || !page} onClick={() => { setPage(null); setPrevious([]); }}><ChevronsLeft size={18} /></Button></Tooltip>
          <Tooltip label="Newer events"><Button className="secondary logs-page-button" aria-label="Newer events" disabled={busy || previous.length === 0} onClick={() => { setPage(previous.at(-1)); setPrevious((old) => old.slice(0, -1)); }}><ChevronLeft size={18} /></Button></Tooltip>
          <span className="logs-page-number" aria-live="polite">{previous.length + 1}</span>
          <Tooltip label="Older events"><Button className="secondary logs-page-button" aria-label="Older events" disabled={busy || !data?.next} onClick={() => { setPrevious((old) => [...old, page]); setPage({ cursor: data.next, bounds: data.period }); }}><ChevronRight size={18} /></Button></Tooltip>
        </Group>
      </Group>
    </Paper>
  </section>;
}
