// Pre-match predictions: everyone picks once when they join; picks lock at kickoff.
// Only a correct pick scores (+1). "winner" and "first" resolve from the score feed; the host sets the rest.
// Kept in memory: a server restart clears picks.

const TEAM = process.env.MATCH_TEAM || 'India';
const OPPONENT = process.env.MATCH_OPPONENT || 'Pakistan';

// Squads (playing XIs are only named at the toss). Source: olympics.com / icc-cricket.com squad lists.
const SQUADS = {
  [TEAM]: ['Shreyas Iyer', 'Abhishek Sharma', 'Sanju Samson', 'Ishan Kishan', 'Shivam Dube', 'Tilak Varma', 'Axar Patel', 'Washington Sundar', 'Vipraj Nigam', 'Ravi Bishnoi', 'Jasprit Bumrah', 'Yash Thakur', 'Arshdeep Singh', 'Vaibhav Sooryavanshi'],
  [OPPONENT]: ['Sahibzada Farhan', 'Abdul Samad', 'Abrar Ahmed', 'Ahmed Daniyal', 'Akif Javed', 'Ali Raza', 'Arafat Minhas', 'Haider Ali', 'Hasan Nawaz', 'Maaz Sadaqat', 'Mohammad Salman Mirza', 'Saad Masood', 'Saim Ayub', 'Sufyan Moqim', 'Usman Khan'],
};
const PLAYERS = Object.entries(SQUADS).flatMap(([team, names]) => names.map((n) => `${n} (${team.slice(0, 3).toUpperCase()})`));

const FIRST_BUCKETS = ['Under 140', '140–159', '160–179', '180–199', '200+'];
const bucket = (r) => FIRST_BUCKETS[r < 140 ? 0 : r < 160 ? 1 : r < 180 ? 2 : r < 200 ? 3 : 4];

export const QUESTIONS = [
  { id: 'winner', q: 'Who wins the gold?', options: [TEAM, OPPONENT], auto: true },
  { id: 'first', q: '1st-innings total', options: FIRST_BUCKETS, auto: true },
  { id: 'pp', q: 'Powerplay score (team batting first, after 6 overs)', options: ['Under 40', '40–49', '50–59', '60–69', '70+'] },
  { id: 'ten', q: 'Score at 10 overs (team batting first)', options: ['Under 70', '70–84', '85–99', '100–114', '115+'] },
  { id: 'runs', q: 'Top run-scorer', options: PLAYERS },
  { id: 'wkts', q: 'Most wickets', options: PLAYERS },
];
// No prototype, so a client-sent qid like "constructor" finds nothing.
const byId = Object.assign(Object.create(null), Object.fromEntries(QUESTIONS.map((q) => [q.id, q])));

const picks = new Map(); // viewer id -> { name, answers: { qid: option } }
const answers = {}; // qid -> correct option
let locked = false;

export function lockPicks(on = true) {
  locked = on;
}

export function preState() {
  return {
    questions: QUESTIONS.map(({ id, q, options, auto }) => ({ id, q, options, auto: !!auto })),
    locked,
    count: picks.size,
    answers,
    // everyone's picks stay hidden until kickoff
    reveal: locked ? [...picks.values()].map((p) => ({ name: p.name, answers: p.answers })) : null,
  };
}

export const myPicks = (id) => picks.get(id)?.answers || null;

export function prePoints() {
  const out = new Map();
  for (const [id, p] of picks) {
    const pts = Object.entries(answers).filter(([qid, a]) => p.answers[qid] === a).length;
    if (pts) out.set(id, { name: p.name, pts });
  }
  return out;
}

// Returns true when shared state changed.
export function handlePre(m, id, name, isHost) {
  if (m.t === 'pre-pick' && !locked && m.answers && typeof m.answers === 'object') {
    const clean = {};
    for (const [qid, v] of Object.entries(m.answers)) if (byId[qid]?.options.includes(v)) clean[qid] = v;
    picks.set(id, { name, answers: clean });
    return true;
  }
  if (m.t === 'pre-lock' && isHost) {
    locked = !!m.on;
    return true;
  }
  if (m.t === 'pre-answer' && isHost && byId[m.qid]) {
    if (m.answer === null) delete answers[m.qid];
    else if (byId[m.qid].options.includes(m.answer)) answers[m.qid] = m.answer;
    else return false;
    return true;
  }
  return false;
}

// Auto-resolve from score updates. Needs innings in batting order with a `batting` flag (Cricinfo feed),
// or innings listed in batting order (CricketData).
let firstBatting = null;
let chaseSeen = false;
export function autoResolvePre(prev, next) {
  if (!next || next.error || !next.innings?.length) return false;
  const inns = next.innings;
  const nowBatting = inns.find((i) => i.batting)?.label || null;
  if (!firstBatting && nowBatting) firstBatting = nowBatting;
  if (!firstBatting) return false;

  const first = inns.find((i) => i.label === firstBatting);
  const second = inns.find((i) => i.label !== firstBatting);
  let changed = false;

  if (second && nowBatting === second.label) {
    chaseSeen = true;
    if (!answers.first && first) {
      answers.first = bucket(first.r);
      changed = true;
    }
  }
  // Chase over: nobody batting any more, both innings have scores.
  if (chaseSeen && !nowBatting && first && second && !answers.winner && second.r !== first.r) {
    const winnerLabel = second.r > first.r ? second.label : first.label;
    const opt = byId.winner.options.find((o) => winnerLabel.toLowerCase().includes(o.toLowerCase()));
    if (opt) {
      answers.winner = opt;
      changed = true;
    }
  }
  return changed;
}
