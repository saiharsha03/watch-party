// Runs the party off the Cricbuzz feed: celebrations, the over game, and match-pick answers.
// Works from consecutive (delayed) score snapshots, so it stays in step with the stream.

const PP_BUCKETS = ['Under 40', '40–49', '50–59', '60–69', '70+'];
const TEN_BUCKETS = ['Under 70', '70–84', '85–99', '100–114', '115+'];
const ppBucket = (r) => PP_BUCKETS[r < 40 ? 0 : r < 50 ? 1 : r < 60 ? 2 : r < 70 ? 3 : 4];
const tenBucket = (r) => TEN_BUCKETS[r < 70 ? 0 : r < 85 ? 1 : r < 100 ? 2 : r < 115 ? 3 : 4];

// "Shreyas Iyer" -> "Shreyas Iyer (IND)"; falls back to a unique surname match.
export function matchPlayer(name, options) {
  const n = name.toLowerCase().trim();
  const exact = options.filter((o) => o.toLowerCase().startsWith(`${n} (`));
  if (exact.length === 1) return exact[0];
  const surname = n.split(/\s+/).at(-1);
  const bySurname = options.filter((o) => o.toLowerCase().replace(/\s*\(.*\)$/, '').split(/\s+/).at(-1) === surname);
  return bySurname.length === 1 ? bySurname[0] : null;
}

