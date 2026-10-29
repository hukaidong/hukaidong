#!/usr/bin/env node
/**
 * language-card.mjs — aggregate language usage across a GitHub user AND the
 * organizations they belong to, then render a self-contained SVG.
 *
 * Unlike the stock `top-langs` card (one owner, public repos, byte totals),
 * this walks every configured owner, optionally verifies you actually authored
 * code in organization repositories, and emits a theme-aware SVG you can commit
 * to your profile repo.
 *
 * Usage:
 *   node scripts/language-card.mjs --out profile/top-langs.svg
 *   node scripts/language-card.mjs --theme dark --out /tmp/dark.svg
 *   node scripts/language-card.mjs --limit 5 --json     # quick smoke test
 *
 * Env:
 *   GITHUB_TOKEN / GH_TOKEN   token used for API calls (recommended)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const API = "https://api.github.com";

/* ------------------------------------------------------------------ config */

const DEFAULTS = {
  username: "hukaidong",
  title: "Most Used Languages",
  discover: true,
  owners: [],
  excludeOwners: [],
  excludeRepos: [],
  excludeLangs: [],
  langsCount: 8,
  sizeWeight: 0.5,
  countWeight: 0.5,
  includeForks: false,
  includeArchived: true,
  includePrivate: true,
  requireAuthoredForOrgs: true,
  weightByAuthorship: true,
  minOwnerShare: 1,
  concurrency: 6,
  theme: "auto",
  showOwnerBreakdown: true,
};

/* --------------------------------------------------------------- utilities */

const COLORS = {
  "Jupyter Notebook": "#DA5B0B", Python: "#3572A5", Shell: "#89e051",
  "C#": "#178600", "C++": "#f34b7d", Ruby: "#701516", C: "#555555",
  Mathematica: "#dd1100", JavaScript: "#f1e05a", TypeScript: "#3178c6",
  Vue: "#41b883", HTML: "#e34c26", CSS: "#563d7c", SCSS: "#c6538c",
  Less: "#1d365d", Java: "#b07219", Go: "#00ADD8", Rust: "#dea584",
  Swift: "#F05138", Kotlin: "#A97BFF", PHP: "#4F5D95", Dockerfile: "#384d54",
  Makefile: "#427819", Lua: "#000080", Perl: "#0298c3", R: "#198CE7",
  Scala: "#c22d40", Haskell: "#5e5086", Elixir: "#6e4a7e", Clojure: "#db5855",
  Dart: "#00B4AB", TeX: "#3D6117", "Objective-C": "#438eff", PowerShell: "#012456",
  "Vim Script": "#199f4b", "Emacs Lisp": "#c065db", Assembly: "#6E4C13",
  MATLAB: "#e16737", Julia: "#a270ba", Zig: "#ec915c", Nix: "#7e7eff",
  Svelte: "#ff3e00", Astro: "#ff5a03", Groovy: "#4298b8", "F#": "#b845fc",
  OCaml: "#3be133", Erlang: "#B83998", Crystal: "#000100", Nim: "#ffc200",
  HCL: "#844FBA", Jinja: "#a52a22", Batchfile: "#C1F12E", Prolog: "#74283c",
  Fortran: "#4d41b1", "Visual Basic .NET": "#945db7", CoffeeScript: "#244776",
  Starlark: "#76d275", Handlebars: "#f7931e", MDX: "#fcb32c", GDScript: "#355570",
};

const FALLBACK = [
  "#3572A5", "#89e051", "#178600", "#f34b7d", "#701516", "#dd1100",
  "#f1e05a", "#3178c6", "#41b883", "#e34c26", "#563d7c", "#b07219",
];

