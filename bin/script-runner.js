#!/usr/bin/env node

const path = require("path");

function printHelp() {
  const text = `
script-runner

Usage:
  script-runner [--config <path>]

Options:
  --config, -c   Path to config.json (default: ./config.json)
  --help, -h     Show this help message
`;
  process.stdout.write(text.trimStart());
  process.stdout.write("\n");
}

function parseArgs(argv) {
  const result = {
    config: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("missing value for --config");
      }
      result.config = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return result;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write("Use --help for usage.\n");
    process.exit(1);
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  if (parsed.config) {
    process.env.CONFIG_FILE = path.resolve(process.cwd(), parsed.config);
  }

  require("../src/server");
}

main();
