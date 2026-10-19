// Compose keeps these unprivileged status agents; root's host service owns handoffs.
console.info('Proxy handoff mode: application generations are managed by proxy-handoff.service');
setInterval(() => {}, 60000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
