const fs = require("fs");
const http = require("http");
const url = require("url");
const path = require("path");
const { loadConfig } = require("./config");
const { ScriptRunner } = require("./runner");

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

function buildResponseFromJob(job) {
  return {
    ok: true,
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

async function main() {
  const configPath = process.env.CONFIG_FILE || path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`config file not found: ${configPath}`);
  }
  const config = loadConfig(configPath);
  const runner = new ScriptRunner(config);

  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url || "", true);
    const method = req.method || "GET";
    const pathname = parsedUrl.pathname || "/";

    try {
      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/run") {
        const body = await readBody(req);
        const scriptId = body.scriptId;
        const args = body.args;
        const mode = body.mode;

        const result = await runner.submitRun({ scriptId, args, mode });
        if (!result.ok) {
          sendJson(res, 400, {
            ok: false,
            error: {
              code: result.code,
              message: result.message,
            },
          });
          return;
        }

        if (result.async) {
          sendJson(res, 202, {
            ok: true,
            jobId: result.job.jobId,
            status: result.job.status,
          });
          return;
        }
        sendJson(res, 200, buildResponseFromJob(result.job));
        return;
      }

      if (method === "GET" && /^\/jobs\/[^/]+$/.test(pathname)) {
        const jobId = pathname.split("/")[2];
        const job = runner.getJob(jobId);
        if (!job) {
          sendJson(res, 404, {
            ok: false,
            error: {
              code: "JOB_NOT_FOUND",
              message: `job not found: ${jobId}`,
            },
          });
          return;
        }
        sendJson(res, 200, buildResponseFromJob(job));
        return;
      }

      if (method === "POST" && /^\/jobs\/[^/]+\/cancel$/.test(pathname)) {
        const jobId = pathname.split("/")[2];
        const result = runner.cancelJob(jobId);
        if (!result.ok) {
          sendJson(res, 404, {
            ok: false,
            error: {
              code: result.code,
              message: result.message,
            },
          });
          return;
        }
        sendJson(res, 200, buildResponseFromJob(result.job));
        return;
      }

      sendJson(res, 404, {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `route not found: ${method} ${pathname}`,
        },
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error.message,
        },
      });
    }
  });

  server.listen(config.server.port, config.server.host, () => {
    console.log(`[script-runner] listening on ${config.server.host}:${config.server.port}`);
  });
}

main().catch((error) => {
  console.error("[script-runner] failed to start:", error.message);
  process.exit(1);
});
