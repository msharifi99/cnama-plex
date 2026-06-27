import { spawn } from "node:child_process";

const commands = [
  { name: "server", command: "npm", args: ["run", "dev:server"] },
  { name: "client", command: "npm", args: ["run", "dev:client"] }
];

const childEnv = {
  ...process.env,
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  TEMP: process.platform === "win32" ? process.env.TEMP : "/tmp",
  TMP: process.platform === "win32" ? process.env.TMP : "/tmp"
};

const children = commands.map(({ name, command, args }) => {
  const child = spawn(command, args, {
    env: childEnv,
    shell: process.platform === "win32",
    stdio: ["inherit", "pipe", "pipe"]
  });

  child.stdout.on("data", (data) => process.stdout.write(prefix(name, data)));
  child.stderr.on("data", (data) => process.stderr.write(prefix(name, data)));
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(`[${name}] exited ${signal ?? code}`);
    shutdown(code ?? 1);
  });

  return child;
});

let shuttingDown = false;

console.log("Dev server API: http://localhost:8010");
console.log("Dev app:        http://localhost:5173");

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function shutdown(code) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(code);
}

function prefix(name, data) {
  return String(data)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => `[${name}] ${line}\n`)
    .join("");
}
