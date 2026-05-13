import type {
  MediaEndpointKind,
  ReadableMediaEndpoint,
  WritableMediaEndpoint,
} from "../../io/media-endpoint";
import type { MediaOperationKind } from "../../operations/media-operation";

type MediaEndpointHandle = ReadableMediaEndpoint | WritableMediaEndpoint | null;
type WorkerMediaDescriptor = {
  mediaId: string;
  legId: string;
  kind: MediaOperationKind;
  options: Record<string, unknown>;
};

export class Media {
  readonly operation: WorkerMediaDescriptor;
  readonly endpoint: MediaEndpointHandle;

  constructor(input: {
    operation: WorkerMediaDescriptor;
    endpoint?: MediaEndpointHandle;
  }) {
    this.operation = input.operation;
    this.endpoint = input.endpoint || null;
  }

  get mediaId(): string {
    return this.operation.mediaId;
  }

  get legId(): string {
    return this.operation.legId;
  }

  get kind(): MediaOperationKind {
    return this.operation.kind;
  }

  get operationInput(): Record<string, unknown> {
    return this.operation.options;
  }

  get endpointType(): MediaEndpointKind | null {
    return this.endpoint?.endpointType || null;
  }

  get endpointDirection(): "input" | "output" | null {
    return this.endpoint?.direction || null;
  }

  getReadableEndpoint(): ReadableMediaEndpoint {
    if (!this.endpoint || this.endpoint.direction !== "input") {
      throw new Error(`Media ${this.mediaId} has no readable endpoint`);
    }
    return this.endpoint;
  }

  getWritableEndpoint(): WritableMediaEndpoint {
    if (!this.endpoint || this.endpoint.direction !== "output") {
      throw new Error(`Media ${this.mediaId} has no writable endpoint`);
    }
    return this.endpoint;
  }
}
