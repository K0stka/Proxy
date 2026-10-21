// Read the runtime's source revision before refreshing Komodo's inventory.
let revision = "", exitCode = "missing", paused = false;
let active: string[] = [], draining: string[] = [];
const stackIsBusy = (error: any) => /(?:resource|stack)(?: is)? busy/i.test([
  String(error), error?.message, error?.error, error?.result?.error, error?.response?.data?.error,
].filter(Boolean).join(" "));
await komodo.execute_server_terminal({
  server: "K0stkaVPS", terminal: "proxy-status", command: "/usr/local/lib/proxy-maintenance.py status",
  init: { command: "bash" },
}, {
  onLine: (line) => {
    const match = line.match(/^PROXY_DEPLOYED_REVISION=([0-9a-f]{40})$/);
    if (match) revision = match[1];
    if (line.trim() === "PROXY_PAUSED=1") paused = true;
    if (line.startsWith("PROXY_ACTIVE=")) active = JSON.parse(line.slice("PROXY_ACTIVE=".length));
    if (line.startsWith("PROXY_DRAINING=")) draining = JSON.parse(line.slice("PROXY_DRAINING=".length));
  },
  onFinish: (code) => { exitCode = String(code); },
});
if (exitCode !== "0" || !revision) throw new Error("Cannot establish the deployed proxy revision");
const generation = /^(edge|control)-[0-9a-f]{6}-\d+$/;
if (active.length !== 2 || active.some((name) => !generation.test(name))) {
  throw new Error("Cannot establish active proxy services; health exclusions were not changed");
}
const stack = await komodo.read("GetStack", { stack: "proxy" });
const manualIgnores = stack.config.ignore_services.filter((name) => !generation.test(name));
const previousGenerations = (stack.info.deployed_services ?? [])
  .map((service) => service.service_name)
  .filter((name) => generation.test(name) && !active.includes(name));
const retiredOrDraining = [...new Set([...previousGenerations, ...draining])];
await komodo.write("UpdateStack", { id: "proxy", config: {
  ignore_services: [...manualIgnores, ...retiredOrDraining],
} });
await komodo.write("RefreshStackCache", { stack: "proxy" });
if (paused) {
  console.log("Proxy stopped by operator; retaining stopped services.");
  return;
}
// Compose up is restricted to existing files/certificates services with no recreation.
// The root-owned manifest also lists every actual active/draining edge/controller.
for (let attempt = 0; ; attempt++) {
  let deployment: any;
  try {
    deployment = await komodo.execute("DeployStack", { stack: "proxy" });
    const deploymentId = deployment._id?.$oid ?? deployment.id;
    if (!deploymentId) throw new Error("Missing Komodo deployment update ID");
    while (deployment.status === "InProgress") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      deployment = await komodo.read("GetUpdate", { id: deploymentId });
    }
    if (!deployment.success) {
      const busy = deployment.logs?.some((log: any) => log.stderr?.includes("Resource is busy"));
      throw new Error(busy ? "Resource is busy" : "Komodo stack inventory deployment failed");
    }
    break;
  } catch (error) {
    if (attempt >= 19 || !stackIsBusy(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
await komodo.write("UpdateStack", { id: "proxy", config: {
  ignore_services: [...manualIgnores, ...draining],
} });
console.log("Proxy inventory refreshed; runtime source revision " + revision);
console.log("Active:", active.join(", "), "Draining:", draining.join(", ") || "none");
