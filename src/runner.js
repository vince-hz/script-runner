const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELED: "canceled",
};

function nowIso() {
  return new Date().toISOString();
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function clampBufferAppend(current, chunk, maxBytes) {
  if (maxBytes === 0 || current.length >= maxBytes) {
    return current;
  }
  const rest = maxBytes - current.length;
  return Buffer.concat([current, chunk.slice(0, rest)]);
}

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\"'\"'`)}'`;
}

function terminateChildProcess(child) {
  if (!child || typeof child.pid !== "number") {
    return;
  }
  try {
    // Kill the whole process group so child shell subprocesses are also terminated.
    process.kill(-child.pid, "SIGTERM");
    return;
  } catch (_) {
    // Fall back to killing only the direct child process.
  }
  try {
    child.kill("SIGTERM");
  } catch (_) {
    // Ignore if already exited.
  }
}

class ScriptRunner {
  constructor(config) {
    this.config = config;
    this.scriptMap = new Map(config.scripts.map((s) => [s.id, s]));
    this.maxConcurrent = config.runner.maxConcurrent;
    this.stdoutMaxBytes = config.runner.stdoutMaxBytes;
    this.stderrMaxBytes = config.runner.stderrMaxBytes;
    this.defaultMode = config.runner.defaultMode;
    this.jobStoreFile = config.runner.jobStoreFile;
    this.runningCount = 0;
    this.queue = [];
    this.seq = 0;
    this.jobs = new Map();

    this.loadJobsFromDisk();
  }

  loadJobsFromDisk() {
    try {
      if (!fs.existsSync(this.jobStoreFile)) {
        return;
      }
      const raw = fs.readFileSync(this.jobStoreFile, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const job of parsed) {
        if (!job || typeof job !== "object" || !job.jobId) {
          continue;
        }
        if (job.status === STATUS.RUNNING || job.status === STATUS.QUEUED) {
          job.status = STATUS.FAILED;
          job.code = -1;
          job.stderr = `${job.stderr || ""}\nRecovered after server restart`;
          job.endedAt = nowIso();
          if (job.startedAt) {
            job.durationMs = Math.max(0, Date.now() - Date.parse(job.startedAt));
          }
        }
        this.jobs.set(job.jobId, job);
      }
    } catch (error) {
      console.error("[runner] failed to load jobs:", error.message);
    }
  }

  persistJobs() {
    try {
      ensureParentDir(this.jobStoreFile);
      const data = JSON.stringify(Array.from(this.jobs.values()), null, 2);
      fs.writeFileSync(this.jobStoreFile, data, "utf8");
    } catch (error) {
      console.error("[runner] failed to persist jobs:", error.message);
    }
  }

  nextJobId() {
    this.seq += 1;
    return `job_${Date.now()}_${this.seq}`;
  }

  resolveMode(script, requestedMode) {
    if (requestedMode === "sync" || requestedMode === "async") {
      return requestedMode;
    }
    if (script.mode === "sync" || script.mode === "async") {
      return script.mode;
    }
    return this.defaultMode;
  }

  validateRequest(scriptId, args) {
    const script = this.scriptMap.get(scriptId);
    if (!script) {
      return { ok: false, code: "SCRIPT_NOT_FOUND", message: `script not found: ${scriptId}` };
    }
    if (!Array.isArray(args)) {
      return { ok: false, code: "INVALID_ARGS", message: "args must be an array of strings" };
    }
    if (args.length > script.args.maxItems) {
      return {
        ok: false,
        code: "INVALID_ARGS",
        message: `too many args: max ${script.args.maxItems}`,
      };
    }
    const itemRegex = new RegExp(script.args.itemPattern);
    for (let i = 0; i < args.length; i += 1) {
      const value = args[i];
      if (typeof value !== "string") {
        return { ok: false, code: "INVALID_ARGS", message: `arg[${i}] must be string` };
      }
      if (value.length > script.args.itemMaxLength) {
        return {
          ok: false,
          code: "INVALID_ARGS",
          message: `arg[${i}] too long: max ${script.args.itemMaxLength}`,
        };
      }
      if (!itemRegex.test(value)) {
        return {
          ok: false,
          code: "INVALID_ARGS",
          message: `arg[${i}] does not match pattern`,
        };
      }
    }
    return { ok: true, script };
  }

  createJob(scriptId, args, mode) {
    const job = {
      jobId: this.nextJobId(),
      scriptId,
      mode,
      args,
      status: STATUS.QUEUED,
      code: null,
      stdout: "",
      stderr: "",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      createdAt: nowIso(),
      cancelRequested: false,
    };
    this.jobs.set(job.jobId, job);
    this.persistJobs();
    return job;
  }

