const CRICKETDATA_API = 'https://api.cricapi.com/v1';
const CRICINFO_RSS = 'https://static.cricinfo.com/rss/livescores.xml';

// Three sources, same output shape: { name, status, innings: [{ label, r, w, o }], ended, fetchedAt }.
//   cricbuzz (default): Cricbuzz's match JSON (CRICBUZZ_MATCH_ID), every ~12 s; overs, batters, bowler, run rates.
//   cricinfo-rss: ESPNcricinfo's public live-scores feed, refreshed every ~30 s, no key; runs + wickets, no overs.
//     Also the fallback after 5 Cricbuzz failures in a row.
//   cricketdata: CricketData.org API (needs a key, free = 100 calls/day); includes overs but polls every ~2.5 min.
let delayMs = Math.max(0, Number(process.env.SCORE_DELAY_SECONDS ?? 20)) * 1000;
// Host's "sync" control: hold score updates back so they line up with the stream.
export function setScoreDelay(seconds) {
  delayMs = Math.max(0, Math.min(180, Number(seconds) || 0)) * 1000;
  return delayMs / 1000;
}
export const getScoreDelay = () => delayMs / 1000;

export function startScore(onUpdate) {
  const source = (process.env.SCORE_SOURCE || 'cricbuzz').trim();
  let fetchScore = source === 'cricketdata' ? cricketData() : source === 'cricinfo-rss' ? cricinfoRss() : cricbuzz();
  if (!fetchScore) return;
  // If Cricbuzz keeps failing (blocked, down), fall back to the Cricinfo feed instead of going dark.
  let failures = 0;
  let fellBack = false;

  const defaultPoll = { cricketdata: 150, 'cricinfo-rss': 30 }[source] ?? 12;
  const minPoll = { cricketdata: 60, 'cricinfo-rss': 20 }[source] ?? 8;
  const pollMs = Math.max(minPoll, Number(process.env.POLL_SECONDS) || defaultPoll) * 1000;
  const kickoff = Date.parse(process.env.KICKOFF_UTC || '');
  let first = true;
  let ended = false;

  const publish = (s) => setTimeout(() => onUpdate({ ...s, delayed: delayMs / 1000 }), s.error ? 0 : delayMs);

  async function tick() {
    const now = Date.now();
    const inWindow = !kickoff || (now > kickoff - 15 * 60e3 && now < kickoff + 5 * 3600e3);
    // Always poll once at startup so the source can be checked; after that, only during the match.
    if (!first && (!inWindow || ended)) return;
    first = false;
    let s;
    try {
      s = await fetchScore();
    } catch (e) {
      s = { error: `Score source unreachable (${e.message}).` };
    }
    failures = s.error ? failures + 1 : 0;
    if (failures >= 5 && source === 'cricbuzz' && !fellBack) {
      fellBack = true;
      fetchScore = cricinfoRss();
      console.log(`[score] Cricbuzz failed 5 times (${s.error}); switching to the Cricinfo feed`);
      s = { error: 'Cricbuzz stopped answering, so the scoreboard switched to the Cricinfo feed (scores only).' };
    }
    if (!s.error) ended = !!s.ended;
    publish(s.error ? s : { ...s, fetchedAt: Date.now() });
  }

  tick();
  setInterval(tick, pollMs);

  function cricketData() {
    const key = (process.env.CRICKETDATA_API_KEY || '').trim();
    if (!key) {
      onUpdate({ error: 'Scoreboard off: add CRICKETDATA_API_KEY to .env and restart.' });
      return null;
    }
    const matchId = (process.env.MATCH_ID || '').trim();
    const team = (process.env.MATCH_TEAM || 'India').toLowerCase();
    const series = (process.env.MATCH_SERIES || 'Asian Games').toLowerCase();

    return async () => {
      const url = matchId
        ? `${CRICKETDATA_API}/match_info?apikey=${key}&id=${encodeURIComponent(matchId)}`
        : `${CRICKETDATA_API}/currentMatches?apikey=${key}&offset=0`;
      const res = await fetch(url);
      const body = await res.json();
      if (body.status !== 'success') return { error: `Score API: ${body.reason || body.status || res.status}` };

      const matches = matchId ? [body.data] : body.data || [];
      const candidates = matches.filter(
        (m) => m && (matchId || ((m.teams || []).some((t) => t.toLowerCase().includes(team)) && (m.name || '').toLowerCase().includes(series)))
      );
      const match = candidates.find((m) => m.matchStarted && !m.matchEnded) || candidates[0];
      if (!match) return { error: `No ${process.env.MATCH_SERIES || 'Asian Games'} match with ${process.env.MATCH_TEAM || 'India'} listed yet.` };
      return {
        name: match.name,
        status: match.status,
        innings: (match.score || []).map((s) => ({ label: s.inning, r: s.r, w: s.w, o: s.o })),
        ended: !!match.matchEnded,
      };
    };
  }

  // Cricbuzz match-centre JSON (the feed its own site uses): batters, bowlers, overs, result.
  function cricbuzz() {
    const matchId = (process.env.CRICBUZZ_MATCH_ID || '').trim();
    if (!matchId) {
      onUpdate({ error: 'Scoreboard off: set CRICBUZZ_MATCH_ID in .env.' });
      return null;
    }
    return async () => {
      const res = await fetch(`https://www.cricbuzz.com/api/mcenter/comm/${matchId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (watch-party scoreboard)', Accept: 'application/json' },
      });
      if (!res.ok) return { error: `Cricbuzz returned HTTP ${res.status}.` };
      return normalizeCricbuzz(await res.json());
    };
  }

  function cricinfoRss() {
    const matchId = (process.env.CRICINFO_MATCH_ID || '').trim();
    const team = (process.env.MATCH_TEAM || 'India').toLowerCase();
    const opponent = (process.env.MATCH_OPPONENT || 'Pakistan').toLowerCase();

    return async () => {
      const res = await fetch(CRICINFO_RSS, { headers: { 'User-Agent': 'watch-party-scoreboard/1.0' } });
      if (!res.ok) return { error: `Cricinfo feed returned HTTP ${res.status}.` };
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
        title: decode(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''),
        guid: it.match(/<guid>([\s\S]*?)<\/guid>/)?.[1] || '',
      }));
      const item =
        items.find((i) => matchId && i.guid.includes(`/${matchId}.`)) ||
        items.find((i) => i.title.toLowerCase().includes(team) && i.title.toLowerCase().includes(opponent));
      if (!item) return { error: `${process.env.MATCH_TEAM || 'India'} v ${process.env.MATCH_OPPONENT || 'Pakistan'} isn't in the Cricinfo feed right now.` };

      const sides = item.title.split(/\s+v\s+/).map(parseSide);
      const batting = sides.find((s) => s.batting);
      return {
        name: sides.map((s) => s.team).join(' v '),
        status: batting ? `${batting.team} batting` : sides.some((s) => s.r != null) ? 'Innings break or result' : 'Not started',
        innings: sides.filter((s) => s.r != null).map((s) => ({ label: s.team, r: s.r, w: s.w, o: null, batting: s.batting })),
        ended: false, // the feed carries no result; the poll window ends polling instead
      };
    };
  }
}

export function normalizeCricbuzz(j) {
  const mh = j.matchHeader || {};
  const ms = j.miniscore || null;
  const teams = [mh.team1, mh.team2].filter(Boolean);
  const teamName = (id, fallback) => teams.find((t) => t.id === id)?.name || fallback;
  const ended = mh.state === 'Complete' || !!mh.result?.resultType;
  const list = [...(ms?.matchScoreDetails?.inningsScoreList || [])].sort((a, b) => a.inningsId - b.inningsId);
  const innings = list.map((i) => ({
    label: teamName(i.batTeamId, i.batTeamName),
    r: i.score,
    w: i.wickets,
    o: i.overs,
    batting: !ended && !!ms && i.inningsId === ms.inningsId,
  }));
  const bat = (b, onStrike) => b?.name && { name: b.name, r: b.runs, b: b.balls, fours: b.fours, sixes: b.sixes, onStrike };
  const bowl = (b) => b?.name && { name: b.name, overs: b.overs, maidens: b.maidens, runs: b.runs, wickets: b.wickets };
  const bowlers = [bowl(ms?.bowlerStriker), bowl(ms?.bowlerNonStriker)].filter(Boolean);
  const cur = bowlers[0];
  return {
    name: teams.map((t) => t.name).join(' v ') || 'Match',
    status: mh.status || ms?.status || '',
    state: mh.state,
    innings,
    ended,
    winner: mh.result?.winningTeam || null,
    detail: ms && !ended
      ? {
          overs: ms.overs,
          batters: [bat(ms.batsmanStriker, true), bat(ms.batsmanNonStriker, false)].filter(Boolean),
          bowler: cur && { name: cur.name, figures: `${cur.overs}-${cur.maidens}-${cur.runs}-${cur.wickets}` },
          bowlers,
          crr: ms.currentRunRate,
          rrr: ms.requiredRunRate || null,
          target: ms.target || null,
          recent: ms.recentOvsStats || '',
          lastWicket: ms.lastWicket || '',
        }
      : null,
  };
}

// "India 142/3 *" -> { team: 'India', r: 142, w: 3, batting: true }; "Pakistan" -> { team, r: null }
export function parseSide(side) {
  const batting = side.includes('*');
  const scores = [...side.matchAll(/(\d+)(?:\/(\d+))?(d)?/g)];
  const last = scores.at(-1);
  const team = side.replace(/\s*(\d+(\/\d+)?d?\s*(&\s*)?|\*)+\s*$/, '').trim();
  return { team, batting, r: last ? Number(last[1]) : null, w: last ? (last[2] != null ? Number(last[2]) : 10) : null };
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
}
