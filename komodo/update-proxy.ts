// Komodo owns environment/scheduling; the fixed host updater owns safe handover.
async function completed(update: any) {
  const id = update._id?.$oid ?? update.id;
  if (!id) throw new Error("Missing Komodo update ID");
  while (update.status === "InProgress") {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    update = await komodo.read("GetUpdate", { id });
  }
  if (!update.success) throw new Error("Komodo operation failed; see its execution log");
}

async function host(operation: "status" | "update") {
  let exitCode = "missing", paused = false;
  await komodo.execute_server_terminal({
    server: "K0stkaVPS", terminal: "proxy-update",
    command: "/usr/local/lib/proxy-maintenance.py " + operation,
    init: { command: "bash" },
  }, {
    onLine: (line) => {
      console.log(line);
      if (line.trim() === "PROXY_PAUSED=1") paused = true;
    },
    onFinish: (code) => { exitCode = String(code).trim(); },
  });
  if (exitCode !== "0") throw new Error("Proxy " + operation + " failed: " + exitCode);
  if (paused) throw new Error("Proxy stopped by operator; start it before updating");
}

await host("status");
// Writes Komodo's environment without recreating traffic services.
await completed(await komodo.execute("DeployStack", { stack: "proxy" }));
await host("update");
// A signed automatic inventory refresh may already be running after the handover.
let refresh: any;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    refresh = await komodo.execute("RunAction", { action: "Refresh Proxy Stack" });
    break;
  } catch (error) {
    if (attempt === 19) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
await completed(refresh);
