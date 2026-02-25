const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { ScriptRunner, STATUS } = require("../src/runner");
const { loadConfig } = require("../src/config");
const { mkTempDir, waitFor, writeExecutableScript } = require("./helpers");

async function createBaseFixture(t) {
  const dir = await mkTempDir();
  t.after(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  const scriptPath = path.join(dir, "ok.sh");
  const slowPath = path.join(dir, "slow.sh");
  await writeExecutableScript(
    scriptPath,
    "#!/usr/bin/env bash\nset -euo pipefail\necho \"ok:$*\"\n"
  );
  await writeExecutableScript(
    slowPath,
    "#!/usr/bin/env bash\nset -euo pipefail\nsleep 3\necho done\n"
  );
  return { dir, scriptPath, slowPath };
}

function makeRunnerConfig({ scriptPath, slowPath, jobStoreFile, timeoutSec = 0 }) {
  return {
    runner: {
      maxConcurrent: 2,
      defaultMode: "sync",
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
      jobStoreFile,
    },
    scripts: [
      {
        id: "ok",
        path: scriptPath,
        mode: "sync",
        timeoutSec,
        args: {
          maxItems: 5,
          itemPattern: "^[a-zA-Z0-9._-]+$",
          itemMaxLength: 20,
        },
      },
      {
        id: "slow",
        path: slowPath,
        mode: "async",
        timeoutSec,
        args: {
          maxItems: 2,
          itemPattern: "^[a-zA-Z0-9._-]+$",
          itemMaxLength: 10,
        },
      },
    ],
  };
}

test("runner: sync run succeeds", async (t) => {
  const { dir, scriptPath, slowPath } = await createBaseFixture(t);
  const runner = new ScriptRunner(
    makeRunnerConfig({
      scriptPath,
      slowPath,
      jobStoreFile: path.join(dir, "jobs.json"),
    })
  );

  const result = await runner.submitRun({
    scriptId: "ok",
    args: ["hello", "world"],
    mode: "sync",
  });
  assert.equal(result.ok, true);
  assert.equal(result.async, false);
  assert.equal(result.job.status, STATUS.SUCCEEDED);
  assert.equal(result.job.code, 0);
  assert.match(result.job.stdout, /ok:hello world/);
});

test("runner: invalid args are rejected", async (t) => {
  const { dir, scriptPath, slowPath } = await createBaseFixture(t);
  const runner = new ScriptRunner(
    makeRunnerConfig({
      scriptPath,
      slowPath,
      jobStoreFile: path.join(dir, "jobs.json"),
    })
  );

  const result = await runner.submitRun({
    scriptId: "ok",
    args: ["bad/slash"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_ARGS");
});

test("runner: timeout marks job as timed_out", async (t) => {
  const { dir, scriptPath, slowPath } = await createBaseFixture(t);
  const runner = new ScriptRunner(
    makeRunnerConfig({
      scriptPath,
      slowPath,
      timeoutSec: 1,
      jobStoreFile: path.join(dir, "jobs.json"),
    })
  );

  const result = await runner.submitRun({
    scriptId: "slow",
    args: [],
    mode: "sync",
  });
  assert.equal(result.ok, true);
  assert.equal(result.job.status, STATUS.TIMED_OUT);
});

test("runner: async run can be canceled", async (t) => {
  const { dir, scriptPath, slowPath } = await createBaseFixture(t);
  const runner = new ScriptRunner(
    makeRunnerConfig({
      scriptPath,
      slowPath,
      jobStoreFile: path.join(dir, "jobs.json"),
    })
  );

  const submit = await runner.submitRun({
    scriptId: "slow",
    args: [],
    mode: "async",
  });
  assert.equal(submit.ok, true);
  assert.equal(submit.async, true);

  const cancel = runner.cancelJob(submit.job.jobId);
  assert.equal(cancel.ok, true);

  const done = await waitFor(() => {
    const job = runner.getJob(submit.job.jobId);
    if (!job) {
      return null;
    }
    return job.status === STATUS.CANCELED ? job : null;
  });
  assert.equal(done.status, STATUS.CANCELED);
});

test("config: supports scriptsFile split config", async (t) => {
  const dir = await mkTempDir();
  t.after(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const scriptsFile = path.join(dir, "scripts.json");
  const configFile = path.join(dir, "config.json");
  const scriptPath = path.join(dir, "echo.sh");
  await writeExecutableScript(scriptPath, "#!/usr/bin/env bash\necho ok\n");

  await fs.promises.writeFile(
    scriptsFile,
    JSON.stringify(
      {
        scripts: [
          {
            id: "echo",
            path: "./echo.sh",
            mode: "sync",
            timeoutSec: 0,
            args: {
              maxItems: 1,
              itemPattern: "^[a-z]+$",
              itemMaxLength: 10,
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
        server: { host: "127.0.0.1", port: 18080 },
        runner: {
          maxConcurrent: 1,
          defaultMode: "sync",
          stdoutMaxBytes: 128,
          stderrMaxBytes: 128,
          jobStoreFile: "./jobs.json",
        },
        scriptsFile: "./scripts.json",
      },
      null,
      2
    )
  );

  const loaded = loadConfig(configFile);
  assert.equal(loaded.scripts.length, 1);
  assert.equal(loaded.scripts[0].id, "echo");
  assert.equal(loaded.scripts[0].path, scriptPath);
});
