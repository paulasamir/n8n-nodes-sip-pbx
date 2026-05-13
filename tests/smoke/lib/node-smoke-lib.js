#!/usr/bin/env node
"use strict";

const pbxRuntimeModulePath = require.resolve("../../../dist/runtime/runtime-factory.js");
const sipPbxNodeModulePath = require.resolve("../../../dist/n8n/nodes/SipPbx.node.js");
const sipPbxTriggerModulePath = require.resolve("../../../dist/n8n/nodes/SipPbxTrigger.node.js");

function getParameterValue(parameters, name, index, fallbackValue) {
  const rawValue = Object.prototype.hasOwnProperty.call(parameters || {}, name) ? parameters[name] : fallbackValue;
  if (Array.isArray(rawValue)) {
    return index < rawValue.length ? rawValue[index] : fallbackValue;
  }
  return rawValue;
}

function createExecuteContext(parameters, items, options = {}) {
  return {
    getInputData() {
      return Array.isArray(items) && items.length ? items : [{ json: {} }];
    },
    getNodeParameter(name, index, fallbackValue) {
      return getParameterValue(parameters, name, index, fallbackValue);
    },
    getNode() {
      return { name: options.nodeName || "SIP PBX" };
    },
    getWorkflow() {
      return {
        id: options.workflowId || "wf-node-smoke",
        connectionsBySourceNode: options.connectionsBySourceNode || {},
      };
    },
    helpers: {
      returnJsonArray(payloads) {
        return (Array.isArray(payloads) ? payloads : []).map((payload) => ({ json: payload }));
      },
      ...(options.helpers || {}),
    },
    async getCredentials(name) {
      if (options.credentials && Object.prototype.hasOwnProperty.call(options.credentials, name)) {
        return options.credentials[name];
      }
      throw new Error(`Missing credentials: ${name}`);
    },
  };
}

function createTriggerContext(parameters, options = {}) {
  const emitted = options.emitted || [];
  return {
    getNodeParameter(name, index, fallbackValue) {
      return getParameterValue(parameters, name, index, fallbackValue);
    },
    getNode() {
      return { name: options.nodeName || "SIP PBX Trigger", position: options.nodePosition || [0, 0] };
    },
    getWorkflow() {
      return { id: options.workflowId || "wf-trigger-smoke" };
    },
    emit(outputs) {
      emitted.push(outputs);
    },
    async getCredentials(name) {
      if (options.credentials && Object.prototype.hasOwnProperty.call(options.credentials, name)) {
        return options.credentials[name];
      }
      throw new Error(`Missing credentials: ${name}`);
    },
  };
}

async function withPatchedRuntime(fakeRuntime, nodeModulePath, run, options = {}) {
  const pbxRuntimeModule = require(pbxRuntimeModulePath);
  const originalGetPbxRuntime = pbxRuntimeModule.getPbxRuntime;
  const invalidate = [nodeModulePath, ...((options.invalidateModules || []).filter(Boolean))];
  const cachedModules = new Map();
  for (const modulePath of invalidate) {
    cachedModules.set(modulePath, Object.prototype.hasOwnProperty.call(require.cache, modulePath) ? require.cache[modulePath] : null);
  }
  pbxRuntimeModule.getPbxRuntime = () => fakeRuntime;
  try {
    for (const modulePath of invalidate) {
      delete require.cache[modulePath];
    }
    const loadedModule = require(nodeModulePath);
    return await run(loadedModule);
  } finally {
    pbxRuntimeModule.getPbxRuntime = originalGetPbxRuntime;
    for (const modulePath of invalidate) {
      delete require.cache[modulePath];
      const cachedModule = cachedModules.get(modulePath);
      if (cachedModule) {
        require.cache[modulePath] = cachedModule;
      }
    }
  }
}

module.exports = {
  sipPbxNodeModulePath,
  sipPbxTriggerModulePath,
  createExecuteContext,
  createTriggerContext,
  withPatchedRuntime,
};
