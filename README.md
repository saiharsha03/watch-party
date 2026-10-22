# watch-party

A small self-hosted cricket watch party. One host shares a browser tab (screen + tab audio) over WebRTC, friends join from a link, and everyone gets a live scoreboard, voice/camera call, chat, reactions, celebrations and a prediction game (guess the runs in each over, plus pre-match picks with a leaderboard).

- `site/`: static page served by nginx
- `signal/`: Node WebSocket signalling server, scoreboard poller and game logic
- `tunnel`: a cloudflared quick tunnel so friends can reach it without port forwarding

## Run

Needs Docker with Compose.

```sh
cp .env.example .env   # required; then fill it in (see below)
docker compose up -d --build
docker compose logs tunnel | grep trycloudflare.com
```

- Host: open `http://localhost:8090` on the machine running it, click **Share screen**, pick the stream tab and tick "Share tab audio".
- Friends: send them the `https://<random>.trycloudflare.com` link from the tunnel logs.
- Test as a viewer: `http://localhost:8090/?view` in a private window.

## Configure

All settings live in `.env` (see `.env.example` for every option).

- **Match**: set `CRICBUZZ_MATCH_ID` (the number in the Cricbuzz match URL), `MATCH_TEAM`, `MATCH_OPPONENT` and `KICKOFF_UTC`. The squads used for the player picks are hard-coded in `signal/prematch.js`; edit them for your match. The page copy (title, "India moment", "Gold!", flags, confetti colours) is written for the Asian Games India v Pakistan final; edit `site/index.html` and `site/app.js` for other matches.
- **TURN**: without a relay, video often fails on cellular or carrier-NAT connections. Either set `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL` from any TURN provider, or set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` for Cloudflare TURN (the server swaps the key for short-lived credentials, so it never reaches browsers). Blank = STUN only. With Option A the fixed username/password is sent to every browser that opens the link, so use a throwaway or quota-limited TURN account.
- **HOST_KEY**: lets you host from a computer other than the one running the containers. Set it to a random string of 12+ characters and open `https://<tunnel>/#host=<HOST_KEY>`. The key sits after `#`, so it never reaches server logs. Blank = hosting only from `localhost`.

## Notes

- **Tunnel**: a quick tunnel gets a new random URL every time the `tunnel` container starts, so re-share the link after a restart. It needs no Cloudflare account. For a fixed hostname, swap in a named tunnel.
- **Cricinfo blocked**: the ESPNcricinfo feed is often blocked or rate-limited (bot protection), so the default source is Cricbuzz. If Cricbuzz fails 5 times in a row the server falls back to the Cricinfo RSS feed (runs and wickets only). `cricketdata` is the keyed alternative.
- The score feeds are unofficial/public endpoints and can change without notice. Use them for personal, low-volume use.
- Port 8090 is bound to `127.0.0.1` only, because a request to it with `Host: localhost` counts as the host. Friends come in through the tunnel. Don't publish it on a LAN or VPS without `HOST_KEY` checks in front.
- Game state (leaderboard, picks) lives in memory; restarting `signal` clears it.
- `127.0.0.1:8091` is a local-only admin endpoint (`POST /admin`) for pushing match details, chat, answers and over-game actions from the host machine. It needs `ADMIN_KEY` set in `.env` (everything is refused while it is unset), a `Host` of exactly `127.0.0.1:8091` or `localhost:8091`, the key in an `X-Admin-Key` header, and `Content-Type: application/json`, e.g. `curl -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"chat":"Hello"}' http://127.0.0.1:8091/admin`. Generate a key with `openssl rand -hex 24`.
- Only share streams you have the right to share.

## License

MIT, see `LICENSE`.
