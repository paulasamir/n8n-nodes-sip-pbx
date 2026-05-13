#!/usr/bin/env node
"use strict";

const { runActionControlNodeSmokeCases } = require("./node-action-control-smoke-cases");
const { runActionMediaNodeSmokeCases } = require("./node-action-media-smoke-cases");

async function runActionNodeSmokeCases() {
  return {
    ...(await runActionControlNodeSmokeCases()),
    ...(await runActionMediaNodeSmokeCases()),
  };
}

module.exports = {
  runActionNodeSmokeCases,
};
