import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Alert, Checkbox, Group, Paper, Popover, Select, Skeleton, Table, TextInput, Tooltip, Stack } from '@mantine/core';
import { Activity, ShieldAlert, ListFilter, CircleCheck, Download, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';
import { Button } from './controls.jsx';
import Modal from './dialog.jsx';
import { api } from './api.js';
import LogCharts from './log-charts.jsx';
import { logPeriod, logPeriods } from './log-period.js';
import { formatDateTime } from './date-time.js';
import { subscribeUpdates } from './events.js';

const choiceColumns = ['event', 'action', 'suspicious', 'method', 'status', 'severity', 'role'];

function alertDescription(event) {
  return ({
    'Repeated exploit-path probes': 'The proxy saw at least five requests from this source to common discovery paths, such as .env, .git, wp-login, or phpMyAdmin, for this service within 60 seconds. This suggests scanning; it does not show that access succeeded. This alert by itself does not block requests.',
    'Traffic burst': 'The proxy saw an unusually high number of requests or sessions for this service within 60 seconds. A burst can be suspicious, but legitimate load can also trigger this alert. The alert itself does not block traffic.',
    'Repeated server / upstream failures': 'At least 20 requests failed with server or upstream errors, and at least half of the requests in the monitoring window failed. This points to a service or upstream health issue; it does not indicate an attack by itself.',
    'Repeated denied access': 'The proxy recorded at least 20 denied requests in the monitoring window. These may be unauthorized attempts or repeated requests blocked by an existing policy.',
    'Catch-all scanning': 'At least 60 requests reached unmatched hostnames and returned not found responses in the monitoring window. This often indicates automated host or path discovery.',
    'Repeated missing resources': 'At least 60 requests to this service returned not found, and at least 80% of the requests in the monitoring window were missing resources. This can indicate automated path discovery or broken links.'
  })[event] ?? 'The proxy recorded this security event. Review the source, request, and action below to see what was observed and whether a blocking action was recorded.';
}

function ColumnFilter({ column, filter, options = [], onChange }) {
  const [opened, setOpened] = useState(false), [op, setOp] = useState('contains'), [value, setValue] = useState('');
  const [field, label] = column;
  if (['time', 'service'].includes(field)) return label;
  const choices = choiceColumns.includes(field);
  const values = [...new Set([...options, ...(filter?.op === 'in' ? filter.value : [])])].sort();
  return <Popover opened={opened} onChange={setOpened} position="bottom-start" shadow="md" width={300}>
    <Popover.Target><button type="button" className={`logs-column-filter ${filter ? 'active' : ''}`}
      aria-label={`Filter ${label}`} aria-pressed={!!filter} onClick={() => {
        setOp(filter?.op ?? 'contains'); setValue(filter?.value ?? ''); setOpened(!opened);
      }}>{label}<ListFilter size={13} /></button></Popover.Target>
    <Popover.Dropdown>{choices ? <>
      <Group justify="space-between" mb="sm">
        <Button className="text-button small" onClick={() => onChange(null)}>Select all</Button>
        <Button className="text-button small" onClick={() => onChange({ op: 'in', value: [] })}>Deselect all</Button>
      </Group>
      <div className="logs-service-checkboxes">{values.map((option) => <Checkbox key={option} label={option || 'Empty'}
        checked={!filter || filter.value.includes(option)} onChange={(e) => {
          const selected = filter?.value ?? values;
          const next = e.currentTarget.checked ? [...new Set([...selected, option])] : selected.filter((v) => v !== option);
          onChange(next.length === values.length ? null : { op: 'in', value: next });
        }} />)}{values.length === 0 && <span className="logs-caption">No values in this period.</span>}</div>
    </> : <form onSubmit={(e) => { e.preventDefault(); onChange({ op, value }); setOpened(false); }}>
      <Stack gap="sm">
        <Select label={`${label} filter`} value={op} allowDeselect={false} onChange={setOp} comboboxProps={{ withinPortal: false }} data={[
          { value: 'contains', label: 'Contains' }, { value: 'equals', label: 'Equals' },
          { value: 'excludes', label: 'Does not equal' }, { value: 'empty', label: 'Is empty' }, { value: 'present', label: 'Is not empty' },
        ]} />
        {!['empty', 'present'].includes(op) && <TextInput label="Value" value={value} onChange={(e) => setValue(e.currentTarget.value)} autoFocus />}
        <Group justify="space-between"><Button className="text-button" onClick={() => { onChange(null); setOpened(false); }}>Clear</Button><Button className="primary" type="submit">Apply</Button></Group>
      </Stack>
    </form>}</Popover.Dropdown>
  </Popover>;
}

export default function Monitoring({ state, onLogout, audit = false, view = null, toolbarTarget = null, serviceFilter = false }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false),
    [period, setPeriod] = useState('today'), [services, setServices] = useState(null),
    [customInterval, setCustomInterval] = useState(null), [chartSummary, setChartSummary] = useState(null),
    [selectedKind, setKind] = useState(audit ? 'administration' : 'traffic'), [columns, setColumns] = useState({}), [options, setOptions] = useState({}), [fields, setFields] = useState([]),
    [page, setPage] = useState(null), [previous, setPrevious] = useState([]), [selectedAlert, setSelectedAlert] = useState(null);
  const extraNames = useRef(new Map());
  const kind = view ?? selectedKind;
  const selection = services === null ? null : services.join(',');
  const scope = JSON.stringify([period, selection, kind, columns, customInterval]);
  useEffect(() => { setPage(null); setPrevious([]); setData(null); }, [scope]);
  useEffect(() => {
    let active = true, inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true; setBusy(true);
      const bounds = page?.bounds ?? customInterval ?? logPeriod(period);
      const query = new URLSearchParams({ ...bounds, kind, columns: JSON.stringify(columns),
        ...(selection === null ? {} : { services: selection }), ...(page?.cursor ? { cursor: page.cursor } : {}) });
      try {
        const next = await api(`/logs/view?${query}`);
        if (active) {
          for (const e of next.events) if (!['catch-all', 'management'].includes(e.service))
            extraNames.current.set(e.service, `Previous route · ${e.service.slice(0, 8)}`);
          setData(next); setOptions(next.summary?.options ?? {}); setFields(next.summary?.fields ?? []); setError('');
          if (!customInterval && kind === 'traffic') setChartSummary(next.summary);
        }
      } catch (e) {
        if (active) { setError(e.message); if (e.status === 401) onLogout(); }
      } finally { inFlight = false; if (active) setBusy(false); }
    }
    load();
    const unsubscribe = page ? null : subscribeUpdates(load, 'logs');
    return () => { active = false; unsubscribe?.(); };
  }, [scope, page]);
  const names = new Map([...extraNames.current, ['catch-all', 'Wildcard / unmatched'], ['management', 'Management'],
    ...state.routes.map((r) => [r.id, r.name])]);
  const selectedCount = services === null ? names.size : services.length;
  const summary = data?.summary, totals = summary?.totals;
  const presetLabel = logPeriods.find(([id]) => id === period)[1];
  const periodLabel = customInterval ? 'Custom interval' : presetLabel;
  const failures = totals ? totals.clientErrors + totals.serverErrors : 0;
  const metrics = [
    { label: 'Completed', value: totals?.requests.toLocaleString() ?? '—', detail: periodLabel, icon: Activity },
    { label: 'Success rate', value: totals?.requests ? `${(totals.success / totals.requests * 100).toFixed(1)}%` : '—', detail: totals ? `${failures.toLocaleString()} errors` : periodLabel, icon: CircleCheck },
    { label: 'Client errors', value: totals?.clientErrors.toLocaleString() ?? '—', detail: periodLabel, icon: ShieldAlert },
    { label: 'Server errors', value: totals?.serverErrors.toLocaleString() ?? '—', detail: periodLabel, icon: ListFilter },
  ];
  const download = new URLSearchParams({ ...(data?.period ?? customInterval ?? logPeriod(period)), kind, columns: JSON.stringify(columns),
    ...(selection === null ? {} : { services: selection }) });
  const hasFilters = services !== null || Object.keys(columns).length > 0;
  const tableColumns = [['time', 'Time'], ...(!audit ? [['service', 'Service']] : []), ...(audit || kind === 'alert' ? [['event', 'Event']] : []),
    ...(!audit && kind === 'alert' ? [['action', 'Action']] : []),
    ...(audit ? [['generation', 'Generation'], ['role', 'Role'], ['details', 'Details'], ['severity', 'Severity']] : kind === 'traffic' ? [['suspicious', 'Classification']] : [['severity', 'Severity']]),
    ['source', 'Client IP'], ['method', 'Method'], ['url', 'Request URL'], ['status', 'Status']]
    .filter(([field]) => !audit || ['time', 'event'].includes(field) || fields.includes(field) || columns[field]);
  const toolbar = <div className="logs-toolbar">
    {!audit && !view && <div className="filter-tabs" aria-label="Log view">{[['traffic', 'Logs'], ['alert', 'Alerts']].map(([value, label]) =>
      <Button key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setColumns({}); }}>{label}</Button>)}</div>}
    <div className="logs-top-filters">
      <Select className="logs-period-select" aria-label="Log period" value={customInterval ? 'custom' : period} allowDeselect={false}
        data={[...logPeriods.map(([value, label]) => ({ value, label })), ...(customInterval ? [{ value: 'custom', label: 'Custom', disabled: true }] : [])]}
        onChange={(value) => { if (value === 'custom') return; setCustomInterval(null); setPeriod(value ?? 'today'); setPage(null); setPrevious([]); }} />
      {(!audit || serviceFilter) && <Popover position="bottom-end" shadow="md" width={300}>
        <Popover.Target><Button className="secondary logs-service-select"><ListFilter size={15} />{services === null ? 'All services' : `${selectedCount} service${selectedCount === 1 ? '' : 's'}`}<ChevronDown size={14} /></Button></Popover.Target>
        <Popover.Dropdown>
          <Group justify="space-between" mb="sm"><Button className="text-button small" onClick={() => setServices(null)}>Select all</Button><Button className="text-button small" onClick={() => setServices([])}>Deselect all</Button></Group>
          <div className="logs-service-checkboxes">{[...names].map(([id, name]) => <Checkbox key={id} label={name}
            checked={services === null || services.includes(id)} onChange={(e) => {
              const checked = e.currentTarget.checked;
              setServices((old) => checked ? [...new Set([...(old ?? names.keys()), id])] : [...(old ?? names.keys())].filter((value) => value !== id));
            }} />)}</div>
        </Popover.Dropdown>
      </Popover>}
    </div>
  </div>;
  return <section className="monitoring logs-dashboard">
    {toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar}
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {data && !data.edgeAvailable && <Alert color="yellow">Edge logs unavailable. Showing available records; complete download is unavailable.</Alert>}
    {!audit && kind === 'traffic' && <div className="logs-metrics">{metrics.map(({ label, value, detail, icon: Icon }) => <Paper key={label} withBorder className="logs-metric">
      <div className="logs-metric-label">{label}<Icon size={17} /></div><strong>{value}</strong><span>{detail}</span>
    </Paper>)}</div>}
    {!audit && kind === 'traffic' && <LogCharts summary={customInterval ? chartSummary : summary} outcomeSummary={summary}
      periodLabel={presetLabel} outcomePeriodLabel={periodLabel} selection={customInterval} onSelectionChange={setCustomInterval}
      onClearSelection={() => setCustomInterval(null)} />}
    <Paper withBorder className="logs-surface logs-events">
      <div className="logs-panel-heading"><h2>{audit ? 'Audit events' : kind === 'alert' ? 'Alerts' : 'Traffic logs'}</h2>
        {hasFilters ? <Button className="secondary logs-clear-filters" color="red" onClick={() => { setColumns({}); setServices(null); }}>Clear filters</Button>
          : <Button className="secondary logs-download" component="a" href={data?.edgeAvailable ? `/api/logs/download?${download}` : undefined} download
            aria-disabled={!data?.edgeAvailable} disabled={!data?.edgeAvailable}><Download size={15} />Download all</Button>}
      </div>
      <Table.ScrollContainer minWidth={kind === 'alert' && !audit ? 1400 : 1000}><Table className={`logs-table${audit ? ' logs-audit-table' : ''}`} verticalSpacing="sm">
        <Table.Thead><Table.Tr>{tableColumns.map((column) => <Table.Th key={column[0]}><ColumnFilter column={column} options={options[column[0]]} filter={columns[column[0]]} onChange={(filter) => setColumns((old) => {
          const next = { ...old }; if (filter) next[column[0]] = filter; else delete next[column[0]]; return next;
        })} /></Table.Th>)}</Table.Tr></Table.Thead>
        <Table.Tbody>{data?.events.map((e) => <Table.Tr key={`${e.component}:${e.id}`}>
          {tableColumns.map(([field]) => <Table.Td key={field} className={`logs-${field}`}>
            {field === 'time' ? formatDateTime(e.time)
              : field === 'service' ? names.get(e.service) ?? 'Previous route'
              : field === 'event' ? <div className="logs-alert-event"><span className={`logs-event-label ${e.type === 'alert' || e.suspicious || e.event === 'Exploit-path probe' ? 'alert' : e.severity === 'warning' ? 'warning' : ''}`}>{e.type === 'alert' && <ShieldAlert size={13} />}{e.ruleUrl ? <a href={e.ruleUrl} target="_blank" rel="noreferrer">{e.event}</a> : !audit && kind === 'alert' ? <button type="button" className="logs-alert-event-trigger" onClick={() => setSelectedAlert(e)}>{e.event}</button> : e.event}</span></div>
              : field === 'action' ? <span className={`logs-action-label ${e.action === 'IP ban issued' ? 'ban' : e.action === 'Request blocked' ? 'blocked' : ''}`}>{e.action || '—'}</span>
              : field === 'suspicious' ? (e.suspicious || e.event === 'Exploit-path probe' ? <span className="logs-event-label alert"><ShieldAlert size={13} />Suspicious</span> : 'Normal')
              : field === 'source' ? (e.source ? /[.:]/.test(e.source) ? <button type="button" className="logs-ip-filter" onClick={() => setColumns((old) => ({ ...old, source: { op: 'equals', value: e.source } }))}><code>{e.source}</code></button> : <code>{e.source}</code> : '—')
              : field === 'url' || field === 'generation' ? (e[field] ? <code>{e[field]}</code> : '—')
              : field === 'status' ? <span className={`logs-status-code ${e.status >= 400 ? 'error' : ''}`}>{e.status ?? '—'}</span>
              : e[field] || '—'}
          </Table.Td>)}
        </Table.Tr>)}{!data && Array.from({ length: 6 }, (_, i) => <Table.Tr key={`skeleton-${i}`} aria-hidden="true">{tableColumns.map(([field]) => <Table.Td key={field}><Skeleton height={14} width={`${45 + (i * 17 + field.length * 11) % 45}%`} /></Table.Td>)}</Table.Tr>)}{data?.events.length === 0 && <Table.Tr><Table.Td colSpan={tableColumns.length}>No matching {audit ? 'audit events' : kind === 'alert' ? 'alerts' : 'traffic logs'}.</Table.Td></Table.Tr>}</Table.Tbody>
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
    {selectedAlert && <Modal title={selectedAlert.event || 'Alert details'} onClose={() => setSelectedAlert(null)}>
      <p>{alertDescription(selectedAlert.event)}</p>
      <dl className="logs-alert-detail">{[
        ['Action', selectedAlert.action || 'Not recorded'],
        ['Source', selectedAlert.source || 'Not available'],
        ['Service', names.get(selectedAlert.service) ?? 'Previous route'],
        ['Time', formatDateTime(selectedAlert.time)],
        ['Request', selectedAlert.method && selectedAlert.url ? `${selectedAlert.method} ${selectedAlert.url}` : selectedAlert.url || 'Not available'],
        ['HTTP status', selectedAlert.status ?? 'Not available'],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </Modal>}
  </section>;
}
