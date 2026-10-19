// Fixed host updater performs isolated tests, backup, handoff and health rollback.
let exitCode = "missing";
await komodo.execute_server_terminal({
  server: "K0stkaVPS", terminal: "proxy-update", command: "/usr/local/lib/proxy-maintenance.py update",
  init: { command: "bash" },
}, {
  onLine: (line) => console.log(line),
  onFinish: (code) => { exitCode = String(code); },
});
if (exitCode !== "0") throw new Error("Proxy update failed: " + exitCode);
let refresh = await komodo.execute("RunAction", { action: "Refresh Proxy Stack" });
const refreshId = (refresh as any)._id?.$oid ?? (refresh as any).id;
if (!refreshId) throw new Error("Missing Komodo refresh update ID");
while (refresh.status === "InProgress") {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  refresh = await komodo.read("GetUpdate", { id: refreshId });
}
if (!refresh.success) throw new Error("Proxy updated, but Komodo inventory refresh failed");
