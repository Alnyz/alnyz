// Self-contained GitHub metrics generator — fetches your stats via the GitHub
// GraphQL API (through the `gh` CLI, which is pre-installed on Actions runners
// and authed via GH_TOKEN) and renders two minimalist, monochrome SVGs that
// match the dithered README aesthetic: ink on transparent, Inter, hairline rules.
//
//   local:  gh auth login  &&  node scripts/metrics-gen.mjs
//   CI:     GH_TOKEN=${{ secrets.METRICS_TOKEN }} node scripts/metrics-gen.mjs
//
// Writes metrics-light.svg and metrics-dark.svg to the repo root.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const QUERY = `
query {
  viewer {
    login name
    followers { totalCount }
    repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount weekday } }
      }
    }
    pullRequests { totalCount }
    organizations { totalCount }
    repos: repositories(ownerAffiliations: OWNER, isFork: false, first: 100, orderBy: {field: STARGAZERS, direction: DESC}) {
      nodes { stargazerCount languages(first: 8, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name } } } }
    }
  }
}`;

function fetchData() {
  // gh resolves auth from GH_TOKEN (CI) or the local keyring.
  const raw = execFileSync('gh', ['api', 'graphql', '-f', `query=${QUERY}`], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  const json = JSON.parse(raw);
  if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors));
  return json.data.viewer;
}

function render(v, inkHex) {
  const ink = '#' + inkHex;
  const cal = v.contributionsCollection.contributionCalendar;

  let stars = 0;
  for (const r of v.repos.nodes) stars += r.stargazerCount;
  // Languages: weight each repo equally (normalize its languages to fractions,
  // then sum), so one huge repo can't dominate. Forks already excluded in query.
  const P = {};
  for (const r of v.repos.nodes) {
    const edges = r.languages?.edges || [];
    const repoBytes = edges.reduce((s, e) => s + e.size, 0);
    if (!repoBytes) continue;
    for (const e of edges) P[e.node.name] = (P[e.node.name] || 0) + e.size / repoBytes;
  }
  const totalScore = Object.values(P).reduce((a, b) => a + b, 0) || 1;
  const langs = Object.entries(P).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, score]) => ({ name, pct: score / totalScore }));
  const nf = (n) => n.toLocaleString('en-US');

  const W = 520, PAD = 16, CELL = 7, GAP = 2;
  const weeks = cal.weeks;
  const hmW = weeks.length * (CELL + GAP) - GAP;
  const hmX = (W - hmW) / 2;
  const maxDay = Math.max(1, ...weeks.flatMap(w => w.contributionDays.map(d => d.contributionCount)));
  const level = (c) => c === 0 ? 0 : c <= maxDay * 0.25 ? 1 : c <= maxDay * 0.5 ? 2 : c <= maxDay * 0.75 ? 3 : 4;
  const op = [0.08, 0.28, 0.5, 0.74, 1.0];

  const parts = [];
  const text = (x, yy, s, { size = 11, weight = 500, op: o = 1, anchor = 'middle', spacing = 0.02 } = {}) =>
    `<text x="${x}" y="${yy}" text-anchor="${anchor}" font-family="Inter, -apple-system, Segoe UI, sans-serif" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}em" fill="${ink}" fill-opacity="${o}">${s}</text>`;
  const rule = (yy) => `<line x1="${PAD + 40}" y1="${yy}" x2="${W - PAD - 40}" y2="${yy}" stroke="${ink}" stroke-opacity="0.12" stroke-width="1"/>`;

  let y = PAD + 6;
  parts.push(text(W / 2, y, 'CONTRIBUTIONS', { size: 9, weight: 600, op: 0.45, spacing: 0.22 }));
  y += 14;
  const hmTop = y;
  for (let wi = 0; wi < weeks.length; wi++) {
    for (const d of weeks[wi].contributionDays) {
      const cx = hmX + wi * (CELL + GAP);
      const cy = hmTop + d.weekday * (CELL + GAP);
      parts.push(`<rect x="${cx.toFixed(1)}" y="${cy}" width="${CELL}" height="${CELL}" rx="1.4" fill="${ink}" fill-opacity="${op[level(d.contributionCount)]}"/>`);
    }
  }
  y = hmTop + 7 * (CELL + GAP) + 14;
  parts.push(text(W / 2, y, `${nf(cal.totalContributions)} contributions in the last year`, { size: 11, weight: 600, op: 0.85 }));
  y += 16; parts.push(rule(y)); y += 22;

  parts.push(text(W / 2, y, 'LANGUAGES', { size: 9, weight: 600, op: 0.45, spacing: 0.22 }));
  y += 14;
  const barW = W - 2 * PAD - 80, barX = (W - barW) / 2, barH = 7;
  let bx = barX;
  const segOp = [1.0, 0.74, 0.52, 0.34, 0.2];
  parts.push(`<rect x="${barX}" y="${y}" width="${barW}" height="${barH}" rx="3.5" fill="${ink}" fill-opacity="0.07"/>`);
  langs.forEach((l, i) => {
    const w = barW * l.pct;
    parts.push(`<rect x="${bx.toFixed(1)}" y="${y}" width="${Math.max(0, w - 1).toFixed(1)}" height="${barH}" rx="3.5" fill="${ink}" fill-opacity="${segOp[i]}"/>`);
    bx += w;
  });
  y += barH + 16;
  parts.push(text(W / 2, y, langs.map(l => `${l.name} ${(100 * l.pct).toFixed(0)}%`).join('    ·    '), { size: 10, weight: 500, op: 0.7 }));
  y += 16; parts.push(rule(y)); y += 22;

  const stats = [
    [nf(v.pullRequests.totalCount), 'pull requests'],
    [nf(stars), 'stars'],
    [nf(v.repositories.totalCount), 'repos'],
    [nf(v.organizations.totalCount), 'orgs'],
    [nf(v.followers.totalCount), 'followers'],
  ];
  const slotW = (W - 2 * PAD) / stats.length;
  stats.forEach((s, i) => {
    const cx = PAD + slotW * (i + 0.5);
    parts.push(text(cx, y, s[0], { size: 18, weight: 700, op: 0.95 }));
    parts.push(text(cx, y + 15, s[1], { size: 9, weight: 500, op: 0.5, spacing: 0.04 }));
  });
  y += 28;

  const H = Math.round(y + PAD);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub metrics">
${parts.join('\n')}
</svg>
`;
}

const v = fetchData();
fs.writeFileSync('metrics-light.svg', render(v, '12191f'));
fs.writeFileSync('metrics-dark.svg', render(v, 'e6edf3'));
console.log(`metrics generated for ${v.login}: ${v.contributionsCollection.contributionCalendar.totalContributions} contributions`);
