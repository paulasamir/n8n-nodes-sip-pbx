"use strict";

const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const sourceNodesDir = path.join(rootDir, "src", "n8n", "nodes");
const distNodesDir = path.join(rootDir, "dist", "n8n", "nodes");

fs.mkdirSync(distNodesDir, { recursive: true });

const sourceSvgs = new Set(
  fs.readdirSync(sourceNodesDir).filter((entry) => entry.endsWith(".svg")),
);

for (const entry of fs.readdirSync(distNodesDir)) {
  if (!entry.endsWith(".svg")) continue;
  if (sourceSvgs.has(entry)) continue;
  fs.unlinkSync(path.join(distNodesDir, entry));
}

for (const entry of sourceSvgs) {
  fs.copyFileSync(path.join(sourceNodesDir, entry), path.join(distNodesDir, entry));
}
