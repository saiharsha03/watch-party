# watch-party

A small self-hosted cricket watch party. One host shares a browser tab (screen and tab audio) over WebRTC, friends join from a link, and everyone gets a live scoreboard, a voice and camera call, chat, reactions, celebrations and a prediction game (guess the runs in each over, plus pre-match picks, with one shared leaderboard). It runs from a single `docker compose up` on the host's own computer, and a cloudflared quick tunnel lets friends reach it without port forwarding or an account.

The page copy, squads and celebrations ship set up for an India v Pakistan match (the Asian Games final it was written for). See [Adapting it to another match](#adapting-it-to-another-match).

## Features

- Screen share with tab audio from the host's browser to every viewer, peer to peer over WebRTC. Each viewer gets their own connection, and bitrate adapts to that viewer's network. The host sees a live readout of resolution, frame rate and bitrate.
- Live scoreboard polled server-side from Cricbuzz (default), the ESPNcricinfo RSS feed, or the CricketData.org API. With Cricbuzz it also shows batters, bowler, current and required run rate, and target.
- Scoreboard delay (default 20 s, host can change it from 0 to 180 s) so scores do not spoil the stream.
- Voice call and optional camera (320x240, 15 fps), a full mesh where everyone connects to everyone, with a speaking indicator.
- Chat (300 characters per message, last 200 kept on screen) and eight emoji reactions that float over the video.
- Celebrations (four, six, wicket, win, plus fifty and hundred banners for MATCH_TEAM batters) that anyone can trigger by button and that fire automatically from the score feed.
- Over game: guess the runs in an over (0 to 40). The host opens, locks and resolves overs, or the Cricbuzz feed does it automatically. An exact guess scores 1 point. Guesses stay hidden until the over is locked.
- Pre-match picks: winner, first-innings total bucket, powerplay and 10-over score buckets, top run-scorer, most wickets. Picks are hidden and lock at kickoff. A correct pick scores 1 point. Winner and first-innings total can resolve automatically from the feed, and with Cricbuzz so can the rest.
- Fullscreen "theater" mode that keeps chat, cameras and celebrations on screen.
- Optional TURN relay so video works on cellular and carrier-NAT connections.
- A local-only admin endpoint for pushing chat, scoreboard detail, pick answers, over actions and celebrations from the host machine.

## How it works

```
                          host computer (docker compose)
  +------------------------------------------------------------------+
  |                                                                  |
  |  127.0.0.1:8090 --> web (nginx) --+--> /     static site/        |
  |                        ^          |                              |
  |  tunnel (cloudflared) -+          +--> /ws   signal (Node, :8080)|
  |                                                    ^   |        |
  |  127.0.0.1:8091 --> signal :8081 (POST /admin)-----+   |        |
  +----------------------------------------------------|---|--------+
                                                       |   |
   host browser  <---- WebSocket (signalling, chat, game) --->  viewers
        |                                                          |
        +------------ WebRTC video/audio, peer to peer ------------+
                       (STUN, or relayed through TURN)

   signal --polls--> Cricbuzz / Cricinfo RSS / CricketData  (scoreboard)
   signal --asks---> Cloudflare TURN API (only if configured)
```

- `web` is nginx. It serves `site/` and proxies `/ws` to the signal server. Its port 80 is published only on `127.0.0.1:8090`.
- `signal` is a Node WebSocket server (`ws`). It relays WebRTC offers, answers and ICE candidates, and carries chat, reactions, game state and call state. It also polls the score feed and runs the game logic. Video and audio never pass through it.
- `tunnel` is cloudflared in quick-tunnel mode, pointed at `http://web:80`. It gives friends a random `https://<random>.trycloudflare.com` URL.
- The host opens `http://localhost:8090`. The page treats a browser on `localhost` as the host, and the server checks the same thing (see [Security model](#security-model)).
- A viewer connects to the host over WebRTC. Voice and camera calls are separate peer connections between every pair of people in the call.
- Source layout: `signal/server.js` (sockets, game, admin), `signal/score.js` (feeds), `signal/auto.js` (Cricbuzz-driven automation), `signal/prematch.js` (picks and squads), `signal/ice.js` (STUN/TURN), `site/` (the page).

## Quick start

Needs Docker with Compose, and Chrome or another Chromium browser on the host (tab audio capture is a Chromium feature).

1. Copy the example settings. This step is required: `docker-compose.yml` reads `.env`, and Compose will not start `signal` without it.

   ```sh
   cp .env.example .env
   ```

2. Edit `.env`. At minimum set `CRICBUZZ_MATCH_ID` (the number in the Cricbuzz match URL, `cricbuzz.com/live-cricket-scores/<id>/...`), `MATCH_TEAM`, `MATCH_OPPONENT` and `KICKOFF_UTC`. The example `KICKOFF_UTC` is a placeholder: set it to your match's start time. A time in the past locks match picks as soon as the server starts. See [Configuration](#configuration).

3. Build and start:

   ```sh
   docker compose up -d --build
   ```

4. Get the friends' link. The tunnel prints its URL in its logs. Re-run this if nothing shows up yet, since the tunnel takes a few seconds to connect:

   ```sh
   docker compose logs tunnel | grep trycloudflare.com
   ```

   On Windows PowerShell use `docker compose logs tunnel | Select-String trycloudflare.com`.

5. Open `http://localhost:8090` on the same computer, enter a name, and click **Open room**. Click **Share screen**, pick the tab with the stream, and tick **Share tab audio**.

6. Send friends the `https://<random>.trycloudflare.com` link from step 4. They enter a name and join.

To test as a viewer yourself, open `http://localhost:8090/?view` in a private window. To stop everything, run `docker compose down`. To follow server logs (joins, connection paths, score feed errors), run `docker compose logs -f signal`.

## Configuration

Settings live in `.env` (copied from `.env.example`). `.env` is git-ignored. Every variable is optional in the sense that the server starts without it, but the scoreboard needs the ID or key for the source you choose.

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `SCORE_SOURCE` | No | `cricbuzz` | Scoreboard source: `cricbuzz`, `cricinfo-rss` or `cricketdata`. Any other value is treated as `cricbuzz`. |
| `CRICBUZZ_MATCH_ID` | Yes for `cricbuzz` | blank | The number in the Cricbuzz match URL. If blank, the scoreboard shows "Scoreboard off" and does not start. |
| `AUTO_GAME` | No | `true` | Drives the over game, celebrations and pick answers from the Cricbuzz feed. Set `false` to run everything by hand. Only has an effect with Cricbuzz data. |
| `CRICINFO_MATCH_ID` | No | blank | ESPNcricinfo match ID, used only by `cricinfo-rss` (including the fallback). If blank, the feed item is found by matching `MATCH_TEAM` and `MATCH_OPPONENT` in the title. |
| `MATCH_TEAM` | No | `India` | The team the party supports. Used for pick options, auto-celebrations (its boundaries, the other side's wickets, its win), team matching in feeds, and the pick squad key. Case-insensitive substring match against innings labels. |
| `MATCH_OPPONENT` | No | `Pakistan` | The other team. Used for pick options and squads, and to find the match in the Cricinfo feed. |
| `AUTO_BOUNDARIES` | No | `true` | For totals-only feeds (Cricinfo RSS, CricketData, or after a Cricbuzz fallback): celebrate a four or six when `MATCH_TEAM`'s total rises by exactly 4 or 6 with no wicket. Set `false` if it misfires. Not used while Cricbuzz is working, which counts each batter's fours and sixes instead. |
| `CRICKETDATA_API_KEY` | Yes for `cricketdata` | blank | Key from cricketdata.org. The free plan allows 100 calls a day. If blank, the scoreboard shows "Scoreboard off". |
| `TURN_URLS` | No | blank | Comma-separated TURN URLs from any provider, for example `turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp`. When set, it takes priority over the Cloudflare option. |
| `TURN_USERNAME` | With `TURN_URLS` | blank | Fixed TURN username. Sent to every browser that joins. |
| `TURN_CREDENTIAL` | With `TURN_URLS` | blank | Fixed TURN password. Sent to every browser that joins. |
| `CF_TURN_KEY_ID` | No | blank | Cloudflare TURN key ID. Used only if `TURN_URLS` is blank. |
| `CF_TURN_API_TOKEN` | With `CF_TURN_KEY_ID` | blank | Cloudflare TURN API token. Stays on the server. |
| `MATCH_ID` | No | blank | Exact match ID from the CricketData API. Blank means find the match by `MATCH_TEAM` and `MATCH_SERIES`. Only used by `cricketdata`. |
| `MATCH_SERIES` | No | `Asian Games` | Text that must appear in the CricketData match name when `MATCH_ID` is blank. Only used by `cricketdata`. |
| `KICKOFF_UTC` | Recommended | none in code (placeholder `2030-01-01T12:00:00Z` in `.env.example`) | Kickoff time, ISO 8601 in UTC. Pre-match picks lock at this time. Score polling runs from 15 minutes before to 5 hours after (plus one poll at startup). If blank, picks never auto-lock and polling never stops. If in the past, picks lock at startup and polling stops after the first poll. |
| `POLL_SECONDS` | No | blank (source default) | Score poll interval. Defaults are Cricbuzz 12 s, Cricinfo RSS 30 s, CricketData 150 s. Minimums are enforced: 8 s, 20 s and 60 s. |
| `SCORE_DELAY_SECONDS` | No | `20` | How far scores are held back so they do not spoil the stream. The host can change it live (0 to 180 s). |
| `HOST_KEY` | No | blank | Secret that lets a browser on another computer host. At least 12 characters. Blank means hosting only from `localhost`. See below. |
| `ADMIN_KEY` | No | blank | Key for the local admin endpoint, sent as `X-Admin-Key`. While blank, the endpoint refuses every request. |

The signal server also reads `PORT` (WebSocket port, default `8080`) and `ADMIN_PUBLIC_PORT` (the host-side admin port it expects in the `Host` header, default `8091`). Both match `docker-compose.yml`. Change them only if you change the compose port mappings too. The admin HTTP listener itself is fixed at container port `8081`.

### Hosting from another machine (HOST_KEY)

By default only a browser on the computer running the containers (opening `http://localhost:8090`) can host. To host from a different computer:

1. Generate a key of at least 12 characters, for example `openssl rand -hex 16`, and put it in `.env` as `HOST_KEY`.
2. Restart the signal server: `docker compose up -d --force-recreate signal`.
3. On the other computer, open `https://<random>.trycloudflare.com/#host=<HOST_KEY>`.

The key is in the URL fragment (after `#`), so the browser does not send it in the request line or headers and it does not appear in nginx or tunnel request logs. It is sent once over the WebSocket in the join message. Only one host is allowed at a time: a second host connecting replaces the first, which is told the room was opened in another tab. Do not share the host link.

### TURN options

Without a relay, WebRTC uses STUN only (`stun.cloudflare.com` and `stun.l.google.com`). That works for most home Wi-Fi but often fails on cellular and carrier-NAT connections, where video needs a TURN relay.

- **Option A, any TURN provider.** Set `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL`. The username and password are fixed and are handed to every browser that joins, so use a throwaway or quota-limited account.
- **Option B, Cloudflare TURN.** Set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`. The server calls Cloudflare's API and gives browsers short-lived credentials (24 hour lifetime, cached for 12 hours), so the long-lived token never reaches a browser. If the call fails, it logs the error and falls back to STUN only.

Check `docker compose logs signal` after a viewer connects. Each connection logs how it was made: `host` (same network), `srflx` (direct over the internet) or `relay` (through TURN).

### Admin endpoint

`signal` publishes an HTTP endpoint on `127.0.0.1:8091` (container port 8081) so a script or an assistant on the host machine can push live updates. It is `POST /admin` with a JSON body and these optional keys, which can be combined:

| Key | Value | Effect |
| --- | --- | --- |
| `chat` | string | Posts a chat message (up to 300 characters) as a bot named "Claude". |
| `detail` | object | Sets the extra scoreboard line: `overs`, `batters` (`name`, `r`, `b`, `onStrike`), `bowler` (`name`, `figures`), `note`. |
| `answer` | `{ "qid": "...", "answer": "..." }` | Sets the correct answer for a pick question (`winner`, `first`, `pp`, `ten`, `runs`, `wkts`). The answer must be one of that question's options. |
| `over` | `{ "open": 7 }`, `{ "lock": true }` or `{ "resolve": 9 }` | Opens, locks or resolves an over round. |
| `celebrate` | `four`, `six`, `wicket` or `win` | Triggers a celebration for everyone. |

The response lists what was applied. Example:

```sh
curl -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"chat":"Hello","celebrate":"four"}' http://127.0.0.1:8091/admin
```

It refuses the request unless all of these hold: `ADMIN_KEY` is set in `.env`, the `Host` header is exactly `127.0.0.1:8091` or `localhost:8091`, the `X-Admin-Key` header matches (compared in constant time), the method is `POST` to `/admin`, and `Content-Type` is `application/json`. Bodies over 64 KiB are dropped. Generate a key with `openssl rand -hex 24`. Note that a `detail` pushed by hand is replaced by the next Cricbuzz poll.

## Adapting it to another match

Settings in `.env` cover the match itself: `CRICBUZZ_MATCH_ID`, `MATCH_TEAM`, `MATCH_OPPONENT`, `KICKOFF_UTC` (and `MATCH_SERIES` or `MATCH_ID` for CricketData). The names, text and artwork are hard-coded for the Asian Games final and need editing in the files:

- `signal/prematch.js`: the `SQUADS` lists (they feed the top run-scorer and most wickets options, keyed by `MATCH_TEAM` and `MATCH_OPPONENT`), and the question text, for example "Who wins the gold?" and the bucket ranges.
- `signal/auto.js`: the powerplay and 10-over bucket ranges, if you change them in `prematch.js` (the two files must agree, because the automation answers with a bucket label).
- `site/index.html`: the page title and heading ("Final Night"), the subtitle, the join card text ("India's gold medal final"), and the "India moment" label.
- `site/app.js`: the celebration text (`CELEBRATIONS`, including "India win the Asian Games"), `CONFETTI_COLORS`, the "Willow TV" hints shown to the host, and the hard-coded `'india'` check used for fifty and hundred banners.
- `signal/server.js` and `site/app.js`: the `REACTIONS` list, which includes the Indian and Pakistani flags. The two lists must match, because the server only relays reactions that are in its own list.
- `site/style.css`: colours and layout.

After editing `site/` files, reload the page (nginx serves them from disk with `no-store`). After editing `signal/` files, run `docker compose up -d --build signal`.

## Security model

This is built for a private party among people you invited, not for the open internet. Be clear about what is exposed.

- **What is public.** Anyone who has the tunnel link can open the page, join the room, chat, react, join the call, see the stream and the scoreboard, and make picks and guesses. There is no login, and names are not verified: anyone can type any name. Treat the link like a private invitation.
- **Port 8090 is `127.0.0.1` only.** The server decides who the host is by the `Host` and `Origin` of the WebSocket connection: both must be `localhost` or `127.0.0.1`. Visitors arriving through the tunnel carry the tunnel hostname, so they are viewers. If port 8090 were published on a LAN address or a public VPS, the `Host` header is client-controlled there, and the check would no longer be a trustworthy proof that someone is on the host machine. That is why compose binds it to loopback. If you must expose it, set `HOST_KEY` and put your own access control in front.
- **Cross-site protection.** A WebSocket is accepted only when the `Origin` host equals the `Host` it was served from, so another website cannot open a connection through a visitor's browser. Hosting additionally requires an origin of `localhost` or `127.0.0.1`, so a malicious page open in the host's browser cannot take over the room. These checks stop browsers, not scripts: a non-browser client that can reach the server can send any headers it likes.
- **HOST_KEY.** Compared with `===` (not constant time) over the WebSocket, once, at join. It lives in the URL fragment so it is kept out of server and tunnel logs, but it does stay in the host browser's history and bookmarks. Anyone with the full host link can host. The key is not rate limited.
- **TURN credentials.** With `TURN_URLS`, the username and password are visible to everyone who joins (open the browser dev tools). With Cloudflare TURN, each joiner receives a short-lived credential that is valid for 24 hours and can relay traffic on your Cloudflare account until it expires. Use a throwaway or quota-limited account either way.
- **Admin endpoint.** Bound to `127.0.0.1:8091` on the host, refused while `ADMIN_KEY` is blank, requires a literal local `Host` (blocks DNS rebinding), a constant-time key check, and `application/json` (which a web page cannot send cross-origin without a preflight that is never answered). It is plain HTTP on loopback, and the key is in the compose environment, so anyone who can run processes on the host machine can use it. It is not exposed through the tunnel or nginx.
- **Rate limits and size caps.** Chat, reactions, celebrations, game actions and log messages are limited to 8 per 2 seconds per connection. Signalling messages are limited to 300 per second. WebSocket messages over 64 KiB are rejected. Names are cut to 24 characters, chat to 300. There is no cap on the number of connections and no per-IP limit.
- **No secrets in the browser.** The Cloudflare TURN token, the CricketData key and the admin key never leave the server. They are in `.env` and in the container environment.
- **In-memory state.** Leaderboard, picks, guesses and the current round live in the signal server's memory. Nothing is written to disk. Restarting `signal` clears them. Chat is not stored on the server at all.
- **Privacy.** Video is peer to peer, but peers learn each other's IP addresses (a normal part of WebRTC), unless relayed by TURN. The page loads fonts from Google Fonts, so viewers' browsers contact Google. The server logs each join (name, role, rough device) and each connection's network path to `docker compose logs signal`.
- **Images.** `nginx:alpine` and `cloudflare/cloudflared:latest` are not pinned to a version. Pin them if you want repeatable builds.

## Troubleshooting

- **A friend sees "Couldn't connect to the stream", or video works on Wi-Fi but not on cellular.** Direct WebRTC is blocked by their network. Configure a TURN relay (see [TURN options](#turn-options)). `docker compose logs signal` shows whether their connection tried and failed, and whether a relay was configured.
- **No sound for friends.** In the share dialog, pick the tab (not a window or screen) and tick **Share tab audio**. If you shared without it, click **Change tab** and share again. Viewers whose browser blocks autoplay with sound see a **Tap for sound** button.
- **The scoreboard is blank or says "Scoreboard off".** Set `CRICBUZZ_MATCH_ID` (or the key for the source you picked) in `.env` and run `docker compose up -d --force-recreate signal`. A restart is needed because the settings are read at startup.
- **ESPNcricinfo is blocked or rate-limited.** That feed often is, which is why Cricbuzz is the default. If Cricbuzz fails 5 times in a row, the server switches to the Cricinfo RSS feed for the rest of the run (runs and wickets only, no batters or overs) and shows a notice. `cricketdata` is the keyed alternative. The feeds are unofficial and can change or disappear without notice.
- **The scoreboard stopped updating.** Polling only runs from 15 minutes before to 5 hours after `KICKOFF_UTC`, and stops once the match is marked ended. Check that `KICKOFF_UTC` is correct and in UTC.
- **Match picks are already locked.** `KICKOFF_UTC` is in the past. Set it to the match's start time and restart `signal`.
- **The tunnel link changed.** A quick tunnel gets a new random URL every time the `tunnel` container starts, so re-share the link after any restart of that container. For a fixed hostname, replace the quick tunnel with a named Cloudflare tunnel.
- **"That host link is wrong or out of date".** `HOST_KEY` is blank, shorter than 12 characters, or does not match, or you opened the tunnel link without `#host=...`. Opening the page from `http://localhost:8090` needs no key.
- **Friends are not getting live updates after the host's laptop sleeps.** Sockets reconnect automatically, and a page that comes back within 8 seconds keeps its video. Longer gaps need the host to click **Share screen** again.
- **Host browser warns about CPU or bandwidth.** The host note under the share button reports when the encoder or a friend's connection is limiting quality. Closing other apps and enabling hardware acceleration helps. Each viewer is a separate encode, so a large room needs a strong upload connection.

## Limitations

- Built and tuned for T20 matches: the over game goes up to over 20, and the picks assume T20 score ranges.
- The host must use a Chromium browser for tab audio. Viewers need a browser with WebRTC support.
- One room, one host, one match per server. State is in memory only.
- The host sends a separate video stream to each viewer, so the room size is limited by the host's CPU and upload bandwidth. The voice and camera call is also a full mesh, which gets heavy beyond a handful of people.
- Score feeds are unofficial public endpoints. Use them for personal, low-volume use, and expect that they can break. The Cricbuzz feed is read from a JSON endpoint that its own site uses, and may be restricted by its terms.
- Auto-resolution of picks and the over game depends on the feed's data shape. If an update skips the end of an over, the game says so in chat and leaves that over for the host to score. Ties for top scorer or most wickets are left to the host.
- Page text and squads are specific to one match until you edit them.
- There are no automated tests.
- A quick tunnel has no uptime guarantee and a random URL. The `tunnel` container and the whole stack stop when the host computer sleeps or goes offline.

## Contributing

Issues and pull requests are welcome. Keep changes small and in the existing style (plain JavaScript, no build step for the page, no framework). For the signal server, run `docker compose up --build signal` and exercise the change with a host tab and a `?view` tab. Do not commit `.env` or any key. If you change the squads, reaction lists or text, mention the match it is for.

## License

MIT, see [LICENSE](LICENSE).

## Use responsibly

Only share streams you have the right to share. Check the terms of your broadcaster, the score feed providers and your TURN provider before running this for other people.