export function createAuto({ team, celebrate, answer, over, say, questions }) {
  const ours = (label) => (label || '').toLowerCase().includes(team.toLowerCase());
  const batRuns = new Map(); // batter -> highest runs seen
  const bowlWkts = new Map(); // bowler -> highest wickets seen
  const overScore = new Map(); // `${inningsIdx}:${over}` -> innings total at end of that over
  let prev = null;
  const missed = new Set(); // overs whose exact end an update skipped
  let roundInn = null; // innings index the current auto round belongs to
  let finished = false;

  const opts = (id) => questions.find((q) => q.id === id)?.options || [];

  function overDone(idx, n, total, label) {
    if (overScore.has(`${idx}:${n}`)) return;
    overScore.set(`${idx}:${n}`, total);
    const before = n === 1 ? 0 : overScore.get(`${idx}:${n - 1}`);
    if (idx === 0 && n === 6) answer('pp', ppBucket(total));
    if (idx === 0 && n === 10) answer('ten', tenBucket(total));
    const r = over.round();
    if (r && r.over === n && roundInn === idx && r.phase !== 'done' && before != null) {
      if (r.phase === 'open') over.lock();
      over.resolve(total - before);
    }
    if (n < 20) {
      over.open(n + 1);
      roundInn = idx;
      say(`Over ${n + 1} (${label}) is open. Guess the runs!`);
    }
  }

  return function step(s) {
    if (!s || s.error || finished) return;
    const inns = s.innings || [];
    const idx = inns.findIndex((i) => i.batting);
    const cur = inns[idx];
    const prevIdx = prev?.innings?.findIndex((i) => i.batting) ?? -1;

    // Celebrations: India boundaries from each batter's 4s/6s count, opponent wickets from the total.
    if (prev?.detail && s.detail && cur && idx === prevIdx) {
      if (ours(cur.label)) {
        for (const b of s.detail.batters) {
          const old = prev.detail.batters.find((x) => x.name === b.name);
          if (!old) continue;
          if (b.sixes > old.sixes) celebrate('six');
          else if (b.fours > old.fours) celebrate('four');
        }
      } else if (cur.w > prev.innings[idx].w) {
        celebrate('wicket');
      }
    }

    // Player tracking for top run-scorer / most wickets.
    for (const b of s.detail?.batters || []) batRuns.set(b.name, Math.max(batRuns.get(b.name) || 0, b.r || 0));
    for (const b of s.detail?.bowlers || []) bowlWkts.set(b.name, Math.max(bowlWkts.get(b.name) || 0, b.wickets || 0));
    const lw = s.detail?.lastWicket?.match(/^(.+?)\s+(?:c\s|b\s|lbw|run out|st\s|hit wicket|retired).*?(\d+)\(\d+\)/);
    if (lw) batRuns.set(lw[1].trim(), Math.max(batRuns.get(lw[1].trim()) || 0, Number(lw[2])));

    // Toss done, no ball bowled yet: open over 1 now so people can guess before the first ball.
    if (!inns.length && s.state && s.state !== 'Preview' && !s.ended && !overScore.has('0:0')) {
      overScore.set('0:0', 0);
      over.open(1);
      roundInn = 0;
      say('Over 1 is open. Guess the runs before the first ball!');
    }

    // Innings ended (all out / 20 overs / chase over): settle a round left in that innings with its partial over,
    // then open over 1 of the chase straight away (the innings break is the guessing window).
    if (prevIdx >= 0 && (idx !== prevIdx || s.ended)) {
      const done = s.innings[prevIdx];
      const r = over.round();
      if (r && roundInn === prevIdx && r.phase !== 'done') {
        const before = overScore.get(`${prevIdx}:${r.over - 1}`);
        if (before != null) {
          if (r.phase === 'open') over.lock();
          over.resolve(done.r - before);
        }
      }
      if (!s.ended && prevIdx === 0 && !overScore.has('1:0')) {
        overScore.set('1:0', 0);
        over.open(1);
        roundInn = 1;
        say('Innings break! Over 1 of the chase is open. Guess the runs.');
      }
    }

    // Over game + powerplay / 10-over picks.
    if (cur) {
      const o = Number(cur.o) || 0;
      const r0 = over.round();
      if (o === 0 && !overScore.has(`${idx}:0`) && (!r0 || r0.phase === 'done' || roundInn !== idx)) {
        overScore.set(`${idx}:0`, 0);
        over.open(1);
        roundInn = idx;
        say(`Over 1 (${cur.label}) is open. Guess the runs!`);
      }
      if (Number.isInteger(o) && o > 0) overDone(idx, o, cur.r, cur.label);
      const r = over.round();
      if (r && roundInn === idx && r.phase !== 'done' && !Number.isInteger(o)) {
        // First ball of the over is bowled: lock guesses.
        if (r.phase === 'open' && Math.floor(o) === r.over - 1) over.lock();
        // An update skipped the end of this over, so its run count is unknown. Leave it to the host;
        // the game picks up again at the next over that ends cleanly.
        if (Math.floor(o) >= r.over && !missed.has(`${idx}:${r.over}`)) {
          missed.add(`${idx}:${r.over}`);
          if (r.phase === 'open') over.lock();
          say(`Missed the exact end of over ${r.over}, so the host can score it. Next over opens after this one.`);
        }
      }
    }

    // End of match: winner, top run-scorer, most wickets (ties are left to the host).
    if (s.ended) {
      finished = true;
      const w = s.winner && opts('winner').find((o) => s.winner.toLowerCase().includes(o.toLowerCase()));
      if (w) answer('winner', w);
      const top = (m) => {
        const max = Math.max(0, ...m.values());
        const names = [...m].filter(([, v]) => v === max && max > 0).map(([n]) => n);
        return names.length === 1 ? names[0] : null;
      };
      const tr = top(batRuns);
      const tw = top(bowlWkts);
      const trOpt = tr && matchPlayer(tr, opts('runs'));
      const twOpt = tw && matchPlayer(tw, opts('wkts'));
      if (trOpt) answer('runs', trOpt);
      if (twOpt) answer('wkts', twOpt);
      say(
        `Full time: ${s.status}.` +
          (trOpt ? '' : ' Top run-scorer is a tie or unclear, so the host picks it.') +
          (twOpt ? '' : ' Most wickets is a tie or unclear, so the host picks it.')
      );
    }
    prev = s;
  };
}
