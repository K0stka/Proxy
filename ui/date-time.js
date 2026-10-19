export function formatDateTime(value, now = new Date()) {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
  const relative = { 0: 'Today', '-1': 'Yesterday', 1: 'Tomorrow' }[day(date) - day(now)];
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return relative ? `${relative}, ${time}` : `${pad(date.getDate())}. ${pad(date.getMonth() + 1)}. ${time}`;
}
