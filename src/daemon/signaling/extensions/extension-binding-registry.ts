import { MapRegistry } from "../../../shared/map-registry";

export type ExtensionRegistration = {
  ref: string;
  extensionNumber: string;
  endpointId: string;
  contactUri?: string;
  sourceIp?: string;
  sourcePort?: number;
  registeredAt: number;
  updatedAt: number;
  expiresAt?: number | null;
  activeCallLegId?: string | null;
  metadata: Record<string, unknown>;
};

export function deriveExtensionEndpointId(input: {
  contactUri?: string;
  sourceIp?: string;
  sourcePort?: number;
  extensionNumber?: string;
}): string {
  const contactUri = String(input.contactUri || "").trim();
  if (contactUri) {
    return `contact:${contactUri}`;
  }
  const sourceIp = String(input.sourceIp || "").trim();
  const sourcePort = Number(input.sourcePort || 0);
  if (sourceIp && sourcePort > 0) {
    return `source:${sourceIp}:${sourcePort}`;
  }
  return `extension:${String(input.extensionNumber || "").trim()}`;
}

export class ExtensionBindingRegistry extends MapRegistry<string, Map<string, Map<string, ExtensionRegistration>>> {

  putBinding(registration: ExtensionRegistration): ExtensionRegistration {
    let byExtension = this.get(registration.ref);
    if (!byExtension) {
      byExtension = new Map<string, Map<string, ExtensionRegistration>>();
      this.store(registration.ref, byExtension);
    }
    let byEndpoint = byExtension.get(registration.extensionNumber);
    if (!byEndpoint) {
      byEndpoint = new Map<string, ExtensionRegistration>();
      byExtension.set(registration.extensionNumber, byEndpoint);
    }
    const existing = byEndpoint.get(registration.endpointId) || null;
    const next: ExtensionRegistration = {
      ...registration,
      activeCallLegId: registration.activeCallLegId ?? existing?.activeCallLegId ?? null,
      expiresAt: registration.expiresAt ?? existing?.expiresAt ?? null,
    };
    byEndpoint.set(registration.endpointId, next);
    return next;
  }

  getBinding(ref: string, extensionNumber: string, endpointId?: string): ExtensionRegistration | null {
    const byEndpoint = this.get(ref)?.get(extensionNumber) || null;
    if (!byEndpoint) {
      return null;
    }
    if (endpointId) {
      return byEndpoint.get(endpointId) || null;
    }
    return Array.from(byEndpoint.values())
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0] || null;
  }

  listBindingsByRef(ref: string): ExtensionRegistration[] {
    const byExtension = this.get(ref);
    if (!byExtension) {
      return [];
    }
    return Array.from(byExtension.values()).flatMap((byEndpoint) => Array.from(byEndpoint.values()));
  }

  listBindingsByExtension(ref: string, extensionNumber: string): ExtensionRegistration[] {
    return Array.from(this.get(ref)?.get(extensionNumber)?.values() || []);
  }

  listBindings(): ExtensionRegistration[] {
    return this.values()
      .flatMap((byExtension) => Array.from(byExtension.values()))
      .flatMap((byEndpoint) => Array.from(byEndpoint.values()));
  }

  listAvailableBindings(ref: string, configuredExtensionNumbers?: string[]): ExtensionRegistration[] {
    const allowed = Array.isArray(configuredExtensionNumbers) && configuredExtensionNumbers.length > 0
      ? new Set(configuredExtensionNumbers)
      : null;
    return this.listBindingsByRef(ref).filter((registration) => (
      (!allowed || allowed.has(registration.extensionNumber))
      && !String(registration.activeCallLegId || "").trim()
    ));
  }

  listAvailableBindingsAcrossRefs(configuredExtensionNumbers?: string[]): ExtensionRegistration[] {
    const allowed = Array.isArray(configuredExtensionNumbers) && configuredExtensionNumbers.length > 0
      ? new Set(configuredExtensionNumbers)
      : null;
    return this.listBindings().filter((registration) => (
      (!allowed || allowed.has(registration.extensionNumber))
      && !String(registration.activeCallLegId || "").trim()
    ));
  }

  sweepExpiredBindings(now = Date.now()): ExtensionRegistration[] {
    const removed: ExtensionRegistration[] = [];
    for (const [ref, byExtension] of this.entries()) {
      for (const [extensionNumber, byEndpoint] of Array.from(byExtension.entries())) {
        for (const [endpointId, registration] of Array.from(byEndpoint.entries())) {
          if (registration.expiresAt != null && registration.expiresAt > 0 && registration.expiresAt <= now) {
            removed.push(registration);
            byEndpoint.delete(endpointId);
          }
        }
        if (byEndpoint.size === 0) {
          byExtension.delete(extensionNumber);
        }
      }
      if (byExtension.size === 0) {
        this.remove(ref);
      }
    }
    return removed;
  }

  unregisterByRef(ref: string): ExtensionRegistration[] {
    const byExtension = this.get(ref);
    if (!byExtension) {
      return [];
    }
    const registrations = Array.from(byExtension.values()).flatMap((byEndpoint) => Array.from(byEndpoint.values()));
    this.remove(ref);
    return registrations;
  }

  unregisterBinding(ref: string, extensionNumber: string, endpointId?: string): ExtensionRegistration[] {
    const byExtension = this.get(ref);
    if (!byExtension) {
      return [];
    }
    const byEndpoint = byExtension.get(extensionNumber);
    if (!byEndpoint) {
      return [];
    }
    const removed: ExtensionRegistration[] = [];
    if (endpointId) {
      const registration = byEndpoint.get(endpointId) || null;
      if (registration) {
        removed.push(registration);
        byEndpoint.delete(endpointId);
      }
    } else {
      removed.push(...Array.from(byEndpoint.values()));
      byEndpoint.clear();
    }
    if (byEndpoint.size === 0) {
      byExtension.delete(extensionNumber);
    }
    if (byExtension.size === 0) {
      this.remove(ref);
    }
    return removed;
  }

  markBindingActiveCall(ref: string, extensionNumber: string, activeCallLegId: string | null, endpointId?: string): ExtensionRegistration[] {
    const registrations = endpointId
      ? (this.getBinding(ref, extensionNumber, endpointId) ? [this.getBinding(ref, extensionNumber, endpointId)!] : [])
      : this.listBindingsByExtension(ref, extensionNumber);
    const updated: ExtensionRegistration[] = [];
    for (const registration of registrations) {
      const next: ExtensionRegistration = {
        ...registration,
        activeCallLegId: activeCallLegId || null,
      };
      updated.push(this.putBinding(next));
    }
    return updated;
  }
}
