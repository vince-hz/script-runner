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

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'"'"'`)}'`;
}

function appendTailBuffer(current, chunk, maxBytes) {
  if (maxBytes <= 0) {
    return Buffer.alloc(0);
  }
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= maxBytes) {
    return combined;
  }
  return combined.slice(combined.length - maxBytes);
}

function terminateChildProcess(child) {
  if (!child || typeof child.pid !== "number") {
    return;
  }
  try {
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
    this.defaultMode = config.runner.defaultMode;
    this.jobStoreFile = config.runner.jobStoreFile;
    this.logsDir = config.runner.logsDir || path.join(path.dirname(this.jobStoreFile), "logs");
    this.maxLogBytesPerStream = config.runner.maxLogBytesPerStream || 1024 * 1024;
    this.previewMaxBytes = config.runner.previewMaxBytes || 4096;
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
          job.endedAt = nowIso();
          if (job.startedAt) {
            job.durationMs = Math.max(0, Date.now() - Date.parse(job.startedAt));
          }
        }
        this.jobs.set(job.jobId, {
          ...job,
          cancelRequested: false,
        });
      }
    } catch (error) {
      console.error("[runner] failed to load jobs:", error.message);
    }
  }

  serializeJobForStore(job) {
    return {
      jobId: job.jobId,
      scriptId: job.scriptId,
      status: job.status,
      code: job.code,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      durationMs: job.durationMs,
      createdAt: job.createdAt,
      mode: job.mode,
      stdoutRef: job.stdoutRef,
      stderrRef: job.stderrRef,
      stdoutSize: job.stdoutSize,
      stderrSize: job.stderrSize,
      stdoutTruncated: !!job.stdoutTruncated,
      stderrTruncated: !!job.stderrTruncated,
      stdoutPreview: job.stdoutPreview || "",
      stderrPreview: job.stderrPreview || "",
    };
  }

  persistJobs() {
    try {
      ensureParentDir(this.jobStoreFile);
      const data = JSON.stringify(
        Array.from(this.jobs.values(), (job) => this.serializeJobForStore(job)),
        null,
        2
      );
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
    const jobId = this.nextJobId();
    const job = {
      jobId,
      scriptId,
      mode,
      args,
      status: STATUS.QUEUED,
      code: null,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      createdAt: nowIso(),
      cancelRequested: false,
      stdoutRef: `${jobId}.stdout.log`,
      stderrRef: `${jobId}.stderr.log`,
      stdoutSize: 0,
      stderrSize: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutPreview: "",
      stderrPreview: "",
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
        job.code = -1;
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
    const stdoutPath = path.join(this.logsDir, job.stdoutRef);
    const stderrPath = path.join(this.logsDir, job.stderrRef);

    ensureParentDir(stdoutPath);
    ensureParentDir(stderrPath);

    let stdoutFd = null;
    let stderrFd = null;
    try {
      stdoutFd = fs.openSync(stdoutPath, "w");
      stderrFd = fs.openSync(stderrPath, "w");
    } catch (error) {
      job.status = STATUS.FAILED;
      job.code = -1;
      job.endedAt = nowIso();
      job.durationMs = Date.now() - startedMs;
      job.stderrPreview = `failed to open log files: ${error.message}`;
      this.runningCount -= 1;
      this.persistJobs();
      this.drainQueue();
      if (job._resolvePromise) {
        job._resolvePromise(job);
      }
      return;
    }

    const child = spawn(command, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: true,
      env: process.env,
    });
    job._pid = child.pid;

    let stdoutPreviewBuf = Buffer.alloc(0);
    let stderrPreviewBuf = Buffer.alloc(0);
    let timeoutHandle = null;
    let timedOut = false;
    let finished = false;

    const closeLogFds = () => {
      if (stdoutFd != null) {
        try {
          fs.closeSync(stdoutFd);
        } catch (_) {}
        stdoutFd = null;
      }
      if (stderrFd != null) {
        try {
          fs.closeSync(stderrFd);
        } catch (_) {}
        stderrFd = null;
      }
    };

    const writeLogChunk = (fd, chunk, sizeKey, truncatedKey) => {
      const current = job[sizeKey];
      if (current >= this.maxLogBytesPerStream) {
        job[truncatedKey] = true;
        return;
      }
      const allowed = this.maxLogBytesPerStream - current;
      const toWrite = chunk.slice(0, allowed);
      if (toWrite.length > 0) {
        fs.writeSync(fd, toWrite);
        job[sizeKey] += toWrite.length;
      }
      if (toWrite.length < chunk.length) {
        job[truncatedKey] = true;
      }
    };

    const finishJob = (status, code) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      closeLogFds();
      job.stdoutPreview = stdoutPreviewBuf.toString("utf8");
      job.stderrPreview = stderrPreviewBuf.toString("utf8");
      job.status = status;
      job.code = code;
      job.endedAt = nowIso();
      job.durationMs = Date.now() - startedMs;

      this.runningCount -= 1;
      this.persistJobs();
      this.drainQueue();
      if (job._resolvePromise) {
        job._resolvePromise(job);
      }
    };

    if (script.timeoutSec > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        terminateChildProcess(child);
      }, script.timeoutSec * 1000);
    }

    child.stdout.on("data", (chunk) => {
      const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutPreviewBuf = appendTailBuffer(stdoutPreviewBuf, asBuffer, this.previewMaxBytes);
      try {
        writeLogChunk(stdoutFd, asBuffer, "stdoutSize", "stdoutTruncated");
      } catch (error) {
        stderrPreviewBuf = appendTailBuffer(
          stderrPreviewBuf,
          Buffer.from(`\nstdout log write error: ${error.message}`),
          this.previewMaxBytes
        );
      }
    });

    child.stderr.on("data", (chunk) => {
      const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrPreviewBuf = appendTailBuffer(stderrPreviewBuf, asBuffer, this.previewMaxBytes);
      try {
        writeLogChunk(stderrFd, asBuffer, "stderrSize", "stderrTruncated");
      } catch (error) {
        stderrPreviewBuf = appendTailBuffer(
          stderrPreviewBuf,
          Buffer.from(`\nstderr log write error: ${error.message}`),
          this.previewMaxBytes
        );
      }
    });

    child.on("error", (error) => {
      stderrPreviewBuf = appendTailBuffer(
        stderrPreviewBuf,
        Buffer.from(`\n${error.message}`),
        this.previewMaxBytes
      );
      finishJob(STATUS.FAILED, -1);
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finishJob(STATUS.TIMED_OUT, -1);
        return;
      }
      if (job.cancelRequested) {
        finishJob(STATUS.CANCELED, -1);
        return;
      }
      if (signal) {
        finishJob(STATUS.FAILED, -1);
        return;
      }
      if (code === 0) {
        finishJob(STATUS.SUCCEEDED, 0);
        return;
      }
      finishJob(STATUS.FAILED, code == null ? -1 : code);
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
  }

  serializeJob(job) {
    return {
      jobId: job.jobId,
      scriptId: job.scriptId,
      status: job.status,
      code: job.code,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      durationMs: job.durationMs,
      createdAt: job.createdAt,
      mode: job.mode,
      stdoutRef: job.stdoutRef,
      stderrRef: job.stderrRef,
      stdoutSize: job.stdoutSize,
      stderrSize: job.stderrSize,
      stdoutTruncated: !!job.stdoutTruncated,
      stderrTruncated: !!job.stderrTruncated,
      stdoutPreview: job.stdoutPreview || "",
      stderrPreview: job.stderrPreview || "",
    };
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    return this.serializeJob(job);
  }

  getJobLogs(jobId, { stream = "stdout", offset = 0, limit = 65536 } = {}) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { ok: false, code: "JOB_NOT_FOUND", message: `job not found: ${jobId}` };
    }
    if (stream !== "stdout" && stream !== "stderr") {
      return { ok: false, code: "INVALID_ARGS", message: "stream must be stdout or stderr" };
    }

    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const safeLimitRaw = Number.isInteger(limit) && limit > 0 ? limit : 65536;
    const safeLimit = Math.min(safeLimitRaw, 1024 * 1024);

    const ref = stream === "stdout" ? job.stdoutRef : job.stderrRef;
    if (!ref) {
      return {
        ok: true,
        jobId,
        stream,
        offset: safeOffset,
        nextOffset: safeOffset,
        totalSize: 0,
        truncated: stream === "stdout" ? !!job.stdoutTruncated : !!job.stderrTruncated,
        data: "",
      };
    }
    const logPath = path.join(this.logsDir, ref);
    if (!fs.existsSync(logPath)) {
      return {
        ok: true,
        jobId,
        stream,
        offset: safeOffset,
        nextOffset: safeOffset,
        totalSize: 0,
        truncated: stream === "stdout" ? !!job.stdoutTruncated : !!job.stderrTruncated,
        data: "",
      };
    }

    const stat = fs.statSync(logPath);
    const totalSize = stat.size;
    if (safeOffset >= totalSize) {
      return {
        ok: true,
        jobId,
        stream,
        offset: safeOffset,
        nextOffset: safeOffset,
        totalSize,
        truncated: stream === "stdout" ? !!job.stdoutTruncated : !!job.stderrTruncated,
        data: "",
      };
    }

    const toRead = Math.min(safeLimit, totalSize - safeOffset);
    const buffer = Buffer.alloc(toRead);
    const fd = fs.openSync(logPath, "r");
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, toRead, safeOffset);
    } finally {
      fs.closeSync(fd);
    }

    return {
      ok: true,
      jobId,
      stream,
      offset: safeOffset,
      nextOffset: safeOffset + bytesRead,
      totalSize,
      truncated: stream === "stdout" ? !!job.stdoutTruncated : !!job.stderrTruncated,
      data: buffer.slice(0, bytesRead).toString("utf8"),
    };
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { ok: false, code: "JOB_NOT_FOUND", message: `job not found: ${jobId}` };
    }
    if (
      job.status === STATUS.SUCCEEDED ||
      job.status === STATUS.FAILED ||
      job.status === STATUS.TIMED_OUT ||
      job.status === STATUS.CANCELED
    ) {
      return { ok: true, job: this.serializeJob(job) };
    }

    job.cancelRequested = true;
    if (job.status === STATUS.RUNNING && job._child) {
      terminateChildProcess(job._child);
    } else if (job.status === STATUS.QUEUED) {
      job.status = STATUS.CANCELED;
      job.code = -1;
      job.endedAt = nowIso();
      job.durationMs = 0;
      this.persistJobs();
    }

    return { ok: true, job: this.serializeJob(job) };
  }
}

module.exports = {
  ScriptRunner,
  STATUS,
};
