import { getDefaultFreeTtlMs, nowMs } from "../../core/time";
import { LegService } from "../../legs/leg-service";
import { InboundCallService } from "../calls/inbound-call-service";
import type { InboundSipInvite } from "../types";
import { deriveFlowScopedTriggerRef, parseFlowScopedTriggerRef } from "../triggers/ref-policy";
import { ExtensionAuthBridge } from "./extension-auth-bridge";
import { deriveExtensionEndpointId, ExtensionBindingRegistry } from "./extension-binding-registry";
import { ExtensionRegistrationGrace } from "./extension-registration-grace";

type ExtensionTriggerPublisher = (ref: string, branch: string, payload: Record<string, unknown>) => void;

export class ExtensionHost {
  private readonly registry: ExtensionBindingRegistry;
  private readonly legService: LegService;
  private readonly inboundCallService: InboundCallService;
  private readonly authBridge: ExtensionAuthBridge;
  private readonly publish: ExtensionTriggerPublisher;
  private readonly onAvailabilityChanged: (ref: string) => void;
  private readonly registrationGrace: ExtensionRegistrationGrace;

  constructor(input: {
    registry: ExtensionBindingRegistry;
    legService: LegService;
    inboundCallService: InboundCallService;
    authBridge: ExtensionAuthBridge;
    publish: ExtensionTriggerPublisher;
    onAvailabilityChanged?: (ref: string) => void;
    registrationGraceMs?: number;
  }) {
    this.registry = input.registry;
    this.legService = input.legService;
    this.inboundCallService = input.inboundCallService;
    this.authBridge = input.authBridge;
    this.publish = input.publish;
    this.onAvailabilityChanged = input.onAvailabilityChanged || (() => undefined);
    this.registrationGrace = new ExtensionRegistrationGrace(Number(input.registrationGraceMs ?? getDefaultFreeTtlMs()));
  }

  handleTriggerActivated(ref: string): void {
    this.registrationGrace.cancel(ref);
  }

  handleTriggerClosed(ref: string): void {
    this.registrationGrace.schedule(ref, () => {
      const removed = this.registry.unregisterByRef(ref);
      if (removed.length > 0) {
        this.onAvailabilityChanged(ref);
      }
    });
  }

  registerEndpoint(input: {
    ref: string;
    extensionNumber: string;
    endpointId?: string;
    contactUri?: string;
    sourceIp?: string;
    sourcePort?: number;
    expiresAt?: number | null;
    metadata?: Record<string, unknown>;
  }): { ref: string; extensionNumber: string } {
    const now = nowMs();
    const endpointId = String(input.endpointId || "").trim() || deriveExtensionEndpointId(input);
    this.registry.putBinding({
      ref: input.ref,
      extensionNumber: input.extensionNumber,
      endpointId,
      contactUri: input.contactUri,
      sourceIp: input.sourceIp,
      sourcePort: input.sourcePort,
      registeredAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt == null ? null : Number(input.expiresAt),
      metadata: { ...(input.metadata || {}) },
    });
    this.onAvailabilityChanged(input.ref);
    return { ref: input.ref, extensionNumber: input.extensionNumber };
  }

  unregisterEndpoint(ref: string, extensionNumber: string, options?: {
    endpointId?: string;
    contactUri?: string;
    sourceIp?: string;
    sourcePort?: number;
  }): { ref: string; extensionNumber: string } {
    const endpointId = String(options?.endpointId || "").trim()
      || deriveExtensionEndpointId({
        contactUri: options?.contactUri,
        sourceIp: options?.sourceIp,
        sourcePort: options?.sourcePort,
        extensionNumber,
      });
    if (options?.endpointId || options?.contactUri || options?.sourceIp || options?.sourcePort) {
      this.registry.unregisterBinding(ref, extensionNumber, endpointId);
    } else {
      this.registry.unregisterBinding(ref, extensionNumber);
    }
    this.onAvailabilityChanged(ref);
    return { ref, extensionNumber };
  }

  getRegistration(ref: string, extensionNumber: string, endpointId?: string) {
    this.sweepExpiredBindings();
    return this.registry.getBinding(this.resolveAvailabilityRef(ref), extensionNumber, endpointId);
  }

  listOnlineExtensionTargetsByRef(ref: string): Array<{ ref: string; extensionNumber: string; endpointId: string }> {
    this.sweepExpiredBindings();
    return this.registry.listBindingsByRef(this.resolveAvailabilityRef(ref))
      .sort((left, right) => {
        const extensionComparison = left.extensionNumber.localeCompare(right.extensionNumber);
        return extensionComparison !== 0 ? extensionComparison : left.endpointId.localeCompare(right.endpointId);
      })
      .map((registration) => ({
        ref: registration.ref,
        extensionNumber: registration.extensionNumber,
        endpointId: registration.endpointId,
      }));
  }

