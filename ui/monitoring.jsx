import React, { useEffect, useRef, useState } from 'react';
import { Alert, Checkbox, Group, Paper, Popover, Select, Table, TextInput, Tooltip, Stack } from '@mantine/core';
import { Activity, ShieldAlert, ListFilter, CircleCheck, Download, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';
import { Button } from './controls.jsx';
import { api } from './api.js';
import LogCharts from './log-charts.jsx';
import { logPeriod, logPeriods } from './log-period.js';
import { formatDateTime } from './date-time.js';

function ColumnFilter({ column, filter, names, onChange }) {
  const [opened, setOpened] = useState(false), [op, setOp] = useState('contains'), [value, setValue] = useState('');
  const [field, label] = column;
  return <Popover opened={opened} onChange={setOpened} position="bottom-start" shadow="md" width={270}>
    <Popover.Target><button type="button" className={`logs-column-filter ${filter ? 'active' : ''}`}
      aria-label={`Filter ${label}`} aria-pressed={!!filter} onClick={() => {
        setOp(filter?.op ?? (field === 'service' ? 'equals' : 'contains')); setValue(filter?.value ?? ''); setOpened(!opened);
      }}>{label}<ListFilter size={13} /></button></Popover.Target>
    <Popover.Dropdown><form onSubmit={(e) => { e.preventDefault(); onChange({ op, value }); setOpened(false); }}>
      <Stack gap="sm">
        <Select label={`${label} filter`} value={op} allowDeselect={false} onChange={setOp} comboboxProps={{ withinPortal: false }} data={[
          { value: 'contains', label: 'Contains' }, { value: 'equals', label: 'Equals' },
          { value: 'excludes', label: 'Does not equal' }, { value: 'empty', label: 'Is empty' }, { value: 'present', label: 'Is not empty' },
        ]} />
        {!['empty', 'present'].includes(op) && (field === 'service'
          ? <Select label="Service" searchable value={value || null} onChange={(v) => setValue(v ?? '')} comboboxProps={{ withinPortal: false }} data={[...names].map(([value, label]) => ({ value, label }))} />
          : field === 'suspicious' ? <Select label="Classification" value={value || null} onChange={(v) => setValue(v ?? '')} comboboxProps={{ withinPortal: false }} data={['Suspicious', 'Normal']} />
          : <TextInput label={field === 'time' ? 'Time (ISO / UTC)' : 'Value'} value={value} onChange={(e) => setValue(e.currentTarget.value)} autoFocus />)}
        <Group justify="space-between"><Button className="text-button" onClick={() => { onChange(null); setOpened(false); }}>Clear</Button><Button className="primary" type="submit">Apply</Button></Group>
      </Stack>
    </form></Popover.Dropdown>
  </Popover>;
}

export default function Monitoring({ state, onLogout, audit = false }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false),
    [period, setPeriod] = useState('hour'), [services, setServices] = useState(null),
    [kind, setKind] = useState(audit ? 'administration' : 'traffic'), [columns, setColumns] = useState({}), [source, setSource] = useState(''), [sourceInput, setSourceInput] = useState(''),
    [page, setPage] = useState(null), [previous, setPrevious] = useState([]);
  const extraNames = useRef(new Map());
  const selection = services === null ? null : services.join(',');
  const scope = JSON.stringify([period, selection, kind, source, columns]);
  useEffect(() => { setPage(null); setPrevious([]); setData(null); }, [scope]);
  useEffect(() => {
    let active = true, inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true; setBusy(true);
      const bounds = page?.bounds ?? logPeriod(period);
      const query = new URLSearchParams({ ...bounds, kind, source, columns: JSON.stringify(columns),
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
    { label: 'Client errors', value: totals?.clientErrors.toLocaleString() ?? '—', detail: periodLabel, icon: ShieldAlert },
    { label: 'Server errors', value: totals?.serverErrors.toLocaleString() ?? '—', detail: periodLabel, icon: ListFilter },
  ];
  const download = new URLSearchParams({ ...(data?.period ?? logPeriod(period)), kind, source, columns: JSON.stringify(columns),
    ...(selection === null ? {} : { services: selection }) });
  const tableColumns = [['time', 'Time'], ['service', 'Service'], ['event', 'Event'],
    ...(audit ? [['generation', 'Generation'], ['role', 'Role'], ['details', 'Details'], ['severity', 'Severity']] : kind === 'traffic' ? [['suspicious', 'Classification']] : [['severity', 'Severity']]),
    ['source', 'Client IP'], ['method', 'Method'], ['url', 'Request URL'], ['status', 'Status']];
  return <section className="monitoring logs-dashboard">
    {!audit && <div className="filter-tabs" aria-label="Log view">{[['traffic', 'Logs'], ['alert', 'Alerts']].map(([value, label]) =>
      <Button key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setColumns({}); setSource(''); setSourceInput(''); }}>{label}</Button>)}</div>}
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
    {data && !data.edgeAvailable && <Alert color="yellow">Edge logs unavailable. Showing available records; complete download is unavailable.</Alert>}
    {!audit && kind === 'traffic' && <><div className="logs-metrics">{metrics.map(({ label, value, detail, icon: Icon }) => <Paper key={label} withBorder className="logs-metric">
      <div className="logs-metric-label">{label}<Icon size={17} /></div><strong>{value}</strong><span>{detail}</span>
    </Paper>)}</div>
    <LogCharts key={scope} summary={summary} periodLabel={periodLabel} /></>}
    <Paper withBorder className="logs-surface logs-events">
      <div className="logs-panel-heading"><h2>{audit ? 'Audit events' : kind === 'alert' ? 'Alerts' : 'Traffic logs'}</h2>
        <Button className="secondary logs-download" component="a" href={data?.edgeAvailable ? `/api/logs/download?${download}` : undefined} download
          aria-disabled={!data?.edgeAvailable} disabled={!data?.edgeAvailable}><Download size={15} />Download all</Button>
      </div>
      <form className="monitoring-filters" onSubmit={(e) => { e.preventDefault(); setSource(sourceInput.trim()); }}>
        <TextInput className="logs-client-filter" label="Client IP" placeholder="All addresses" value={sourceInput} onChange={(e) => setSourceInput(e.currentTarget.value)} />
        <Button type="submit" className="secondary logs-apply-filter">Apply</Button>
        <Button className="text-button" onClick={() => { setColumns({}); setSource(''); setSourceInput(''); setServices(null); }}>Clear filters</Button>
      </form>
      <Table.ScrollContainer minWidth={1000}><Table className="logs-table" verticalSpacing="sm">
        <Table.Thead><Table.Tr>{tableColumns.map((column) => <Table.Th key={column[0]}><ColumnFilter column={column} names={names} filter={columns[column[0]]} onChange={(filter) => setColumns((old) => {
          const next = { ...old }; if (filter) next[column[0]] = filter; else delete next[column[0]]; return next;
        })} /></Table.Th>)}</Table.Tr></Table.Thead>
        <Table.Tbody>{data?.events.map((e) => <Table.Tr key={`${e.component}:${e.id}`}>
          <Table.Td className="logs-time">{formatDateTime(e.time)}</Table.Td>
          <Table.Td>{names.get(e.service) ?? 'Previous route'}</Table.Td>
          <Table.Td><span className={`logs-event-label ${e.type === 'alert' || e.suspicious || e.event === 'Exploit-path probe' ? 'alert' : e.severity === 'warning' ? 'warning' : ''}`}>{e.type === 'alert' && <ShieldAlert size={13} />}{e.event}</span></Table.Td>
          {audit ? <><Table.Td><code>{e.generation ?? '—'}</code></Table.Td><Table.Td>{e.role ?? '—'}</Table.Td><Table.Td>{e.details ?? '—'}</Table.Td><Table.Td>{e.severity ?? '—'}</Table.Td></>
            : <Table.Td>{e.type === 'traffic' ? (e.suspicious || e.event === 'Exploit-path probe' ? <span className="logs-event-label alert"><ShieldAlert size={13} />Suspicious</span> : 'Normal') : e.severity ?? '—'}</Table.Td>}
          <Table.Td>{e.source ? /[.:]/.test(e.source) ? <button type="button" className="logs-ip-filter" onClick={() => { setSource(e.source); setSourceInput(e.source); }}><code>{e.source}</code></button> : <code>{e.source}</code> : '—'}</Table.Td>
          <Table.Td>{e.method ?? '—'}</Table.Td>          <Table.Td className="logs-url">{e.url ? <code>{e.url}</code> : '—'}</Table.Td>
          <Table.Td><span className={`logs-status-code ${e.status >= 400 ? 'error' : ''}`}>{e.status ?? '—'}</span></Table.Td>
        </Table.Tr>)}{data?.events.length === 0 && <Table.Tr><Table.Td colSpan={tableColumns.length}>No matching {audit ? 'audit events' : kind === 'alert' ? 'alerts' : 'traffic logs'}.</Table.Td></Table.Tr>}</Table.Tbody>
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
