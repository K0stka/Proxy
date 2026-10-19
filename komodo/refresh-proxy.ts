// Read the runtime's source revision before refreshing Komodo's inventory.
let revision = "", exitCode = "missing", paused = false;
await komodo.execute_server_terminal({
  server: "K0stkaVPS", terminal: "proxy-status", command: "/usr/local/lib/proxy-maintenance.py status",
  init: { command: "bash" },
}, {
  onLine: (line) => {
    const match = line.match(/^PROXY_DEPLOYED_REVISION=([0-9a-f]{40})$/);
    if (match) revision = match[1];
    if (line.trim() === "PROXY_PAUSED=1") paused = true;
  },
  onFinish: (code) => { exitCode = String(code); },
});
if (exitCode !== "0" || !revision) throw new Error("Cannot establish the deployed proxy revision");
await komodo.write("RefreshStackCache", { stack: "proxy" });
if (paused) {
  console.log("Proxy stopped by operator; retaining stopped services.");
  return;
}
// Compose up is restricted to existing files/certificates services with no recreation.
// The root-owned manifest also lists every actual active/draining edge/controller.
let deployment = await komodo.execute("DeployStack", { stack: "proxy" });
const deploymentId = (deployment as any)._id?.$oid ?? (deployment as any).id;
if (!deploymentId) throw new Error("Missing Komodo deployment update ID");
while (deployment.status === "InProgress") {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  deployment = await komodo.read("GetUpdate", { id: deploymentId });
}
if (!deployment.success) throw new Error("Komodo stack inventory deployment failed");
console.log("Proxy inventory refreshed; runtime source revision " + revision);
