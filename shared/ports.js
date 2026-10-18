export function parsePorts(value) {
  const ranges = value.split(',').map((part) => {
    const match = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!match) throw new Error('Use ports and ranges, for example 12, 34, 56-78');
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end > 65535 || end < start)
      throw new Error('Ports must be 1–65535 and ranges must be ascending');
    return { start, end };
  }).sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index && range.start <= ranges[index - 1].end))
    throw new Error('Ports and ranges must not overlap');
  return ranges;
}
export const portRanges = (route) => route.ports
  ? parsePorts(route.ports)
  : [{ start: route.portStart, end: route.portEnd }];
export const formatPorts = (ranges) => ranges.map(({ start, end }) => start === end ? String(start) : `${start}-${end}`).join(', ');
export const samePorts = (route) => route.kind === 'udp' || (route.kind === 'tcp' && /[,-]/.test(route.ports ?? ''));
