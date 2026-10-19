// Deliberately interrupts sessions attached to draining generations only.
let exitCode = "missing";
await komodo.execute_server_terminal({
  server: "K0stkaVPS", command: "/usr/local/lib/proxy-maintenance.py retire-draining",
  init: { command: "bash" },
}, {
  onLine: (line) => console.log(line),
  onFinish: (code) => { exitCode = String(code); },
});
if (exitCode !== "0") throw new Error("Proxy retirement failed: " + exitCode);
console.log("Draining generations retired; active generations were retained.");
