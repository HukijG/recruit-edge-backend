# music-worker (`rf-music-remote`) — the music-control plane

**The distributed music remote for the office**: this worker bridges every
recruiter's Chrome extension ([recruit-extension](https://github.com/HukijG/recruit-extension))
to the music player on the office-TV kiosk
([recruit-tv-dashboard](https://github.com/HukijG/recruit-tv-dashboard)). A shared
Durable Object serialises and rate-limits the whole team's commands (transport,
volume, search, play/enqueue, playlists) on their way to the TV, and fans the TV's
now-playing snapshot back out to every connected extension over WebSockets — so
everyone's side panel agrees about what's playing on the wall.

It lives in this repo because it **piggybacks on the platform this repo already
provides** — the extension's Cloudflare Access auth perimeter and the team's CF
deploy pipeline — rather than standing up separate infrastructure. At the same time
it is **hard-isolated from the sync core**, an explicit design boundary so the
control plane can never touch the business-critical hub:

- Independent install root: own `package.json` / committed `package-lock.json`, own
  `wrangler.music.jsonc` (`"name": "rf-music-remote"`), own `src/`, `test/`, and
  `vitest.config.js`.
- **No** service binding to `rf-dialpad-sync-dev` or any sibling, **no** `USERS_DB`/D1
  binding, and observability is deliberately **waived** (no OTel). Auth is JWT-only.
  It cannot affect the live core workers.
- The command rate-limiter (four modes: throttle / burst / latest-wins / queue) is
  tuned to the TV's real bottleneck — commands that start new audio force the TV to
  flush its playback buffer and re-stream fresh PCM.

Full design reference: [`../docs/music-worker.md`](../docs/music-worker.md). The
system-level picture: [`../docs/ECOSYSTEM.md`](../docs/ECOSYSTEM.md).
