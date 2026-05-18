# Changelog

## 0.1.2 - 2026-05-18

### Wait, interrupt, and queue lifecycle semantics

- Reworked `call.wait`, `dial.wait`, and `media.wait` around a shared built-in `interruptReason` catalog with source-prefixed values such as:
  - `call_dtmf`
  - `call_ended`
  - `call_bridge_joined`
  - `call_queue_removed`
  - `media_voice`
  - `media_silence`
  - `media_stopped`
- `call.wait` now exposes `Interrupt On` as an explicit multi-select option. When it is empty, interrupt events are consumed and ignored instead of taking the `Interrupted` branch.
- Added `Clear Queued DTMF` to `call.wait` so stale queued digits can be dropped before starting a new leg wait.
- `call.wait` branch naming is now consistent with the rest of the node set and uses `Interrupted`.
- `call.bridge` now emits immediate bridge lifecycle interrupts to active `call.wait` operations, and bridge/queue interrupts were normalized into a consistent reason vocabulary.
- Queue lifecycle events are now surfaced on legs through `call_queue_placed` and `call_queue_removed` where applicable, while caller hangup still resolves as normal `Ended`.
- `dial.wait` master-leg interruption was rewritten to match the same cancellation model used by other waits:
  - master-leg `ended` always interrupts the wait
  - master-leg DTMF interrupts only when enabled
  - queued master-leg DTMF/ended no longer get consumed by the interrupt check before a later `call.wait`
- Fixed the race where `dial.wait` could surface a runtime `wait_timeout` exception instead of taking the `Timeout` branch.

### DTMF buffering and media behavior

- Blocking media, `media.wait`, and `dial.wait` now consume queued/live DTMF when DTMF interruption is disabled, so stale digits do not leak into later `call.wait` steps.
- `media.wait` now mirrors blocking-media DTMF behavior on watched non-interrupting media.
- Fixed and expanded transport/media DTMF handling around queue loops, bridge flows, and non-interrupting waits.

### Action contract cleanup

- Renamed public action fields for consistency:
  - `mediaLegId` / `stopMediaLegId` -> `legId`
  - `stopMediaId` -> `mediaId`
  - `waitMediaIds` -> `mediaIds`
- Simplified wait inputs:
  - `call.wait` now uses only `legIds`
  - `dial.wait` now uses only `dialIds`
- Renamed `extensionListOnlyFreeEndpoints` to `extensionOnlyFreeEndpoints`.
- Removed the public `Reason` selector from `media.stopMedia`; explicit stop now always finalizes media with `interruptReason = "media_stopped"`.

### Defaults and normalization

- Centralized node option defaults into shared semantic defaults so UI, input normalization, and daemon/runtime fallback no longer drift independently.
- Reduced generic fallback usage in favor of domain-specific defaults, especially for boolean and numeric settings.
- Removed remaining runtime-side business defaults so the runtime layer acts as a thinner transport/translation layer.

### Demo and documentation

- Rebuilt the demo walkthrough around a part-based structure with a canonical full demo and a reduced set of importable examples.
- Updated demo JSON and wiki pages to reflect:
  - queue-owned caller lifecycle
  - AI offline flow layering
  - recording layering
  - current interrupt reason names and wait semantics
- Added and expanded `Why This Works` sections in the example documentation.

## 0.1.1 - 2026-05-16

### Trunk trigger and SIP routing

- Reworked trunk trigger modes around `Connection mode`:
  - `Fixed Address`
  - `Dynamic Address`
- Added `Use registration` to `Fixed Address`. Fixed trunks can now work either:
  - with outbound registration and route-token matching
  - or without registration, matched by configured remote address and port
- `Dynamic Address` now uses the same auth-mode model as extensions:
  - `Static`
  - `Digest First`
  - `Raw`
- Added trunk-side `Continue On Auth Reject` for `Dynamic Address`.
- Reworked inbound SIP routing on shared listeners so trunks and extensions can coexist on the same socket with deterministic fallback:
  - registered fixed trunks first
  - then fixed trunks without registration
  - then dynamic trunks
  - then extensions
