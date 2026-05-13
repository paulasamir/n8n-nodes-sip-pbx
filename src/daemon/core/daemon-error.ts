export type DaemonError = Error & {
  readonly code: string;
  readonly details?: Record<string, unknown>;
};

export function daemonError(code: string, message: string, details?: Record<string, unknown>): DaemonError {
  const error = new Error(message) as DaemonError;
  error.name = "DaemonError";
  (error as { code: string }).code = code;
  if (details !== undefined) {
    (error as { details?: Record<string, unknown> }).details = details;
  }
  return error;
}

export function isDaemonError(error: unknown): error is DaemonError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

function normalizeControllerErrorCode(code: string): string {
  switch (code) {
    case "invalid_request":
    case "configuration_error":
    case "not_found":
    case "conflict":
    case "precondition_failed":
    case "unsupported_operation":
    case "internal_error":
      return code;
    case "not_implemented":
    case "unsupported_method":
      return "unsupported_operation";
    case "invalid_leg":
    case "invalid_dial":
    case "invalid_media":
    case "invalid_auth_request":
    case "invalid_record_request":
    case "invalid_queue_request":
    case "invalid_queue_entry":
      return "not_found";
    case "recording_already_active":
      return "conflict";
    case "leg_ended":
    case "dial_ended":
    case "media_ended":
      return "precondition_failed";
    case "invalid_trigger":
    case "invalid_parameter":
    case "invalid_media_source":
    case "invalid_media_output":
    case "invalid_media_target":
    case "invalid_media_wait":
    case "invalid_dial_targets":
    case "invalid_queue_stats_target":
      return "invalid_request";
    default:
      return "internal_error";
  }
}

export function daemonErrorDto(error: unknown) {
  if (isDaemonError(error)) {
    return {
      ok: false as const,
      error: {
        code: normalizeControllerErrorCode(error.code),
        message: error.message,
        details: error.details,
      },
    };
  }
  const message = error instanceof Error ? error.message : "Unknown daemon error";
  return {
    ok: false as const,
    error: {
      code: "internal_error",
      message,
    },
  };
}
