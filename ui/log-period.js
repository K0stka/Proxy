export const logPeriods = [['hour', 'Last hour'], ['day', 'Last day'], ['week', 'Last week'], ['month', 'Last month'], ['today', 'Today']];
export function logPeriod(period, now = new Date()) {
  const to = new Date(now), from = new Date(to);
  if (period === 'today') from.setHours(0, 0, 0, 0);
  else from.setTime(to.getTime() - ({ hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 }[period] ?? 3600000));
  return { from: from.toISOString(), to: new Date(Math.max(to.getTime(), from.getTime() + 1)).toISOString() };
}

export function logSelection(summary, first, last) {
  const max = summary.buckets.length - 1;
  if (max < 0) return null;
  const start = Math.max(0, Math.min(max, Math.min(first, last)));
  const end = Math.max(0, Math.min(max, Math.max(first, last)));
  return {
    from: new Date(Date.parse(summary.from) + start * summary.step).toISOString(),
    to: new Date(Math.min(Date.parse(summary.to), Date.parse(summary.from) + (end + 1) * summary.step)).toISOString(),
  };
}

export function logSelectionIndices(summary, interval) {
  if (!interval || !summary?.buckets.length) return null;
  const start = Date.parse(summary.from), max = summary.buckets.length - 1;
  return [Math.max(0, Math.min(max, Math.floor((Date.parse(interval.from) - start) / summary.step))),
    Math.max(0, Math.min(max, Math.ceil((Date.parse(interval.to) - start) / summary.step) - 1))];
}
