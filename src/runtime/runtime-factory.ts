import { PbxRuntime } from "./pbx-runtime";

type WorkflowScope = {
  getWorkflow?: () => { id?: unknown } | null;
};

const runtimeByWorkflow = new Map<string, PbxRuntime>();
const runtimeByScope = new WeakMap<object, PbxRuntime>();
const trackedRuntimes = new Set<PbxRuntime>();

function getWorkflowScopeKey(scope?: WorkflowScope | null): string {
  const workflow = typeof scope?.getWorkflow === "function" ? scope.getWorkflow() : null;
  const workflowId = workflow && workflow.id != null ? String(workflow.id) : "";
  return workflowId ? `workflow:${workflowId}` : "";
}

function createRuntime(workflowScopeKey = ""): PbxRuntime {
  const runtime = runtimeFactory ? runtimeFactory() : new PbxRuntime(undefined, workflowScopeKey);
  trackedRuntimes.add(runtime);
  return runtime;
}

let runtimeFactory: (() => PbxRuntime) | null = null;

export function setPbxRuntimeFactoryForTests(factory: (() => PbxRuntime) | null): void {
  runtimeFactory = factory;
}

export function resetPbxRuntimeForTests(): void {
  for (const runtime of trackedRuntimes.values()) {
    runtime.closeAllTriggerStreams();
  }
  runtimeByWorkflow.clear();
  trackedRuntimes.clear();
  runtimeFactory = null;
}

export function getPbxRuntime(scope?: WorkflowScope | null): PbxRuntime {
  const key = getWorkflowScopeKey(scope);
  if (key) {
    let runtime = runtimeByWorkflow.get(key) || null;
    if (!runtime) {
      runtime = createRuntime(key);
      runtimeByWorkflow.set(key, runtime);
    }
    return runtime;
  }
  if (scope && (typeof scope === "object" || typeof scope === "function")) {
    let runtime = runtimeByScope.get(scope) || null;
    if (!runtime) {
      runtime = createRuntime();
      runtimeByScope.set(scope, runtime);
    }
    return runtime;
  }
  return createRuntime();
}