  listOnlineExtensionNumbers(ref: string, configuredExtensionNumbers?: string[]): string[] {
    this.sweepExpiredBindings();
    const online = Array.from(new Set(
      this.registry.listBindingsByRef(this.resolveAvailabilityRef(ref)).map((registration) => registration.extensionNumber),
    ));
    if (!configuredExtensionNumbers || configuredExtensionNumbers.length === 0) {
      return online;
    }
    const configured = new Set(configuredExtensionNumbers);
    return online.filter((extensionNumber) => configured.has(extensionNumber));
  }

  listAvailableExtensionNumbers(ref: string, configuredExtensionNumbers?: string[]): string[] {
    this.sweepExpiredBindings();
    const availabilityRef = this.resolveAvailabilityRef(ref);
    const busy = this.collectBusyEndpointMarkers();
    return this.registry
      .listAvailableBindings(availabilityRef, configuredExtensionNumbers)
      .filter((registration) => !this.isRegistrationBusy(registration, busy))
      .map((registration) => registration.extensionNumber)
      .filter((value, index, values) => values.indexOf(value) === index);
  }

  listOnlineExtensionNumbersInFlow(workflowScopeKey: string, configuredExtensionNumbers?: string[]): string[] {
    this.sweepExpiredBindings();
    const allowed = Array.isArray(configuredExtensionNumbers) && configuredExtensionNumbers.length > 0
      ? new Set(configuredExtensionNumbers)
      : null;
    const online = new Set<string>();
    for (const registration of this.listBindingsInWorkflow(workflowScopeKey)) {
      if (!allowed || allowed.has(registration.extensionNumber)) {
        online.add(registration.extensionNumber);
      }
    }
    return Array.from(online).sort((left, right) => left.localeCompare(right));
  }

  listAvailableExtensionNumbersInFlow(workflowScopeKey: string, configuredExtensionNumbers?: string[]): string[] {
    this.sweepExpiredBindings();
    const allowed = Array.isArray(configuredExtensionNumbers) && configuredExtensionNumbers.length > 0
      ? new Set(configuredExtensionNumbers)
      : null;
    const busy = this.collectBusyEndpointMarkers();
    const available = new Set<string>();
    for (const registration of this.listBindingsInWorkflow(workflowScopeKey)) {
      if (allowed && !allowed.has(registration.extensionNumber)) {
        continue;
      }
      if (String(registration.activeCallLegId || "").trim()) {
        continue;
      }
      if (this.isRegistrationBusy(registration, busy)) {
        continue;
      }
      available.add(registration.extensionNumber);
    }
    return Array.from(available).sort((left, right) => left.localeCompare(right));
  }

  listAvailableExtensionTargets(configuredExtensionNumbers?: string[]): Array<{ ref: string; extensionNumber: string; endpointId: string }> {
    this.sweepExpiredBindings();
    const busy = this.collectBusyEndpointMarkers();
    return this.registry
      .listAvailableBindingsAcrossRefs(configuredExtensionNumbers)
      .filter((registration) => !this.isRegistrationBusy(registration, busy))
      .map((registration) => ({
        ref: registration.ref,
        extensionNumber: registration.extensionNumber,
        endpointId: registration.endpointId,
      }))
      .sort((left, right) => {
        const refComparison = left.ref.localeCompare(right.ref);
        if (refComparison !== 0) {
          return refComparison;
        }
        const extensionComparison = left.extensionNumber.localeCompare(right.extensionNumber);
        return extensionComparison !== 0 ? extensionComparison : left.endpointId.localeCompare(right.endpointId);
      });
  }

  listOnlineExtensionTargets(configuredExtensionNumbers?: string[]): Array<{ ref: string; extensionNumber: string; endpointId: string }> {
    this.sweepExpiredBindings();
    const allowed = Array.isArray(configuredExtensionNumbers) && configuredExtensionNumbers.length > 0
      ? new Set(configuredExtensionNumbers)
      : null;
    return this.registry
      .listBindings()
      .filter((registration) => !allowed || allowed.has(registration.extensionNumber))
      .map((registration) => ({
        ref: registration.ref,
        extensionNumber: registration.extensionNumber,
        endpointId: registration.endpointId,
      }))
      .sort((left, right) => {
        const refComparison = left.ref.localeCompare(right.ref);
        if (refComparison !== 0) {
          return refComparison;
        }
        const extensionComparison = left.extensionNumber.localeCompare(right.extensionNumber);
        return extensionComparison !== 0 ? extensionComparison : left.endpointId.localeCompare(right.endpointId);
      });
  }

  emitInboundInvite(input: InboundSipInvite): { legId: string; ref: string } {
    const result = this.inboundCallService.emitForExtensions(input, this.publish);
    this.onAvailabilityChanged(input.ref);
    return result;
  }

  createAuthRequest(input: {
    ref: string;
    publicRef?: string;
    requestContext: {
      requestType: string;
      method: string;
      username?: string;
      externalUsername?: string;
      endpointExtension?: string;
      realm?: string;
      hasAuthorization?: boolean;
      authorization?: Record<string, unknown>;
      sourceIp?: string;
      raw?: Record<string, unknown>;
    };
    timeout?: number;
  }) {
    return this.authBridge.createRequest(input);
  }

