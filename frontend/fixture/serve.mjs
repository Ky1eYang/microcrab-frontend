// Keep the opt-in designer command portable across Windows and POSIX shells.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = process.env.FIXTURE_PORT || "18130";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("FIXTURE_PORT must be an integer from 1 to 65535");
}
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const child = spawn(
  process.execPath,
  [vite, "--host", "127.0.0.1", "--strictPort", "--port", port, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