function colorFor(name) {
  if (COLORS[name]) return COLORS[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

/** Local calendar date (YYYY-MM-DD), not UTC — avoids showing "tomorrow". */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/* -------------------------------------------------------------------- http */

function makeClient(token) {
  let tokenExpiration = null;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "hukaidong-language-card",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  async function request(path, { allow = [] } = {}) {
    const url = path.startsWith("http") ? path : `${API}${path}`;
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      } catch (err) {
        lastErr = err;
        await sleep(750 * (attempt + 1));
        continue;
      }
      const exp = res.headers.get("github-authentication-token-expiration");
      if (exp) tokenExpiration = exp;
      if (allow.includes(res.status)) return { status: res.status, json: null, headers: res.headers };
      if (res.ok) return { status: res.status, json: await res.json(), headers: res.headers };
      if ([403, 429, 500, 502, 503, 504].includes(res.status)) {
        const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
        const remaining = res.headers.get("x-ratelimit-remaining");
        // Secondary/primary rate limit: wait for the window rather than spin.
        const wait = remaining === "0" && reset ? Math.min(60_000, reset * 1000 - Date.now() + 1000) : 800 * (attempt + 1);
        log(`  ! ${res.status} ${path} — retrying in ${Math.round(wait)}ms`);
        await sleep(Math.max(500, wait));
        lastErr = new Error(`${res.status} on ${path}`);
        continue;
      }
      const body = (await res.text()).slice(0, 300);
      throw new Error(`${res.status} ${path}: ${body}`);
    }
    throw lastErr ?? new Error(`request failed: ${path}`);
  }

  return { request, getTokenExpiration: () => tokenExpiration };
}

/**
 * Prefer an explicit token (a PAT that can see private org repos). If it is
 * rejected — expired fine-grained tokens are the common case — fall back to
 * the workflow token so the job still produces a public-only card.
 */
async function resolveClient() {
  const primary = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const fallback = process.env.GITHUB_FALLBACK_TOKEN || "";
  const client = makeClient(primary);
  if (primary && fallback) {
    try {
      await client.request("/rate_limit"); // cheap token validity probe
    } catch (err) {
      if (/\b401\b|bad credentials/i.test(err.message)) {
        log("! primary token rejected (expired?) — falling back to the workflow token");
        return { client: makeClient(fallback), degraded: true };
      }
      throw err;
    }
  }
  return { client, degraded: false };
}

/* ------------------------------------------------------------------ gather */

async function listRepos(client, owner, includePrivate) {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const { json } = await client.request(
      `/users/${encodeURIComponent(owner)}/repos?per_page=100&page=${page}&type=all&sort=pushed`
    );
    if (!Array.isArray(json) || json.length === 0) break;
    repos.push(...json);
    if (json.length < 100) break;
  }
  return repos.filter(
    (r) =>
      (includePrivate || !r.private) &&
      // `type=all` also returns repos you merely collaborate on, incl. org repos
      // that other owners already contributed — keep only repos this owner owns.
      r.owner?.login?.toLowerCase() === owner.toLowerCase()
  );
}

async function discoverOrgs(client, username) {
  // Only user tokens can read /user/orgs (includes private membership).
  try {
    const { json } = await client.request("/user/orgs?per_page=100");
    if (Array.isArray(json)) return json.map((o) => o.login);
  } catch {
    /* fall through to public listing */
  }
  try {
    const { json } = await client.request(`/users/${username}/orgs?per_page=100`);
    if (Array.isArray(json)) return json.map((o) => o.login);
  } catch {
    /* ignore */
  }
  return [];
}

/** Commit total for a repo, optionally only those authored by `login`. */
async function commitCount(client, fullName, login) {
  const q = login ? `&author=${encodeURIComponent(login)}` : "";
  const { status, headers, json } = await client.request(
    `/repos/${fullName}/commits?per_page=1${q}`,
    { allow: [409] } // empty repository
  );
  if (status === 409) return 0;
  const last = (headers?.get("link") ?? "").match(/[?&]page=(\d+)>;\s*rel="last"/);
  if (last) return Number(last[1]);
  return Array.isArray(json) ? json.length : 0;
}

/**
 * Every repo the token can see, private included. Available for user tokens
 * only — an Actions GITHUB_TOKEN has no user context and falls back to the
 * per-owner public listing.
 */
async function listVisibleRepos(client) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const { json } = await client.request(
      `/user/repos?per_page=100&page=${page}&affiliation=owner,organization_member&visibility=all&sort=pushed`
    );
    if (!Array.isArray(json) || json.length === 0) break;
    out.push(...json);
    if (json.length < 100) break;
  }
  return out;
}

async function languagesOf(client, fullName) {
  const { json } = await client.request(`/repos/${fullName}/languages`);
  return json && typeof json === "object" ? json : {};
}

/* --------------------------------------------------------------- aggregate */

