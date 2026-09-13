#!/usr/bin/env node
import { parseCli, USAGE } from "../src/args.mjs";
import { clean } from "../src/clean.mjs";
import { Refusal, runLoop } from "../src/run.mjs";

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`build-loop: ${e.message}\n\n${USAGE}\n`);
    return 2;
  }

  if (opts.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    if (opts.command === "clean") {
      clean(opts);
      return 0;
    }
    return await runLoop(opts);
  } catch (e) {
    const prefix = e instanceof Refusal ? "refusing to start: " : "";
    process.stderr.write(`build-loop: ${prefix}${e.message}\n`);
    return 2;
  }
}

process.exitCode = await main();
