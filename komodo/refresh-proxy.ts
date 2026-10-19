// Only a successful tested revision may become the stack's deployed revision.
let revision = "", exitCode = "missing";
await komodo.execute_server_terminal({
  server: "K0stkaVPS", command: "/usr/local/lib/proxy-maintenance.py status",
  init: { command: "bash" },
}, {
  onLine: (line) => {
    const match = line.match(/^PROXY_DEPLOYED_REVISION=([0-9a-f]{40})$/);
    if (match) revision = match[1];
  },
  onFinish: (code) => { exitCode = String(code); },
});
if (exitCode !== "0" || !revision) throw new Error("Cannot establish the tested proxy revision");
await komodo.write("UpdateStack", { id: "proxy", config: { commit: revision } });
await komodo.write("RefreshStackCache", { stack: "proxy" });
// Compose up is restricted to existing files/certificates services with no recreation.
// The root-owned manifest also lists every actual active/draining edge/controller.
const deployment = await komodo.execute("DeployStack", { stack: "proxy" });
if (!deployment.success) throw new Error("Komodo stack inventory deployment failed");
console.log("Proxy inventory refreshed at tested revision " + revision);
