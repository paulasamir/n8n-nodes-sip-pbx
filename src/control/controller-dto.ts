import type { TriggerStreamKind } from "./controller-protocol";

export type ControllerRequestDto = {
  method: string;
  params?: Record<string, unknown>;
};

export type ControllerSuccessDto = {
  ok: true;
  result?: unknown;
};

export type ControllerErrorDto = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type ControllerResponseDto = ControllerSuccessDto | ControllerErrorDto;

export type TriggerStreamStartDto = {
  kind: TriggerStreamKind;
  config: Record<string, unknown>;
};

export type TriggerStreamEventDto = {
  kind: TriggerStreamKind;
  branch: string;
  payload: Record<string, unknown>;
};
