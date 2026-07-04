# The system behind these repos

Three repositories form **one production system**, in daily use by a whole recruiting
team today: the browser extension the recruiters work in, the Cloudflare edge backend
everything routes through, and the Rust-powered TV dashboard on the office wall. It
was designed and built by a working recruiter on that team, to solve the desk's
actual problems. Each repo stands alone as an engineering artefact — this page is the
map of how they fit together.

| Repo | Role |
|---|---|
| [**recruit-extension**](https://github.com/HukijG/recruit-extension) | The human interface: a zero-secrets MV3 Chrome extension (plus an early-stage mobile companion) — candidate sync from LinkedIn Recruiter, a cold-calling cockpit, SMS templates, and the office music remote, all in a side panel. |
| [**recruit-edge-backend**](https://github.com/HukijG/recruit-edge-backend) | The hub: five independently-deployed Cloudflare Workers — the RecruiterFlow ↔ Dialpad/Calendar/Krisp/Apollo integration core, the extension/PWA API, an MCP server for AI-assistant access, an observability sidecar, and the music-control worker. |
| [**recruit-tv-dashboard**](https://github.com/HukijG/recruit-tv-dashboard) | The physical endpoint: a custom Rust PCM audio-streaming engine + live KPI dashboard on a 4K office-TV kiosk, with an embedded Tailscale node for private routing. |

## The control plane — extension → backend → TV

The extension is a **thin client by design**: it holds no API keys and talks to
nothing but the backend. Candidate sync, Dialpad calls and SMS, call stats, cloud
SMS templates — and the OAuth identity itself — all route through
recruit-edge-backend's main worker.

Music rides the same pattern one hop further. Every recruiter's extension carries a
full remote-control surface (transport, volume, search, playlists); commands go to
the backend's **music worker**, where a shared WebSocket-Hibernation Durable Object
serialises everyone's commands, rate-limits them in four modes, and forwards them to
the TV kiosk's remote API. The same Durable Object fans the TV's now-playing state
back out to every connected extension — so the whole team collaboratively controls
one office TV, and everyone's side panel agrees about what's playing. The rate
limiter is tuned to the TV's real bottleneck (commands that start new audio force a
playback-buffer flush and re-stream), which is the tell that this worker exists *for*
the dashboard, not beside it.

The loop is visible in
[recruit-tv-dashboard's demo video](https://github.com/HukijG/recruit-tv-dashboard/blob/dev/docs/media/extension-remote-demo.mp4):
the extension side panel drives search, queue, and transport while the TV follows.

## The data plane — KPIs and sync

The backend is the primary RecruiterFlow ↔ Dialpad sync hub: webhooks in, writes
fanned back out, with a thin-immutable D1 read cache and Durable-Object coordination
where consistency bites. The dashboard's KPI half polls RecruiterFlow + Dialpad REST
directly on its own cadences, and the backend's stage-movement stats plane pushes
weekly CV-sent / first-interview aggregates to the dashboard over a small frozen
wire contract (with a legacy Cloudflare Worker WebSocket as fallback transport).

## One identity perimeter

A single Cloudflare Access (Zero Trust) OAuth application fronts every user-facing
surface: the extension and mobile PWA sign in once and reach both the main worker
and the music worker with the same identity; the MCP surface validates the same JWTs.
The music worker deliberately reuses that existing perimeter and the team's existing
CF deploy pipeline instead of standing up separate infrastructure — while staying
hard-isolated from the sync core (no service bindings, no shared database, JWT-only),
so the control plane can never touch the business-critical hub.

## Related

[**saas-taxonomy-classifier**](https://github.com/HukijG/saas-taxonomy-classifier)
is a standalone ML system by the same author (a B2B-SaaS taxonomy classifier trained
and evaluated on consumer hardware); the company taxonomy and labelled dataset it
produces feed the recruiting tooling's company-targeting.
