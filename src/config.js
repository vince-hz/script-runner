const fs = require("fs");
const path = require("path");

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function normalizePath(baseDir, maybeRelative) {
  return path.isAbsolute(maybeRelative)
    ? maybeRelative
    : path.resolve(baseDir, maybeRelative);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadConfig(configFilePath) {
  const absoluteConfigPath = path.resolve(configFilePath);
  const configDir = path.dirname(absoluteConfigPath);
  const config = readJsonFile(absoluteConfigPath);

  assert(config && typeof config === "object", "config must be an object");
  assert(config.server && typeof config.server === "object", "missing server config");
  assert(config.runner && typeof config.runner === "object", "missing runner config");

  const server = {
    host: config.server.host || "0.0.0.0",
    port: Number(config.server.port || 8080),
  };

  assert(Number.isInteger(server.port) && server.port > 0 && server.port <= 65535, "invalid server.port");

  const runner = {
    maxConcurrent: Number(config.runner.maxConcurrent || 1),
    defaultMode: config.runner.defaultMode || "sync",
    stdoutMaxBytes: Number(config.runner.stdoutMaxBytes || 1024 * 1024),
    stderrMaxBytes: Number(config.runner.stderrMaxBytes || 1024 * 1024),
    jobStoreFile: normalizePath(configDir, config.runner.jobStoreFile || "./jobs.json"),
  };

  assert(Number.isInteger(runner.maxConcurrent) && runner.maxConcurrent > 0, "invalid runner.maxConcurrent");
  assert(runner.defaultMode === "sync" || runner.defaultMode === "async", "invalid runner.defaultMode");
  assert(Number.isInteger(runner.stdoutMaxBytes) && runner.stdoutMaxBytes >= 0, "invalid runner.stdoutMaxBytes");
  assert(Number.isInteger(runner.stderrMaxBytes) && runner.stderrMaxBytes >= 0, "invalid runner.stderrMaxBytes");

  let scriptsRaw = null;
  let scriptsBaseDir = configDir;
  if (typeof config.scriptsFile === "string" && config.scriptsFile.length > 0) {
    const scriptsFilePath = normalizePath(configDir, config.scriptsFile);
    const scriptsFile = readJsonFile(scriptsFilePath);
    assert(scriptsFile && typeof scriptsFile === "object", "scripts file must be an object");
    assert(Array.isArray(scriptsFile.scripts), "scripts file must contain scripts array");
    scriptsRaw = scriptsFile.scripts;
    scriptsBaseDir = path.dirname(scriptsFilePath);
  } else {
    assert(Array.isArray(config.scripts), "scripts must be an array");
    scriptsRaw = config.scripts;
    scriptsBaseDir = configDir;
  }

  const scriptIds = new Set();
  const scripts = scriptsRaw.map((script) => {
    assert(script && typeof script === "object", "script item must be object");
    assert(typeof script.id === "string" && script.id.length > 0, "script.id required");
    assert(typeof script.path === "string" && script.path.length > 0, "script.path required");
    assert(!scriptIds.has(script.id), `duplicate script.id: ${script.id}`);
    scriptIds.add(script.id);

    const mode = script.mode || runner.defaultMode;
    assert(mode === "sync" || mode === "async", `invalid mode for ${script.id}`);

    const timeoutSec = script.timeoutSec == null ? 0 : Number(script.timeoutSec);
    assert(Number.isInteger(timeoutSec) && timeoutSec >= 0, `invalid timeoutSec for ${script.id}`);

    const args = script.args || {};
    const maxItems = args.maxItems == null ? 10 : Number(args.maxItems);
    const itemPattern = args.itemPattern || "^[\\s\\S]*$";
    const itemMaxLength = args.itemMaxLength == null ? 1024 : Number(args.itemMaxLength);
    assert(Number.isInteger(maxItems) && maxItems >= 0, `invalid args.maxItems for ${script.id}`);
    assert(typeof itemPattern === "string" && itemPattern.length > 0, `invalid args.itemPattern for ${script.id}`);
    assert(Number.isInteger(itemMaxLength) && itemMaxLength >= 0, `invalid args.itemMaxLength for ${script.id}`);

    return {
      id: script.id,
      path: normalizePath(scriptsBaseDir, script.path),
      mode,
      timeoutSec,
      args: {
        maxItems,
        itemPattern,
        itemMaxLength,
      },
    };
  });

  return { server, runner, scripts };
}

module.exports = {
  loadConfig,
};
