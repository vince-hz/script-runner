const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const test = require("node:test");
const { getFreePort, mkTempDir, waitFor, writeExecutableScript } = require("./helpers");

function killGroupOrProcess(child) {
  if (!child || typeof child.pid !== "number") {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
    return;
  } catch (_) {
    // Fallback to direct pid when process group kill is unavailable.
  }
  try {
    child.kill("SIGTERM");
  } catch (_) {
    // Already exited.
  }
}

test("server: run sync and async jobs over HTTP", async (t) => {
  const dir = await mkTempDir();
  t.after(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const port = await getFreePort();
  const quickPath = path.join(dir, "quick.sh");
  const slowPath = path.join(dir, "slow.sh");
  await writeExecutableScript(
    quickPath,
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"sync:$*\"\n"
  );
  await writeExecutableScript(
    slowPath,
    "#!/usr/bin/env bash\nset -euo pipefail\nsleep 1\necho async-done\n"
  );

  const scriptsFile = path.join(dir, "scripts.json");
  const configFile = path.join(dir, "config.json");
  const jobsFile = path.join(dir, "jobs.json");

  await fs.promises.writeFile(
    scriptsFile,
    JSON.stringify(
      {
        scripts: [
          {
            id: "quick",
            path: "./quick.sh",
            mode: "sync",
            timeoutSec: 10,
            args: {
              maxItems: 2,
              itemPattern: "^[a-zA-Z0-9._-]+$",
              itemMaxLength: 20,
            },
          },
          {
            id: "slow",
            path: "./slow.sh",
            mode: "async",
            timeoutSec: 10,
            args: {
              maxItems: 1,
              itemPattern: "^[a-zA-Z0-9._-]+$",
              itemMaxLength: 20,
            },
          },
        ],
      },
      null,
      2
    )
  );

  await fs.promises.writeFile(
    configFile,
    JSON.stringify(
      {
        server: { host: "127.0.0.1", port },
        runner: {
          maxConcurrent: 2,
          defaultMode: "sync",
          maxLogBytesPerStream: 1024,
          previewMaxBytes: 512,
          jobStoreFile: jobsFile,
          logsDir: path.join(dir, "logs"),
        },
        scriptsFile,
      },
      null,
      2
    )
  );

  const serverProcess = spawn("node", ["src/server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, CONFIG_FILE: configFile },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  t.after(() => {
    killGroupOrProcess(serverProcess);
  });

  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      return res.status === 200;
    } catch (_) {
      return false;
    }
  });

  const syncRes = await fetch(`http://127.0.0.1:${port}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scriptId: "quick", args: ["a", "b"], mode: "sync" }),
  });
  assert.equal(syncRes.status, 200);
  const syncJson = await syncRes.json();
  assert.equal(syncJson.status, "succeeded");
  assert.match(syncJson.stdoutPreview, /sync:a b/);

  const asyncRes = await fetch(`http://127.0.0.1:${port}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scriptId: "slow", args: [], mode: "async" }),
  });
  assert.equal(asyncRes.status, 202);
  const asyncJson = await asyncRes.json();
  assert.equal(typeof asyncJson.jobId, "string");

  const finalJob = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/jobs/${asyncJson.jobId}`);
    if (res.status !== 200) {
      return null;
    }
    const json = await res.json();
    if (json.status === "succeeded") {
      return json;
    }
    return null;
  }, { timeoutMs: 8000, intervalMs: 100 });

  assert.equal(finalJob.status, "succeeded");
  assert.match(finalJob.stdoutPreview, /async-done/);

  const logsRes = await fetch(
    `http://127.0.0.1:${port}/jobs/${asyncJson.jobId}/logs?stream=stdout&offset=0&limit=2048`
  );
  assert.equal(logsRes.status, 200);
  const logsJson = await logsRes.json();
  assert.match(logsJson.data, /async-done/);
});