  enqueue(job, script) {
    this.queue.push({ job, script });
    this.drainQueue();
  }

  drainQueue() {
    while (this.runningCount < this.maxConcurrent && this.queue.length > 0) {
      const { job, script } = this.queue.shift();
      if (job.cancelRequested) {
        job.status = STATUS.CANCELED;
        job.endedAt = nowIso();
        job.durationMs = 0;
        this.persistJobs();
        continue;
      }
      this.executeJob(job, script);
    }
  }

  executeJob(job, script) {
    this.runningCount += 1;
    job.status = STATUS.RUNNING;
    job.startedAt = nowIso();
    this.persistJobs();

    const startedMs = Date.now();
    const command = [script.path, ...job.args].map(shellQuote).join(" ");
    const child = spawn(command, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: true,
      env: process.env,
    });
    job._pid = child.pid;

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let timeoutHandle = null;
    let timedOut = false;
    let finished = false;

    if (script.timeoutSec > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        terminateChildProcess(child);
      }, script.timeoutSec * 1000);
    }

    child.stdout.on("data", (chunk) => {
      const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBuf = clampBufferAppend(stdoutBuf, asBuffer, this.stdoutMaxBytes);
    });

    child.stderr.on("data", (chunk) => {
      const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBuf = clampBufferAppend(stderrBuf, asBuffer, this.stderrMaxBytes);
    });

    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      job.status = STATUS.FAILED;
      job.code = -1;
      job.stdout = stdoutBuf.toString("utf8");
      job.stderr = `${stderrBuf.toString("utf8")}\n${error.message}`.trim();
      job.endedAt = nowIso();
      job.durationMs = Date.now() - startedMs;
      this.runningCount -= 1;
      this.persistJobs();
      this.drainQueue();
      if (job._resolvePromise) {
        job._resolvePromise(job);
      }
    });

    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      job.stdout = stdoutBuf.toString("utf8");
      job.stderr = stderrBuf.toString("utf8");
      job.endedAt = nowIso();
      job.durationMs = Date.now() - startedMs;

      if (timedOut) {
        job.status = STATUS.TIMED_OUT;
        job.code = -1;
      } else if (job.cancelRequested) {
        job.status = STATUS.CANCELED;
        job.code = -1;
      } else if (signal) {
        job.status = STATUS.FAILED;
        job.code = -1;
      } else if (code === 0) {
        job.status = STATUS.SUCCEEDED;
        job.code = 0;
      } else {
        job.status = STATUS.FAILED;
        job.code = code == null ? -1 : code;
      }

      this.runningCount -= 1;
      this.persistJobs();
      this.drainQueue();
      if (job._resolvePromise) {
        job._resolvePromise(job);
      }
    });

    job._child = child;
  }

  submitRun({ scriptId, args = [], mode }) {
    const validated = this.validateRequest(scriptId, args);
    if (!validated.ok) {
      return { ok: false, code: validated.code, message: validated.message };
    }
    const script = validated.script;
    const resolvedMode = this.resolveMode(script, mode);
    const job = this.createJob(script.id, args, resolvedMode);

    const enqueueAndMaybeWait = () => {
      this.enqueue(job, script);
      if (resolvedMode === "async") {
        return Promise.resolve({
          ok: true,
          async: true,
          job: this.serializeJob(job),
        });
      }
      return new Promise((resolve) => {
        job._resolvePromise = (finalJob) => {
          resolve({
            ok: true,
            async: false,
            job: this.serializeJob(finalJob),
          });
        };
      });
    };

    return enqueueAndMaybeWait();
  }

  serializeJob(job) {
    return {
      jobId: job.jobId,
      scriptId: job.scriptId,
      status: job.status,
      code: job.code,
      stdout: job.stdout,
      stderr: job.stderr,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      durationMs: job.durationMs,
      createdAt: job.createdAt,
      mode: job.mode,
    };
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    return this.serializeJob(job);
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { ok: false, code: "JOB_NOT_FOUND", message: `job not found: ${jobId}` };
    }
    if (job.status === STATUS.SUCCEEDED || job.status === STATUS.FAILED || job.status === STATUS.TIMED_OUT || job.status === STATUS.CANCELED) {
      return { ok: true, job: this.serializeJob(job) };
    }

    job.cancelRequested = true;
    if (job.status === STATUS.RUNNING && job._child) {
      terminateChildProcess(job._child);
    } else if (job.status === STATUS.QUEUED) {
      job.status = STATUS.CANCELED;
      job.code = -1;
      job.startedAt = job.startedAt || null;
      job.endedAt = nowIso();
      job.durationMs = 0;
    }
    this.persistJobs();
    return { ok: true, job: this.serializeJob(job) };
  }
}

module.exports = {
  ScriptRunner,
  STATUS,
};
