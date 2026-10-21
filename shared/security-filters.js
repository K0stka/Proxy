export function decisionAction(decision) {
  return decision.banned ? 'IP ban active' : decision.action === 'Blocked' ? 'Request blocked'
    : decision.action === 'Detected' ? 'Detection only' : decision.action === 'Released' ? 'Ban removed' : decision.action || '';
}

export function decisionFilterValue(decision, field, preview) {
  switch (field) {
    case 'source': return decision.ip;
    case 'threat': return `${decision.reason} ${decision.host}`;
    case 'engine': return decision.engine;
    case 'action': return decisionAction(decision);
    case 'requests': return String(decision.requests);
    case 'expires': return preview ? decision.banned ? 'In 3 hours' : '—' : decision.expires || '—';
    default: return '';
  }
}

export function filterDecisions(decisions, filters, preview) {
  return decisions.filter((decision) => Object.entries(filters).every(([field, { op, value }]) => {
    const actual = decisionFilterValue(decision, field, preview);
    if (op === 'in') return value.includes(actual);
    if (op === 'empty') return !actual || actual === '—';
    if (op === 'present') return !!actual && actual !== '—';
    if (op === 'contains') return actual.toLowerCase().includes(value.toLowerCase());
    if (op === 'equals') return actual.toLowerCase() === value.toLowerCase();
    return actual.toLowerCase() !== value.toLowerCase();
  }));
}
