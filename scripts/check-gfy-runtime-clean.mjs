#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, [fileURLToPath(new URL("./check-gfy-runtime.mjs", import.meta.url))], {
  cwd: fileURLToPath(new URL("..", import.meta.url)), env: process.env, stdio: ["inherit", "pipe", "pipe"]
});
let crossRequestWarning = false;
let stderrTail = "";
child.stdout.on("data", chunk => process.stdout.write(chunk));
child.stderr.on("data", chunk => {
  const text = stderrTail + chunk.toString("utf8");
  if (text.includes("no_handle_cross_request_promise_resolution")) crossRequestWarning = true;
  stderrTail = text.slice(-512);
  process.stderr.write(chunk);
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("close", (code, signal) => {
  const passed = code === 0 && !signal && !crossRequestWarning;
  console.log(JSON.stringify({ event: "gfy_runtime_transport_verdict", passed, exitCode: code, signal, crossRequestWarning }));
  process.exitCode = passed ? 0 : 1;
});
