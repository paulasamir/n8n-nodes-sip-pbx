#!/usr/bin/env node
"use strict";

const { runTriggerNodeSmokeCases } = require("./cases/node-trigger-smoke-cases");
const { runActionNodeSmokeCases } = require("./cases/node-action-smoke-cases");

async function main() {
  const triggerCases = await runTriggerNodeSmokeCases();
  const actionCases = await runActionNodeSmokeCases();
  console.log(JSON.stringify({
    ok: true,
    ...triggerCases,
    ...actionCases,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