- Fixed unregister handling for registered trunks so `REGISTER expires=0` correctly answers digest challenge during trigger shutdown.
- Refactored SIP transport internals around shared listeners, auth traversal, and endpoint-level request routing.
- `Respond to auth` now allows an empty `Extension` value in the UI and documents when it is optional.

### Recording and trigger flows

- Added a dedicated `Global recording` resource with actions:
  - `Start recording`
  - `Control recording`
  - `Respond to recording`
- `Start recording` works by `legId` and restarts an active global recording on the same leg.
- Moved recording-related control out of the older mixed action grouping into a dedicated public resource section.
- Renamed trunk and extensions recording trigger branch to `Recording`.
- Recording trigger flows now explicitly cover outbound-call recording scenarios created by `dial.make`.

### Queue behavior and payloads

- Queue trigger payloads now publish `callerNumber`, `callerName`, and `trunkRef` on all branches.
- `Offline` queue events now also include `mode`.
- Queue trigger `legId` is now emitted only when the associated live leg still exists and is active.
- Queue stats durations are now returned in seconds.
- Queue stats targeted by `legId` now also return that `legId` in the result.

### Wait semantics and branch ordering

- Normalized wait action operation ids to:
  - `call.wait`
  - `dial.wait`
  - `media.wait`
- Updated branch ordering to match runtime behavior:
  - `dial.wait`: `Ringing`, `Progress`, `Rejected`, `Answered`, `Timeout`, `Failed`
  - `call.wait`: static tail now keeps `Ended` last
  - `media.wait`: `Interrupted`, `Timeout`, `Completed`
- `call.wait` interdigit timeout now applies only when:
  - the current digits are a prefix of at least one rule, or
  - multi-digit DTMF fallback is enabled
- Restored `call.wait` semantics where overall timeout `0` means immediate timeout rather than infinite wait.
- Added optional `legId` retention to `dial.wait` so a related leg can be kept alive while waiting on the dial.
- Added short-lived terminal snapshots for finalized `dial`, `leg`, and `media` entities so wait operations can still resolve terminal outcomes after fast cleanup instead of failing on lookup races.

### Dial and call control

- `dial.make` in extension mode keeps the explicit `Unavailable` branch for missing active registrations.
- `dial.make` for dynamic trunks without an active binding now still returns normal ids and lets `dial.wait` resolve through `Failed` instead of failing immediately at action level.
- `call.wait` and `dial.wait` daemon-side retention logic now skips missing live entities so terminal snapshot fallback can be reached.

### Media, DTMF, and codec handling

- Fixed G.711 A-law implementation and added full table tests for both A-law and mu-law.
- De-duplicated inbound RFC2833 DTMF end-packet retransmits so one keypress no longer produces multiple events.
- Fixed blocking-media DTMF handling:
  - with `interruptOnDtmf=false`, digits are consumed and do not leak to the next node
  - with `interruptOnDtmf=true`, the interrupting digit remains available to the next wait node
- Wired `Stop Other Media` correctly for:
  - `Play Audio`
  - `Play Tone`
  - `Record Audio`
- Fixed bridge ducking so `Ducking Factor` also attenuates bridged peer audio, not only local playback sources.

### Trigger payload and naming updates

- Trunk and extensions `Call`/`Recording` payloads now expose:
  - `calledNumber`
  - `calledName`
  instead of the older `called` field.
- Simplified action subtitle generation so all actions, including wait actions, use the same subtitle logic.
- Renamed internal wait operation ids and related runtime mappings to the shorter normalized names.

### Test coverage

- Expanded unit, integration, and smoke coverage for:
  - G.711 codecs
  - trunk SIP auth and registration paths
  - queue trigger payloads
  - wait lifecycle races
  - media DTMF and bridge behavior

## 0.1.0 - 2026-05-13

Initial commit.
