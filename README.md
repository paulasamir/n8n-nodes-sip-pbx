# n8n-nodes-sip-pbx

SIP PBX community nodes for n8n with a daemon-backed telephony runtime.

This package turns n8n into a workflow-driven SIP and media control surface for:

- inbound trunk calls
- extension registration and interactive auth
- outbound SIP dialing
- outbound WebSocket media legs
- IVR-style DTMF flows
- prompt playback and recording
- call bridging
- queue routing and queue stats
- AI tool and voice-agent workflows

Project links:

- Homepage: <https://github.com/siptg/n8n-nodes-sip-pbx>
- npm: <https://www.npmjs.com/package/n8n-nodes-sip-pbx>
- Issues: <https://github.com/siptg/n8n-nodes-sip-pbx/issues>
- Wiki: <https://github.com/siptg/n8n-nodes-sip-pbx/wiki>

## Why this package exists

Most telephony workflows need more than a single SIP webhook:

- signaling and RTP state must stay alive outside one node execution
- playback, recording, queueing, and waiting must survive normal workflow steps
- bridge/media timing must be handled in a real runtime, not in ad-hoc JS
- AI and WebSocket media integrations need the same leg model as SIP calls

`n8n-nodes-sip-pbx` solves that by running a dedicated daemon and media worker layer behind two community nodes: **SIP PBX Trigger** and **SIP PBX**.

From the workflow point of view, you still work with plain n8n items and branches. The daemon owns the live SIP dialogs, RTP endpoints, media workers, queue state, and WebSocket media sessions.

## Highlights

- Full SIP call control for inbound and outbound legs: ringing, answer, hangup, bridge, unbridge.
- Blocking and background media operations with `mediaId`-based control.
- **Wait For Event**, **Wait Media**, and **Wait For Dial Event** primitives for event-driven IVR and call loops.
- Queue routing that owns operator dialing in the daemon instead of relying on fragile workflow races.
- SIP extension registration plus interactive auth trigger flows.
- WebSocket leg support through transport profiles: **OpenAI Realtime**, **Gemini Live** and generic.
- AI tool and voice-agent integration on top of live WebSocket legs.
- Native audio/runtime support for: **PCMU**, **PCMA**, **G.722**, **Opus** and **G.729**.

## What you can build

Typical workflows supported by the current public contract:

- Answer a trunk call, play a prompt, collect DTMF, and route by exact digit rules.
- Register SIP extensions and push REGISTER or INVITE auth decisions into `n8n`.
- Dial one or more SIP targets in parallel or sequentially and wait for ringing, progress, rejection, answer, timeout, or failure.
- Bridge a PSTN caller to:
  - another SIP leg
  - an extension endpoint
  - a WebSocket-backed media leg
- Run hold music or tones in background while waiting on another event.
- Record calls to:
  - binary output
  - a local file path
  - an HTTP upload target
- Put callers into a queue and let the daemon own operator dialing and retry pacing.
- Attach a voice agent to a live WebSocket leg and route tool calls into `n8n`.

## SIP and media model

The runtime is built around a few stable public IDs: `legId`, `dialId` and `mediaId`.

That makes orchestration predictable:

- calls and bridges work on `legId`
- outbound dialing is tracked through `dialId`
- playback and recording are tracked through `mediaId`

## Media execution model

**Play Audio**, **Play Tone**, and **Record Audio** support two execution styles.

### Blocking

The node waits for the terminal media event itself.

Typical use:

- short IVR prompts
- synchronous recording steps
- deterministic branch routing on media completion or interruption

### Background

The node returns immediately with `mediaId`, while the daemon keeps the media operation alive.

Typical use:

- queue music
- periodic prompts
- long-running recording
- event-driven orchestration where a later node stops or waits on the media explicitly

## Queue behavior

Queue handling is daemon-owned, not workflow-owned.

It is trigger-based and includes three outcomes:

- Placed — the caller has been enqueued
- Dispatch — a sutable operator became available
- Offline — no available operators at the moment

To save the position in the queue, the caller can be marked for a callback. When marked, it can call again to be restored at the same position before hangup.

## WebSocket media legs

**Create Dial** supports mode `WebSocket`, including AI profiles. From the workflow side, a WebSocket leg still behaves like a normal PBX leg:

- it has `legId`
- it can be bridged
- it can play and record media
- it can participate in waits and queue/media orchestration

This is the key design point: WebSocket media is not a separate workflow subsystem. It is another leg type in the same daemon runtime.

## AI integration

The current release includes two AI-related paths:

### Attach Voice Agent

Attaches voice-agent orchestration to a live WebSocket leg.

This supports workflows where:

- **Create Dial** creates the AI-backed WebSocket leg
- **Bridge** connects it to a caller
- **Attach Voice Agent** adds memory and tools
- live tool calls are emitted into **AI Tool Call** trigger mode

### Invoke AI Tool

Exposes a node as a callable tool for a live voice-agent session.

## Installation

This package is intended for self-hosted n8n. You can install the package directly from a self‑hosted n8n web UI:

- in your self‑hosted n8n Web UI go to Settings → Community Nodes
- choose the option to install → paste `n8n-nodes-sip-pbx`

## Native runtime and supported targets

The package ships native prebuilds for:

- `linux-x64-glibc`
- `linux-x64-musl`
- `linux-arm64-glibc`
- `linux-arm64-musl`

## Package contents

Published package contents are intentionally small:

- `dist/`
- `bin/`
- `prebuilds/`
- `README.md`
- `LICENSE`
- runtime install helper

The repository contains the full source tree, docs, tests, and build scripts.

## License

`GPL-3.0-or-later`
