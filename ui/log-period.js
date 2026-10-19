export const logPeriods = [['hour', 'Last hour'], ['day', 'Last day'], ['week', 'Last week'], ['month', 'Last month'], ['today', 'Today']];
export function logPeriod(period, now = new Date()) {
  const to = new Date(now), from = new Date(to);
  if (period === 'today') from.setHours(0, 0, 0, 0);
  else from.setTime(to.getTime() - ({ hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 }[period] ?? 3600000));
  return { from: from.toISOString(), to: new Date(Math.max(to.getTime(), from.getTime() + 1)).toISOString() };
}
