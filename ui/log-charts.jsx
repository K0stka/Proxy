import React, { useId, useState } from 'react';
import { Paper } from '@mantine/core';
import Help from './help.jsx';

import { formatDateTime } from './date-time.js';
const time = (minute) => formatDateTime(minute * 60000);
const number = (value) => value.toLocaleString();
export default function LogCharts({ summary, periodLabel = 'Last hour' }) {
  const id = useId(), [hover, setHover] = useState(null);
  const buckets = summary?.buckets ?? [], totals = summary?.totals;
  const peak = Math.max(1, ...buckets.map((b) => b.requests));
  const x = (i) => 38 + i * 584 / Math.max(1, buckets.length - 1);
  const y = (value) => 178 - value / peak * 150;
  const line = (key) => buckets.map((b, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(b[key])}`).join(' ');
  const selected = buckets[hover ?? buckets.length - 1];
  const per = (summary?.step ?? 60000) < 3600000 ? `${Math.round((summary?.step ?? 60000) / 60000)} min` : `${Math.round(summary.step / 3600000)} hr`;
  const outcomes = [
    { label: 'Successful', value: totals?.success ?? 0, color: '#38b89a' },
    { label: 'Client errors', value: totals?.clientErrors ?? 0, color: '#e7af55' },
    { label: 'Server errors', value: totals?.serverErrors ?? 0, color: '#ea7171' },
  ];
  let offset = 0;
  return <div className="logs-chart-grid">
    <Paper withBorder className="logs-surface">
      <div className="logs-panel-heading"><div><h2>Traffic</h2><span className="logs-caption">{periodLabel} · selected services</span></div>
        <Help label="About the traffic chart">Completed requests and TCP/UDP sessions. Amber shows client errors (4xx); red shows server errors (5xx). Hover or tap a bucket for counts. Only retained events are counted.</Help>
      </div>
      <div className="logs-chart-reading"><strong>{selected ? number(selected.requests) : '—'}</strong><span>requests / {per}</span>
        <span className="logs-chart-time">{selected ? time(selected.minute, summary?.step) : 'Waiting for data'}</span></div>
      <svg className="logs-traffic-chart" viewBox="0 0 640 210" role="img" aria-label={`Traffic for ${periodLabel}: ${totals?.requests ?? 0} completed requests or sessions, ${totals?.clientErrors ?? 0} client errors, ${totals?.serverErrors ?? 0} server errors.`}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#38b89a" stopOpacity=".28" /><stop offset="100%" stopColor="#38b89a" stopOpacity=".015" /></linearGradient></defs>
        {[0, 0.5, 1].map((fraction) => <g key={fraction}><line x1="38" x2="622" y1={y(peak * fraction)} y2={y(peak * fraction)} className="logs-grid-line" /><text x="28" y={y(peak * fraction) + 4} textAnchor="end" className="logs-axis-label">{Math.round(peak * fraction)}</text></g>)}
        {buckets.length > 0 && <>
          <path d={`${line('requests')} L ${x(buckets.length - 1)} 178 L 38 178 Z`} fill={`url(#${id})`} />
          <path d={line('requests')} fill="none" stroke="#38b89a" strokeWidth="2.5" strokeLinejoin="round" />
          <path d={line('clientErrors')} fill="none" stroke="#e7af55" strokeWidth="2" />
          <path d={line('serverErrors')} fill="none" stroke="#ea7171" strokeWidth="2" />
          {hover !== null && <g><line x1={x(hover)} x2={x(hover)} y1="22" y2="178" className="logs-hover-line" /><circle cx={x(hover)} cy={y(buckets[hover].requests)} r="4" fill="#38b89a" /></g>}
          {buckets.map((b, i) => <rect key={b.minute} x={x(i) - 5} y="20" width="10" height="160" fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}><title>{time(b.minute, summary?.step)}: {b.requests} requests, {b.clientErrors} client errors, {b.serverErrors} server errors</title></rect>)}
          <text x="38" y="203" className="logs-axis-label">{time(buckets[0].minute, summary?.step)}</text>
          <text x="622" y="203" textAnchor="end" className="logs-axis-label">{time(buckets.at(-1).minute, summary?.step)}</text>
        </>}
      </svg>
      <div className="logs-chart-legend"><span><i className="legend-dot success" /> Requests</span><span><i className="legend-dot warning" /> Client errors {selected ? `· ${selected.clientErrors}` : ''}</span><span><i className="legend-dot errors" /> Server errors {selected ? `· ${selected.serverErrors}` : ''}</span></div>
    </Paper>
    <Paper withBorder className="logs-surface logs-response-panel">
      <div className="logs-panel-heading"><div><h2>Responses</h2><span className="logs-caption">{periodLabel}</span></div>
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
  </div>;
}
