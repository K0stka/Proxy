import React, { useEffect, useRef, useState } from 'react';
import { Group, Stack, PasswordInput, Switch, Text } from '@mantine/core';
import { Button } from './controls.jsx';
import { api } from './api.js';
import Help from './help.jsx';
import { formatDateTime } from './date-time.js';
import { useToast } from './toasts.jsx';

export default function DiscordAlerts() {
  const report = useToast(), lastLoadError = useRef('');
  const [status, setStatus] = useState(null), [enabled, setEnabled] = useState(false),
    [url, setURL] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    async function load(initial = false) {
      try {
        const next = await api('/notifications/discord');
        if (active) { setStatus(next); if (initial) setEnabled(next.enabled); }
        lastLoadError.current = '';
      } catch (e) {
        if (active && lastLoadError.current !== e.message) report(e.message, true);
        lastLoadError.current = e.message;
      }
    }
    load(true);
    const timer = setInterval(load, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [report]);
  useEffect(() => { if (status?.error) report(status.error, true); }, [status?.error, report]);
  async function action(operation) {
    setBusy(true);
    try {
      const next = await api(`/notifications/discord${operation === 'test' ? '/test' : ''}`, {
        method: operation === 'save' ? 'PUT' : 'POST',
        ...(operation === 'save' ? { body: { enabled, ...(url.trim() ? { webhookURL: url.trim() } : {}) } } : {}),
      });
      setStatus(next); setEnabled(next.enabled); setURL('');
      report(next.message ?? 'Discord alert settings saved.');
    } catch (e) { report(e.message, true); } finally { setBusy(false); }
  }
  return <form onSubmit={(e) => { e.preventDefault(); action('save'); }}>
    <Stack gap="lg">
      <Group justify="space-between"><h2>Discord alerts</h2><Help label="About Discord notifications">New alerts share the service name, reason, status and source IP with Discord. Repeated service/reason pairs are grouped for 15 minutes; delivery is limited to one message every 10 seconds. Save a real webhook URL to send notifications.</Help></Group>
      <Switch label="Enable Discord alerts" checked={enabled} disabled={!status || busy} onChange={(e) => setEnabled(e.currentTarget.checked)} />
      <PasswordInput label={status?.configured ? 'Replace webhook URL' : 'Webhook URL'}
        description={status?.configured ? 'Saved · leave blank to keep' : 'Discord channel → Integrations → Webhooks → Copy URL'}
        placeholder="https://discord.com/api/webhooks/…" value={url} autoComplete="off" maxLength={512}
        onChange={(e) => setURL(e.currentTarget.value)} />
      <Text size="sm" c="dimmed">{status?.lastSuccess ? `Last delivered: ${formatDateTime(status.lastSuccess)}` : 'No notifications delivered yet.'}</Text>
      <Group justify="flex-end">
        <Button className="secondary" disabled={busy || !status?.configured} onClick={() => action('test')}>Send test notification</Button>
        <Button className="primary" type="submit" disabled={busy || !status}>Save changes</Button>
      </Group>
    </Stack>
  </form>;
}
