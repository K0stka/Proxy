import React, { useEffect, useRef, useState } from 'react';
import { Group, Stack, PasswordInput, Switch, Text, TextInput } from '@mantine/core';
import { Button } from './controls.jsx';
import { api } from './api.js';
import Help from './help.jsx';
import { formatDateTime } from './date-time.js';
import { useToast } from './toasts.jsx';

export default function DiscordAlerts() {
  const report = useToast(), lastLoadError = useRef('');
  const [status, setStatus] = useState(null), [enabled, setEnabled] = useState(false),
    [token, setToken] = useState(''), [recipientId, setRecipientId] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    async function load(initial = false) {
      try {
        const next = await api('/notifications/discord');
        if (active) { setStatus(next); if (initial) { setEnabled(next.enabled); setRecipientId(next.recipientId); } }
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
        method: operation === 'save' ? 'PUT' : operation === 'remove' ? 'DELETE' : 'POST',
        ...(operation === 'save' ? { body: { enabled, recipientId: recipientId.trim(), ...(token.trim() ? { botToken: token.trim() } : {}) } } : {}),
      });
      setStatus(next); setEnabled(next.enabled); setRecipientId(next.recipientId); setToken('');
      report(next.message ?? 'Discord alert settings saved.');
    } catch (e) { report(e.message, true); } finally { setBusy(false); }
  }
  return <form onSubmit={(e) => { e.preventDefault(); action('save'); }}>
    <Stack gap="lg">
      <Group justify="space-between"><h2>Discord DMs</h2><Help label="About Discord notifications">Alerts share service names, reasons, recorded actions, rule links, severity, times and sample source IPs with Discord. Blocks, detection-only events and security outages remain separate. Repeats are counted together, with at most one automatic DM every five minutes. Summaries prioritize health and management alerts and show up to six groups; full details stay in Logs. Enabling starts with new alerts.</Help></Group>
      <Switch label="Enable Discord DMs" checked={enabled} disabled={!status || busy} onChange={(e) => setEnabled(e.currentTarget.checked)} />
      <PasswordInput label={status?.configured ? 'Replace bot token' : 'Bot token'}
        description={status?.configured ? 'Saved · leave blank to keep' : 'Discord Developer Portal → your application → Bot → Token. Saved webhook URLs must be replaced with a bot token.'}
        value={token} autoComplete="off" maxLength={512} disabled={!status || busy}
        onChange={(e) => setToken(e.currentTarget.value)} />
      <TextInput label="Recipient user ID" description="Discord → Settings → Advanced → Developer Mode, then right-click your profile → Copy User ID. Share a server with the bot and allow direct messages."
        value={recipientId} maxLength={20} disabled={!status || busy} onChange={(e) => setRecipientId(e.currentTarget.value)} />
      <Text size="sm" c="dimmed">No mentions. The first alert is sent on the next poll; subsequent alerts are collected into five-minute summaries.</Text>
      <Text size="sm" c="dimmed">{status?.lastSuccess ? `Last delivered: ${formatDateTime(status.lastSuccess)}` : 'No notifications delivered yet.'}</Text>
      <Group justify="flex-end">
        <Button className="secondary" disabled={busy || !status?.configured} onClick={() => action('remove')}>Remove bot</Button>
        <Button className="secondary" disabled={busy || !status?.configured} onClick={() => action('test')}>Send test DM</Button>
        <Button className="primary" type="submit" disabled={busy || !status}>Save changes</Button>
      </Group>
    </Stack>
  </form>;
}
