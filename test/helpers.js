const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

async function mkTempDir(prefix = "script-runner-test-") {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeExecutableScript(filePath, body) {
  await fs.promises.writeFile(filePath, body, "utf8");
  await fs.promises.chmod(filePath, 0o755);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) {
      return value;
    }
    await wait(intervalMs);
  }
  throw new Error("waitFor timeout");
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        if (!port) {
          reject(new Error("failed to resolve free port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

module.exports = {
  mkTempDir,
  writeExecutableScript,
  wait,
  waitFor,
  getFreePort,
};