function aggregate({ config, repos, languagesByRepo }) {
  const hidden = new Set(config.excludeLangs.map((l) => l.toLowerCase()));
  const perLang = new Map();
  const perOwner = new Map();
  let totalRepos = 0;
  let privateRepos = 0;

  for (const repo of repos) {
    const entry = languagesByRepo.get(repo.full_name);
    if (!entry) continue;
    const { langs, weight = 1 } = entry;
    const entries = Object.entries(langs).filter(([, bytes]) => bytes > 0);
    if (entries.length === 0 || weight <= 0) continue;
    totalRepos++;
    if (repo.private) privateRepos++;

    let ownerBytes = 0;
    for (const [name, bytes] of entries) {
      // Byte counts are scaled by the share of commits you authored, so a copy
      // of someone else's codebase contributes only what you actually changed.
      const effective = bytes * weight;
      ownerBytes += effective;
      const cur = perLang.get(name) ?? { bytes: 0, repoWeight: 0, repos: new Set(), owners: new Set() };
      cur.bytes += effective;
      cur.repoWeight += weight;
      cur.repos.add(repo.full_name);
      cur.owners.add(repo.owner);
      perLang.set(name, cur);
    }
    const o = perOwner.get(repo.owner) ?? { bytes: 0, repos: 0 };
    o.bytes += ownerBytes;
    o.repos += 1;
    perOwner.set(repo.owner, o);
  }

  const allBytes = [...perLang.values()].reduce((a, v) => a + v.bytes, 0) || 1;

  const languages = [...perLang.entries()]
    .filter(([name]) => !hidden.has(name.toLowerCase()))
    .map(([name, v]) => {
      const rank =
        Math.pow(v.bytes, config.sizeWeight) * Math.pow(v.repoWeight, config.countWeight);
      return {
        name,
        bytes: v.bytes,
        repoWeight: v.repoWeight,
        repos: v.repos.size,
        owners: [...v.owners],
        color: colorFor(name),
        rank,
      };
    })
    .sort((a, b) => b.rank - a.rank);

  const rankTotal = languages.reduce((a, l) => a + l.rank, 0) || 1;
  for (const l of languages) {
    l.percent = (l.rank / rankTotal) * 100;
    l.byteShare = (l.bytes / allBytes) * 100;
  }

  const owners = [...perOwner.entries()]
    .map(([login, v]) => ({ login, repos: v.repos, bytes: v.bytes, share: (v.bytes / allBytes) * 100 }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    title: config.title,
    generatedAt: localDate(),
    repos: totalRepos,
    privateRepos,
    minOwnerShare: config.minOwnerShare ?? 1,
    owners,
    languages,
    hiddenLangs: [...hidden],
  };
}

/* ----------------------------------------------------------------- render */

const PALETTES = {
  light: { text: "#1f2328", muted: "#59636e", track: "#1f2328", trackOpacity: 0.08, border: "#d0d7de" },
  dark: { text: "#e6edf3", muted: "#9198a1", track: "#e6edf3", trackOpacity: 0.14, border: "#3d444d" },
};

function cssFor(p) {
  return `
    .t { fill: ${p.text}; }
    .m { fill: ${p.muted}; }
    .tr { fill: ${p.track}; fill-opacity: ${p.trackOpacity}; }
    .bd { stroke: ${p.border}; }`;
}

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif`;

function render(model, theme) {
  const W = 470;
  const padX = 24;
  const headerH = 46;
  const rowH = 30;
  const footerH = model.languages.length ? 28 : 16;
  const langs = model.languages.slice(0, 99);
  const H = Math.max(110, headerH + langs.length * rowH + footerH);
  const trackW = W - padX * 2;
  const maxPct = Math.max(...langs.map((l) => l.percent), 1);

  const rows = langs
    .map((l, i) => {
      const y = headerH + i * rowH;
      const barW = Math.max(4, Math.round((l.percent / maxPct) * trackW));
      return `
    <g>
      <circle cx="${padX + 5}" cy="${y + 9}" r="4.5" fill="${l.color}"/>
      <text class="t" x="${padX + 18}" y="${y + 13}" font-size="13">${esc(l.name)}</text>
      <text class="m" x="${W - padX}" y="${y + 13}" font-size="13" text-anchor="end">${l.percent.toFixed(1)}%</text>
      <rect class="tr" x="${padX}" y="${y + 18}" width="${trackW}" height="6" rx="3"/>
      <rect x="${padX}" y="${y + 18}" width="${barW}" height="6" rx="3" fill="${l.color}"/>
    </g>`;
    })
    .join("");

  let footLeft = "";
  if (model.languages.length) {
    const bits = [`${model.repos} repos`];
    const meaningful = model.owners.filter((o) => o.share >= (model.minOwnerShare ?? 1));
    if (meaningful.length > 1) {
      const shown = meaningful
        .slice(0, 3)
        .map((o) => `${o.login} ${Math.round(o.share)}%`)
        .join(" · ");
      bits.push(shown + (meaningful.length > 3 ? ` · +${meaningful.length - 3}` : ""));
    } else if (model.owners.length === 1) {
      bits.push(model.owners[0].login);
    }
    footLeft = bits.join(" · ");
  }

  const footer = model.languages.length
    ? `
    <text class="m" x="${padX}" y="${H - 11}" font-size="10.5">${esc(footLeft)}</text>
    <text class="m" x="${W - padX}" y="${H - 11}" font-size="10.5" text-anchor="end">${esc(model.generatedAt)}</text>`
    : `
    <text class="m" x="${W / 2}" y="${headerH + 24}" font-size="12" text-anchor="middle">No matching repository data found</text>`;

  const style =
    theme === "auto"
      ? `${cssFor(PALETTES.light)}
    @media (prefers-color-scheme: dark) {${cssFor(PALETTES.dark)}
    }`
      : cssFor(PALETTES[theme] ?? PALETTES.light);

  const subtitle = model.languages.length
    ? `Public repository language usage across ${model.repos} repositories`
    : "No repository language data";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(model.title)}</title>
  <desc id="desc">${esc(subtitle)}</desc>
  <style>${style}
  </style>
  <rect class="bd" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="none"/>
  <text fill="#2f80ed" x="${padX}" y="30" font-size="16" font-weight="600">${esc(model.title)}</text>${rows}${footer}
</svg>
`;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(SCRIPT_DIR, args.config ?? "card.config.json");
  const fileConfig = JSON.parse(await readFile(configPath, "utf8"));
  const config = {
    ...DEFAULTS,
    ...fileConfig,
    ...(args.theme ? { theme: args.theme } : {}),
    ...(args["public-only"] ? { includePrivate: false } : {}),
    ...(args["langs-count"] ? { langsCount: Number(args["langs-count"]) } : {}),
    ...(args["size-weight"] ? { sizeWeight: Number(args["size-weight"]) } : {}),
    ...(args["count-weight"] ? { countWeight: Number(args["count-weight"]) } : {}),
  };

  if (!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN)) {
    log("! No GITHUB_TOKEN/GH_TOKEN set — unauthenticated (60 req/h, will likely fail).");
  }
  const { client, degraded } = await resolveClient();

  let ownerList;
  if (args.owner) {
    ownerList = [{ login: args.owner, requireAuthored: false }];
  } else {
    const configured = config.owners.map((o) =>
      typeof o === "string" ? { login: o, requireAuthored: config.requireAuthoredForOrgs } : o
    );
    const known = new Set(configured.map((o) => o.login.toLowerCase()));
    let discovered = [];
    if (config.discover) {
      discovered = (await discoverOrgs(client, config.username)).filter(
        (o) => !known.has(o.toLowerCase())
      );
    }
    ownerList = [
      ...configured,
      ...discovered.map((login) => ({ login, requireAuthored: config.requireAuthoredForOrgs })),
    ].filter((o) => !config.excludeOwners.some((x) => x.toLowerCase() === o.login.toLowerCase()));
  }

  log(`owners: ${ownerList.map((o) => (o.requireAuthored ? `${o.login}*` : o.login)).join(", ")}`);

  const authByOwner = new Map(ownerList.map((o) => [o.login.toLowerCase(), !!o.requireAuthored]));

  const isWanted = (r) => {
    if (!config.includeForks && r.fork) return false;
    if (!config.includeArchived && r.archived) return false;
    if (r.size === 0) return false;
    if (!config.includePrivate && r.private) return false;
    return !config.excludeRepos.some((x) => x.toLowerCase() === r.name.toLowerCase());
  };

  let repos = [];
  let visible = null;
  try {
    visible = await listVisibleRepos(client);
  } catch {
    visible = null; // installation token: no user context
  }

  if (visible && visible.length) {
    const wanted = new Set(ownerList.map((o) => o.login.toLowerCase()));
    repos = visible
      .filter((r) => wanted.has(r.owner.login.toLowerCase()))
      .filter(isWanted)
      .map((r) => ({
        ...r,
        owner: r.owner.login,
        requireAuthored: authByOwner.get(r.owner.login.toLowerCase()) ?? false,
      }));
    log(`listing: authenticated view (${visible.length} visible) → ${repos.length} repos`);
  } else {
    for (const owner of ownerList) {
      const list = await listRepos(client, owner.login, config.includePrivate);
      const kept = list
        .filter(isWanted)
        .map((r) => ({ ...r, owner: owner.login, requireAuthored: owner.requireAuthored }));
      log(`  ${owner.login}: ${list.length} repos → ${kept.length} after filters`);
      repos.push(...kept);
    }
  }

  // Defensive: the authenticated listing can surface the same repo twice.
  const seen = new Set();
  repos = repos.filter((r) => !seen.has(r.full_name) && seen.add(r.full_name));

  const limited = args.limit ? repos.slice(0, Number(args.limit)) : repos;
  log(`analysing ${limited.length} repos (concurrency ${config.concurrency})`);

  const languagesByRepo = new Map();
  let done = 0;
  await mapLimit(limited, config.concurrency, async (repo) => {
    try {
      let weight = 1;
      if (config.weightByAuthorship) {
        const total = await commitCount(client, repo.full_name);
        if (total > 0) {
          const mine = await commitCount(client, repo.full_name, config.username);
          weight = Math.min(1, mine / total);
        }
      }
      if (weight <= 0) {
        log(`  skip (no commits by ${config.username}): ${repo.full_name}`);
        return;
      }
      if (repo.requireAuthored && weight < 0.02 && repo.owner !== config.username) {
        log(`  skip (${(weight * 100).toFixed(1)}% authored): ${repo.full_name}`);
        return;
      }
      if (weight < 0.5) log(`  ~ ${repo.full_name}: ${(weight * 100).toFixed(1)}% authored`);
      languagesByRepo.set(repo.full_name, { langs: await languagesOf(client, repo.full_name), weight });
    } catch (err) {
      log(`  ! ${repo.full_name}: ${err.message}`);
    } finally {
      if (++done % 25 === 0) log(`  … ${done}/${limited.length}`);
    }
  });

  const model = aggregate({
    config,
    repos: limited.filter((r) => languagesByRepo.has(r.full_name)),
    languagesByRepo,
  });
  model.languages = model.languages.slice(0, config.langsCount);

  if (args.json) {
    process.stdout.write(JSON.stringify(model, null, 2) + "\n");
    return;
  }

  const svg = render(model, config.theme);
  const out = resolve(ROOT, args.out ?? "profile/top-langs.svg");
  const metaPath = out.endsWith(".svg") ? `${out.slice(0, -4)}.meta.json` : `${out}.meta.json`;

  // Never silently downgrade a private-inclusive card to a public-only one:
  // an expired fine-grained PAT would otherwise strip private repos and still
  // look like a successful, freshly generated card.
  let previous = null;
  try {
    previous = JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    /* first run */
  }
  if (
    config.includePrivate &&
    (previous?.privateRepos ?? 0) > 0 &&
    model.privateRepos === 0 &&
    !args["allow-downgrade"]
  ) {
    const msg =
      `private repos are not visible to this token (previous card had ${previous.privateRepos}); ` +
      `keeping it. Set includePrivate=false or pass --allow-downgrade to publish a public-only card.`;
    log(`::warning::${msg}`);
    log(`\n! ${msg}`);
    process.exitCode = 0;
    return;
  }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, svg, "utf8");
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        generatedAt: model.generatedAt,
        repos: model.repos,
        privateRepos: model.privateRepos,
        owners: model.owners.map((o) => o.login),
        degraded,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  log(
    `\n${model.repos} repos (${model.privateRepos} private) · ${model.owners.length} owners · ${svg.length} bytes → ${out}`
  );
  for (const l of model.languages) {
    log(`  ${l.name.padEnd(18)} ${l.percent.toFixed(1).padStart(5)}%  (${l.repos} repos)`);
  }

  // Fine-grained PATs expire; warn while there is still time to renew.
  const expires = client.getTokenExpiration();
  if (expires) {
    const days = Math.round((Date.parse(expires) - Date.now()) / 86_400_000);
    if (days < 0) log(`::error::token expired ${expires}`);
    else if (days < 14) log(`::warning::token expires in ${days} days (${expires}) — renew it before the next run`);
    else log(`token expires in ${days} days (${expires})`);
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
