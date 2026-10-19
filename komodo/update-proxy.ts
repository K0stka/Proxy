// Fixed host updater performs isolated tests, backup, handoff and health rollback.
let exitCode = "missing";
await komodo.execute_server_terminal({
  server: "K0stkaVPS", command: "/usr/local/lib/proxy-maintenance.py update",
  init: { command: "bash" },
}, {
  onLine: (line) => console.log(line),
  onFinish: (code) => { exitCode = String(code); },
});
if (exitCode !== "0") throw new Error("Proxy update failed: " + exitCode);
const refresh = await komodo.execute("RunAction", { action: "Refresh Proxy Stack" });
if (!refresh.success) throw new Error("Proxy updated, but Komodo inventory refresh failed");
