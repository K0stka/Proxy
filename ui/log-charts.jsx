import React, { useId, useRef, useState } from 'react';
import { Paper } from '@mantine/core';
import Help from './help.jsx';
import { Button } from './controls.jsx';
import { logSelection, logSelectionIndices } from './log-period.js';

import { formatDateTime } from './date-time.js';
const time = (minute) => formatDateTime(minute * 60000);
const number = (value) => value.toLocaleString();
const serviceColors = ['#38b89a', '#e7af55', '#8c7be5', '#53a7d8', '#e7799b', '#91b85b', '#dd8753', '#77849b'];
function ServicePie({ title, field, breakdown = [], names }) {
  const rows = breakdown.map((item) => ({ name: names.get(item.service) ?? `Previous route · ${item.service.slice(0, 8)}`, value: item[field] ?? 0 }))
    .filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const shown = rows.slice(0, 7), other = rows.slice(7).reduce((sum, item) => sum + item.value, 0);
  if (other) shown.push({ name: 'Other services', value: other });
  const total = shown.reduce((sum, item) => sum + item.value, 0);
  let offset = 0;
  return <Paper withBorder className="logs-surface logs-service-pie">
    <div className="logs-panel-heading"><h3>{title}</h3><span className="logs-caption">{number(total)} responses</span></div>
    {!total ? <p className="logs-caption">No responses in this period.</p> : <div className="logs-service-pie-content">
      <svg viewBox="0 0 120 120" role="img" aria-label={`${title} by service: ${shown.map((item) => `${item.name} ${item.value}`).join(', ')}`}>
        {shown.length === 1 ? <circle cx="60" cy="60" r="56" fill={serviceColors[0]} /> : shown.map((item, i) => {
          const fraction = item.value / total, start = offset, end = start + fraction * Math.PI * 2;
          offset = end;
          const point = (angle) => [60 + 56 * Math.cos(angle - Math.PI / 2), 60 + 56 * Math.sin(angle - Math.PI / 2)];
          const [x1, y1] = point(start), [x2, y2] = point(end);
          return <path key={item.name} d={`M 60 60 L ${x1} ${y1} A 56 56 0 ${fraction > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`} fill={serviceColors[i % serviceColors.length}><title>{item.name}: {number(item.value)} ({(fraction * 100).toFixed(1)}%)</title></path>;
        })}
      </svg>
      <ul>{shown.map((item, i) => <li key={item.name}><span><i style={{ background: serviceColors[i % serviceColors.length] }} />{item.name}</span><strong>{(item.value / total * 100).toFixed(1)}%</strong></li>)}</ul>
    </div>}
  </Paper>;
}
export default function LogCharts({ summary, outcomeSummary = summary, serviceNames = new Map(), periodLabel = 'Today', outcomePeriodLabel = periodLabel,
  selection = null, onSelectionChange, onClearSelection }) {
  const id = useId(), [hover, setHover] = useState(null), [draft, setDraft] = useState(null), drag = useRef(null);
  const buckets = summary?.buckets ?? [], chartTotals = summary?.totals, totals = outcomeSummary?.totals;
  const peak = Math.max(1, ...buckets.map((b) => b.requests));
  const x = (i) => 38 + i * 584 / Math.max(1, buckets.length - 1);
  const y = (value) => 178 - value / peak * 150;
  const line = (key) => buckets.map((b, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(b[key])}`).join(' ');
  const selected = buckets[Math.min(hover ?? buckets.length - 1, buckets.length - 1)];
  const interval = draft ?? selection, indices = logSelectionIndices(summary, interval);
  const edgeX = (i) => 38 + i * 584 / Math.max(1, buckets.length);
  function pointerIndex(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(buckets.length - 1, Math.floor(((e.clientX - rect.left) * 640 / rect.width - 38) / 584 * buckets.length)));
  }
  function pointerMove(e) {
    const index = pointerIndex(e);
    setHover(index);
    if (!drag.current) return;
    const { mode, anchor, initial } = drag.current;
    let first = anchor, last = index;
    if (mode === 'start') { first = index; last = initial[1]; }
    if (mode === 'end') { first = initial[0]; last = index; }
    if (mode === 'move') {
      const delta = Math.max(-initial[0], Math.min(buckets.length - 1 - initial[1], index - anchor));
      first = initial[0] + delta; last = initial[1] + delta;
    }
    setDraft(logSelection(summary, first, last));
    drag.current.interval = logSelection(summary, first, last);
    drag.current.moved ||= index !== anchor;
  }
  const per = (summary?.step ?? 60000) < 3600000 ? `${Math.round((summary?.step ?? 60000) / 60000)} min` : `${Math.round(summary.step / 3600000)} hr`;
  const outcomes = [
    { label: 'Successful', value: totals?.success ?? 0, color: '#38b89a' },
    { label: 'Client errors', value: totals?.clientErrors ?? 0, color: '#e7af55' },
    { label: 'Server errors', value: totals?.serverErrors ?? 0, color: '#ea7171' },
  ];
  let offset = 0;
  return <><div className="logs-chart-grid">
    <Paper withBorder className="logs-surface">
      <div className="logs-panel-heading"><div><h2>Traffic</h2><span className="logs-caption">{periodLabel} · selected services</span></div>
        <div className="logs-chart-actions">{selection && <Button className="text-button small" onClick={onClearSelection}>Clear interval</Button>}
          <Help label="About the traffic chart">Completed requests and TCP/UDP sessions. Amber shows client errors (4xx); red shows server errors (5xx). Hover or tap for counts. Drag to select an interval; drag its handles to resize, or its middle to move it. Only retained events are counted.</Help></div>
      </div>
      <div className="logs-chart-reading"><strong>{selected ? number(selected.requests) : '—'}</strong><span>requests / {per}</span>
        <span className="logs-chart-time">{selected ? time(selected.minute, summary?.step) : 'Waiting for data'}</span></div>
      {interval && <div className="logs-caption logs-selected-interval" aria-live="polite">Selected: {formatDateTime(interval.from)} – {formatDateTime(interval.to)}</div>}
      <svg className="logs-traffic-chart" viewBox="0 0 640 210" role={onSelectionChange ? 'group' : 'img'} aria-label={`Traffic for ${periodLabel}: ${chartTotals?.requests ?? 0} completed requests or sessions, ${chartTotals?.clientErrors ?? 0} client errors, ${chartTotals?.serverErrors ?? 0} server errors.`}
        onPointerDown={(e) => {
          if (!onSelectionChange || !buckets.length || e.button !== 0) return;
          const rect = e.currentTarget.getBoundingClientRect(), px = (e.clientX - rect.left) * 640 / rect.width,
            py = (e.clientY - rect.top) * 210 / rect.height;
          if (px < 38 || px > 622 || py < 20 || py > 180) return;
          e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { mode: e.target.dataset.handle ?? 'new', anchor: pointerIndex(e), initial: indices, moved: false };
        }} onPointerMove={pointerMove}
        onPointerUp={(e) => {
          const current = drag.current;
          if (!current) return;
          pointerMove(e);
          if (current.moved) onSelectionChange(current.interval);
          drag.current = null; setDraft(null); e.currentTarget.releasePointerCapture(e.pointerId);
        }} onPointerCancel={() => { drag.current = null; setDraft(null); }}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#38b89a" stopOpacity=".28" /><stop offset="100%" stopColor="#38b89a" stopOpacity=".015" /></linearGradient></defs>
        {[0, 0.5, 1].map((fraction) => <g key={fraction}><line x1="38" x2="622" y1={y(peak * fraction)} y2={y(peak * fraction)} className="logs-grid-line" /><text x="28" y={y(peak * fraction) + 4} textAnchor="end" className="logs-axis-label">{Math.round(peak * fraction)}</text></g>)}
        {buckets.length > 0 && <>
          <path d={`${line('requests')} L ${x(buckets.length - 1)} 178 L 38 178 Z`} fill={`url(#${id})`} />
          <path d={line('requests')} fill="none" stroke="#38b89a" strokeWidth="2.5" strokeLinejoin="round" />
          <path d={line('clientErrors')} fill="none" stroke="#e7af55" strokeWidth="2" />
          <path d={line('serverErrors')} fill="none" stroke="#ea7171" strokeWidth="2" />
          {hover !== null && buckets[hover] && <g><line x1={x(hover)} x2={x(hover)} y1="22" y2="178" className="logs-hover-line" /><circle cx={x(hover)} cy={y(buckets[hover].requests)} r="4" fill="#38b89a" /></g>}
          <rect x="38" y="20" width="584" height="160" fill="transparent"><title>Drag to select an interval</title></rect>
          {indices && <>
            <rect x="38" y="20" width={edgeX(indices[0]) - 38} height="160" className="logs-selection-mask" />
            <rect x={edgeX(indices[1] + 1)} y="20" width={622 - edgeX(indices[1] + 1)} height="160" className="logs-selection-mask" />
            <rect x={edgeX(indices[0])} y="20" width={edgeX(indices[1] + 1) - edgeX(indices[0])} height="160" className="logs-selection-area" data-handle="move" />
            {indices.map((index, i) => <rect key={i} x={edgeX(index + i) - 4} y="20" width="8" height="160" className="logs-selection-handle" data-handle={i ? 'end' : 'start'}
              role="slider" tabIndex={0} aria-label={i ? 'Interval end' : 'Interval start'} aria-valuemin={0} aria-valuemax={buckets.length - 1} aria-valuenow={index}
              aria-valuetext={formatDateTime(i ? interval.to : interval.from)} onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
                e.preventDefault();
                const next = [...indices]; next[i] = Math.max(i ? next[0] : 0, Math.min(i ? buckets.length - 1 : next[1], index + (e.key === 'ArrowLeft' ? -1 : 1)));
                onSelectionChange(logSelection(summary, ...next));
              }} />)}
          </>}
          <text x="38" y="203" className="logs-axis-label">{time(buckets[0].minute, summary?.step)}</text>
          <text x="622" y="203" textAnchor="end" className="logs-axis-label">{time(buckets.at(-1).minute, summary?.step)}</text>
        </>}
      </svg>
      <div className="logs-chart-legend"><span><i className="legend-dot success" /> Requests</span><span><i className="legend-dot warning" /> Client errors {selected ? `· ${selected.clientErrors}` : ''}</span><span><i className="legend-dot errors" /> Server errors {selected ? `· ${selected.serverErrors}` : ''}</span></div>
    </Paper>
    <Paper withBorder className="logs-surface logs-response-panel">
      <div className="logs-panel-heading"><div><h2>Responses</h2><span className="logs-caption">{outcomePeriodLabel}</span></div>
        <Help label="About response outcomes">Successful includes redirects. Client errors are 4xx; server errors are 5xx. Rejected TLS handshakes before HTTP and unproxied traffic are not included.</Help>
      </div>
      <div className="logs-donut">
        <svg viewBox="0 0 160 160" role="img" aria-label={outcomes.map((o) => `${o.label}: ${o.value}`).join(', ')}>
          <circle cx="80" cy="80" r="58" fill="none" stroke="var(--line)" strokeWidth="15" />
          {outcomes.map((outcome) => {
            const fraction = totals?.requests ? outcome.value / totals.requests : 0, start = offset;
            offset += fraction * 100;
            return <circle key={outcome.label} cx="80" cy="80" r="58" pathLength="100" fill="none" stroke={outcome.color} strokeWidth="15" strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`} strokeDashoffset={-start} transform="rotate(-90 80 80)"><title>{outcome.label}: {number(outcome.value)}</title></circle>;
          })}
        </svg>
        <div className="logs-donut-label"><strong>{totals ? number(totals.requests) : '—'}</strong><span>responses</span></div>
      </div>
      <div className="logs-outcomes">{outcomes.map((o, i) => <div key={o.label}><span><i className={`legend-dot ${['success', 'warning', 'errors'][i]}`} />{o.label}</span><strong>{totals ? number(o.value) : '—'}</strong></div>)}</div>
    </Paper>
  </div><div className="logs-service-pies" aria-label="Response types by service">
    <ServicePie title="Successful · by service" field="success" breakdown={outcomeSummary?.serviceBreakdown} names={serviceNames} />
    <ServicePie title="Client errors · by service" field="clientErrors" breakdown={outcomeSummary?.serviceBreakdown} names={serviceNames} />
    <ServicePie title="Server errors · by service" field="serverErrors" breakdown={outcomeSummary?.serviceBreakdown} names={serviceNames} />
  </div></>;
}