  listExtensionTargetsInFlow(
    workflowScopeKey: string,
    configuredExtensionNumbers?: string[],
    onlyFree = false,
  ): Array<{ ref: string; extensionNumber: string; endpointId: string }> {
    this.sweepExpiredBindings();
    const busy = this.collectBusyEndpointMarkers();
    const configuredOrder = Array.isArray(configuredExtensionNumbers) && configuredExtensionNumbers.length > 0
      ? new Map(configuredExtensionNumbers.map((extensionNumber, index) => [extensionNumber, index]))
      : null;
    return this.registry
      .listBindings()
      .filter((registration) => {
        const parsed = parseFlowScopedTriggerRef(registration.ref);
        return parsed ? parsed.kind === "extensions" && parsed.workflowScopeKey === workflowScopeKey : false;
      })
      .filter((registration) => {
        if (!configuredExtensionNumbers || configuredExtensionNumbers.length === 0) {
          return true;
        }
        return configuredExtensionNumbers.includes(registration.extensionNumber);
      })
      .filter((registration) => !onlyFree || (!String(registration.activeCallLegId || "").trim() && !this.isRegistrationBusy(registration, busy)))
      .map((registration) => ({
        ref: registration.ref,
        extensionNumber: registration.extensionNumber,
        endpointId: registration.endpointId,
      }))
      .sort((left, right) => {
        if (configuredOrder) {
          const leftOrder = configuredOrder.get(left.extensionNumber) ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = configuredOrder.get(right.extensionNumber) ?? Number.MAX_SAFE_INTEGER;
          if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }
        }
        const extensionComparison = left.extensionNumber.localeCompare(right.extensionNumber);
        if (extensionComparison !== 0) {
          return extensionComparison;
        }
        const endpointComparison = left.endpointId.localeCompare(right.endpointId);
        return endpointComparison !== 0 ? endpointComparison : left.ref.localeCompare(right.ref);
      });
  }

  resolveEndpointIdForTriggerLeg(
    ref: string,
    extensionNumber: string,
    input?: {
      contactUri?: string;
      sourceIp?: string;
      sourcePort?: number;
    },
  ): string {
    this.sweepExpiredBindings();
    const normalizedRef = this.resolveAvailabilityRef(ref);
    const contactUri = String(input?.contactUri || "").trim();
    const sourceIp = String(input?.sourceIp || "").trim();
    const sourcePort = Number(input?.sourcePort || 0);
    const exactContact = contactUri
      ? this.registry.listBindingsByExtension(normalizedRef, extensionNumber)
        .find((registration) => String(registration.contactUri || "").trim() === contactUri)
      : null;
    if (exactContact?.endpointId) {
      return exactContact.endpointId;
    }
    const exactSource = sourceIp && sourcePort > 0
      ? this.registry.listBindingsByExtension(normalizedRef, extensionNumber)
        .find((registration) => String(registration.sourceIp || "").trim() === sourceIp && Number(registration.sourcePort || 0) === sourcePort)
      : null;
    if (exactSource?.endpointId) {
      return exactSource.endpointId;
    }
    return deriveExtensionEndpointId({
      contactUri,
      sourceIp,
      sourcePort,
      extensionNumber,
    });
  }

  private resolveAvailabilityRef(ref: string): string {
    return deriveFlowScopedTriggerRef(ref, "extensions");
  }

  private listBindingsInWorkflow(workflowScopeKey: string) {
    return this.registry.listBindings().filter((registration) => {
      if (!workflowScopeKey) {
        return true;
      }
      const parsed = parseFlowScopedTriggerRef(registration.ref);
      return parsed ? parsed.kind === "extensions" && parsed.workflowScopeKey === workflowScopeKey : false;
    });
  }

  private collectBusyEndpointMarkers(): { exact: Set<string>; broad: Set<string> } {
    const exact = new Set<string>();
    const broad = new Set<string>();
    for (const leg of this.legService.listLegs().filter((entry) => entry.status !== "ended")) {
      const ref = String(leg.triggerMetadata?.ref || "").trim();
      const extensionNumber = String(leg.triggerMetadata?.extensionNumber || "").trim();
      const endpointId = String(leg.triggerMetadata?.endpointId || "").trim();
      if (!ref || !extensionNumber) {
        continue;
      }
      if (endpointId) {
        exact.add(`${ref}\u0000${extensionNumber}\u0000${endpointId}`);
      } else {
        broad.add(`${ref}\u0000${extensionNumber}`);
      }
    }
    return { exact, broad };
  }

  private isRegistrationBusy(
    registration: { ref: string; extensionNumber: string; endpointId: string },
    busy: { exact: Set<string>; broad: Set<string> },
  ): boolean {
    return busy.exact.has(`${registration.ref}\u0000${registration.extensionNumber}\u0000${registration.endpointId}`)
      || busy.broad.has(`${registration.ref}\u0000${registration.extensionNumber}`);
  }

  private sweepExpiredBindings(): void {
    const removed = this.registry.sweepExpiredBindings(nowMs());
    if (removed.length === 0) {
      return;
    }
    const refs = new Set(removed.map((registration) => registration.ref));
    for (const ref of refs) {
      this.onAvailabilityChanged(ref);
    }
  }
}
