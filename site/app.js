/* SF inspections — scrollytelling build (v3). Static data, client-side slicing.
   Data contract (unchanged): data/summary.json {window_start, window_end, generated_at};
   data/facilities.json [{permit,dba,address,hood,yelp_rating,yelp_reviews,failures,ever_closed}];
   data/history.json {permit: [[iso_date, type|null, rating, violations], ...]};
   data/episodes.json [{d,h,r:'P'|'C',rr,dr,du}]  (failure → next rated visit → the one after).
   Integrity rules: every rate carries its n; hoods with <100 rated inspections and Yelp
   groups with n<30 show "too few to quote"; Yelp bars zero-based on the 5-star scale;
   every chart has a table twin; tooltips never gate a value. */
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = (n) => n.toLocaleString("en-US");
const CSS = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const svgEl = (t, at = {}) => { const e = document.createElementNS("http://www.w3.org/2000/svg", t); for (const k in at) e.setAttribute(k, at[k]); return e; };
const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const MIN_HOOD_N = 100, MIN_YELP_N = 30;

const state = { period: "all", hood: "all", q: "", failview: "count" };
let DATA = null;

/* hero background follows the neighborhood filter; the citywide shot is the
   default and the fallback for hoods without a photo */
const DEFAULT_PHOTO = "photos/default-all-neighborhood.jpg";
const HOOD_PHOTOS = {
  "Bayview Hunters Point": "photos/bayview-hunters-point.jpg",
  "Bernal Heights": "photos/bernal-heights.jpg",
  "Castro/Upper Market": "photos/castro-upper-market.jpg",
  "Chinatown": "photos/chinatown.jpg",
  "Excelsior": "photos/excelsior.jpg",
  "Financial District/South Beach": "photos/financial-district-south-beach.jpg",
  "Glen Park": "photos/glen-park.jpg",
  "Golden Gate Park": "photos/golden-gate-park.jpg",
  "Haight Ashbury": "photos/haight-ashbury.jpg",
  "Hayes Valley": "photos/hayes-valley.jpg",
  "Inner Richmond": "photos/inner-richmond.jpg",
  "Inner Sunset": "photos/inner-sunset.jpg",
  "Japantown": "photos/japantown.jpg",
  "Lakeshore": "photos/lakeshore.jpg",
  "Lone Mountain/USF": "photos/lone-mountain-usf.jpg",
  "Marina": "photos/marina.jpg",
  "McLaren Park": "photos/mclaren-park.jpg",
  "Mission": "photos/mission.jpg",
  "Mission Bay": "photos/mission-bay.jpg",
  "Nob Hill": "photos/nob-hill.jpg",
  "North Beach": "photos/north-beach.jpg",
  "Oceanview/Merced/Ingleside": "photos/oceanview-merced-ingleside.jpg",
  "Outer Mission": "photos/outer-mission.jpg",
  "Outer Richmond": "photos/outer-richmond.jpg",
  "Pacific Heights": "photos/pacific-heights.jpg",
  "Portola": "photos/portola.jpg",
  "Potrero Hill": "photos/potrero-hill.jpg",
  "Presidio": "photos/presidio.jpg",
  "Presidio Heights": "photos/presidio-heights.jpg",
  "Russian Hill": "photos/russian-hill.jpg",
  "Seacliff": "photos/seacliff.jpg",
  "South of Market": "photos/south-of-market.jpg",
  "Sunset/Parkside": "photos/sunset-parkside.jpg",
  "Tenderloin": "photos/tenderloin.jpg",
  "Treasure Island": "photos/treasure-island.jpg",
  "Twin Peaks": "photos/twin-peaks.jpg",
  "Visitacion Valley": "photos/visitacion-valley.jpg",
  "West of Twin Peaks": "photos/west-of-twin-peaks.jpg",
  "Western Addition": "photos/western-addition.jpg"
};
function updateHeroPhoto() {
  const hero = document.querySelector(".hero");
  if (!hero) return;
  const src = HOOD_PHOTOS[state.hood] || DEFAULT_PHOTO;
  hero.style.backgroundImage =
    `linear-gradient(to bottom, var(--hero-veil), var(--hero-veil) 72%, var(--page)), url("${src}")`;
}

/* ---------- theme ---------- */
const mq = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const saved = localStorage.getItem("sfi-theme");
  const dark = saved ? saved === "dark" : mq.matches;
  document.documentElement.dataset.theme = dark ? (saved ? "dark" : "auto-dark") : "light";
}
applyTheme();
mq.addEventListener("change", applyTheme);

/* ---------- boot ---------- */
async function boot() {
  const [summary, facilities, history, episodes, violDefs] = await Promise.all(
    ["summary", "facilities", "history", "episodes", "viol_defs"].map((f) =>
      fetch(`data/${f}.json`).then((r) => r.ok ? r.json() : null)));
  DATA = { summary, facilities, history, episodes, violDefs };
  DATA.byPermit = Object.fromEntries(facilities.map((f) => [f.permit, f]));

  $("#window-note").textContent = ` · ${summary.window_start.slice(0, 4)} to ${summary.window_end.slice(0, 4)}`;
  $("#stamp").textContent = `Data through ${summary.window_end}. Generated ${summary.generated_at.slice(0, 10)}.`;

  const hoods = [...new Set(facilities.map((f) => f.hood).filter(Boolean))].sort();
  for (const h of hoods) { const o = el("option", "", h); o.value = h; $("#f-hood").append(o); }

  $("#theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme.includes("dark");
    localStorage.setItem("sfi-theme", cur ? "light" : "dark");
    applyTheme();
    render();
  });
  for (const b of $$("#f-period button"))
    b.addEventListener("click", () => {
      state.period = b.dataset.value;
      for (const o of $$("#f-period button")) o.setAttribute("aria-pressed", String(o === b));
      render();
    });
  $("#f-hood").addEventListener("change", (e) => { state.hood = e.target.value; render(); });
  for (const b of $$("#failview button"))
    b.addEventListener("click", () => {
      state.failview = b.dataset.value;
      for (const o of $$("#failview button")) o.setAttribute("aria-pressed", String(o === b));
      render();
    });
  $("#f-search").addEventListener("input", onSearch);
  $("#f-search-scene").addEventListener("input", onSearch);
  for (const btn of $$(".table-toggle"))
    btn.addEventListener("click", () => {
      const tv = btn.closest(".viz").querySelector(".table-view");
      const open = tv.hidden;
      tv.hidden = !open;
      btn.setAttribute("aria-pressed", String(open));
    });

  setupScenes();
  render();
  addEventListener("resize", () => { clearTimeout(boot._rz); boot._rz = setTimeout(render, 180); });
}

/* ---------- scroll orchestration ---------- */
function setupScenes() {
  const scenes = $$(".scene");
  const dots = $("#dots");
  for (const s of scenes) {
    const a = document.createElement("a");
    a.href = `#${s.id}`; a.title = s.dataset.nav; a.setAttribute("aria-label", s.dataset.nav);
    dots.append(a);
  }
  const links = $$("#dots a");
  const inView = (s) => { const r = s.getBoundingClientRect(); return r.top < innerHeight * 0.8 && r.bottom > 0; };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((ents) => {
      for (const en of ents) if (en.isIntersecting) en.target.classList.add("in");
    }, { threshold: 0.22 });
    const ioNav = new IntersectionObserver((ents) => {
      for (const en of ents) if (en.isIntersecting) {
        const i = scenes.indexOf(en.target);
        links.forEach((l, j) => l.classList.toggle("on", i === j));
      }
    }, { threshold: 0.5 });
    for (const s of scenes) { io.observe(s); ioNav.observe(s); }
  }
  /* resilience: reveal whatever is already on screen now, and once more shortly
     after load in case IO is unavailable, throttled, or never fires */
  const revealVisible = () => { for (const s of scenes) if (!s.classList.contains("in") && inView(s)) s.classList.add("in"); };
  revealVisible();
  setTimeout(revealVisible, 400);
  setTimeout(() => { for (const s of scenes) if (!s.classList.contains("in") && inView(s)) s.classList.add("in"); }, 1200);
  addEventListener("scroll", revealVisible, { passive: true });
}

/* ---------- slicing ---------- */
function cutoffISO() {
  if (state.period === "all") return "0000-00-00";
  const end = new Date(DATA.summary.window_end + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() - (state.period === "12m" ? 365 : 90));
  return end.toISOString().slice(0, 10);
}
function computeSlice() {
  const cut = cutoffISO(), hood = state.hood;
  const visits = []; const perFac = new Map();
  for (const f of DATA.facilities) {
    if (hood !== "all" && f.hood !== hood) continue;
    const rows = DATA.history[f.permit] || [];
    let any = false, cp = false, cl = false;
    for (const r of rows) {
      if (r[0] < cut) continue;
      visits.push(r); any = true;
      if (r[2] === "Conditional Pass") cp = true; else if (r[2] === "Closure") cl = true;
    }
    if (any) perFac.set(f.permit, { cp, cl, f });
  }
  const eps = DATA.episodes.filter((e) => e.d >= cut && (hood === "all" || e.h === hood));
  return { visits, eps, perFac, cut };
}
function monthKeys(cut) {
  const start = cut > DATA.summary.window_start ? cut : DATA.summary.window_start;
  const keys = [];
  let [y, m] = start.slice(0, 7).split("-").map(Number);
  const endK = DATA.summary.window_end.slice(0, 7);
  while (true) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    keys.push(k);
    if (k === endK) break;
    if (++m > 12) { m = 1; y++; }
    if (keys.length > 60) break;
  }
  return keys;
}

/* ---------- render ---------- */
function render() {
  const S = computeSlice();
  updateHeroPhoto();
  updateLookup();
  renderKPIs(S);
  renderMonthly(S);
  renderFailures(S);
  renderFunnel(S);
  renderHoods(S);
  renderMap(S);
}

function renderKPIs(S) {
  const resolved = S.eps.filter((e) => e.rr !== null);
  const fails = S.eps.length;
  const tiles = [
    ["Inspections", fmt(S.visits.length), "inspection visits in this view"],
    ["Facilities", fmt(S.perFac.size), "with at least one visit"],
    ["Failures", fmt(fails), "Conditional Pass or Closure"],
    ["Re-checked", fails ? Math.round(resolved.length * 100 / fails) + "%" : "n/a",
      fails ? `share of ${fmt(fails)} failures with a follow-up inspection` : "failures with a follow-up inspection"],
    ["Median response", resolved.length ? Math.round(median(resolved.map((e) => e.dr))) + " d" : "n/a",
      resolved.length ? `from failure to the follow-up · n=${fmt(resolved.length)}` : "from failure to the follow-up"],
  ];
  const row = $("#kpi-row"); row.replaceChildren();
  for (const [label, value, hint] of tiles) {
    const t = el("div", "tile");
    t.append(el("div", "value", value), el("div", "label", label), el("div", "hint", hint));
    row.append(t);
  }
  /* the scene 02 headline stays static ("The system responds fast");
     the pull-stat below it carries the numbers, once */
}

/* ---- tooltip ---- */
const tip = $("#tooltip");
function tipShow(head, rows) {
  tip.replaceChildren(el("div", "t-head", head));
  for (const [color, name, val] of rows) {
    const r = el("div", "t-row");
    if (color) { const k = el("span", "t-key"); k.style.background = color; r.append(k); }
    r.append(el("span", "t-name", name), el("span", "t-val", val));
    tip.append(r);
  }
  tip.hidden = false;
}
function tipMove(ev) {
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
function tipHide() { tip.hidden = true; }
function hitArea(svg, x, y, w, h, onenter) {
  const r = svgEl("rect", { x, y, width: Math.max(w, 8), height: h, class: "bar-hit" });
  r.addEventListener("mouseenter", onenter);
  r.addEventListener("mousemove", tipMove);
  r.addEventListener("mouseleave", tipHide);
  svg.append(r);
}

/* ---- table twin helper ---- */
function tableTwin(cardSel, headers, rows) {
  const tv = $(cardSel + " .table-view");
  const table = el("table");
  const trh = el("tr");
  for (const h of headers) trh.append(el("th", "", h));
  const thead = el("thead"); thead.append(trh);
  const tbody = el("tbody");
  for (const r of rows) { const tr = el("tr"); for (const c of r) tr.append(el("td", "", c)); tbody.append(tr); }
  table.append(thead, tbody);
  tv.replaceChildren(table);
}

function chartWidth(sel, fallback) {
  const n = $(sel); return Math.max((n && n.clientWidth) || fallback, 300);
}
function takeaway(id, text) { const n = $(id); if (n) n.textContent = text; }
const monthLabel = (k) => {
  const [y, m] = k.split("-");
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }) + (m === "01" ? " ’" + y.slice(2) : "");
};

/* ---- chart: inspections per month ---- */
function renderMonthly(S) {
  const keys = monthKeys(S.cut);
  /* stacked by outcome so the placard colors pay off in the very first
     chart: green Pass base, amber and red on top, grey for unrated */
  const by = {};
  for (const v of S.visits) {
    const k = v[0].slice(0, 7);
    const a = by[k] || (by[k] = { pass: 0, cp: 0, cl: 0, un: 0 });
    if (v[2] === "Pass") a.pass++;
    else if (v[2] === "Conditional Pass") a.cp++;
    else if (v[2] === "Closure") a.cl++;
    else a.un++;
  }
  const rows = keys.map((k) => by[k] || { pass: 0, cp: 0, cl: 0, un: 0 });
  /* bars carry rated visits only; unrated stay in tooltip and table so
     the totals still reconcile without grey noise in the visual */
  const counts = rows.map((r) => r.pass + r.cp + r.cl);
  const allCounts = rows.map((r) => r.pass + r.cp + r.cl + r.un);
  const W = chartWidth("#chart-monthly", 900), H = 240, m = { l: 8, r: 8, t: 16, b: 26 };
  const max = Math.max(...counts, 1);
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Stacked bar chart, inspections per month by outcome" });
  const iw = (W - m.l - m.r) / keys.length, bw = Math.min(iw * 0.62, 34);
  const cG = CSS("--status-good"), cW = CSS("--status-warning"),
        cC = CSS("--status-critical"), cU = CSS("--baseline");
  svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: H - m.b + 0.5, y2: H - m.b + 0.5, class: "axisline" }));
  keys.forEach((k, i) => {
    const r = rows[i];
    const x = m.l + i * iw + (iw - bw) / 2;
    const scale = (n) => n / max * (H - m.t - m.b);
    /* pass sits on the baseline; amber, then red stack upward */
    let y = H - m.b;
    for (const [n, color] of [[r.pass, cG], [r.cp, cW], [r.cl, cC]]) {
      if (!n) continue;
      const h = Math.max(scale(n), 1);
      y -= h;
      const rect = svgEl("rect", { x, y, width: bw, height: h, rx: Math.min(2, bw / 4), fill: color, class: "grow" });
      rect.style.setProperty("--i", i);
      svg.append(rect);
    }
    const step = Math.ceil(keys.length / Math.floor(W / 76));
    if (i % step === 0) {
      const t = svgEl("text", { x: m.l + i * iw + iw / 2, y: H - 8, "text-anchor": "middle" });
      t.textContent = monthLabel(k); svg.append(t);
    }
    hitArea(svg, m.l + i * iw, m.t, iw, H - m.t - m.b, () => tipShow(monthLabel(k) + " " + k.slice(0, 4), [
      [cG, "Pass", fmt(r.pass)],
      [cW, "Conditional Pass", fmt(r.cp)],
      [cC, "Closure", fmt(r.cl)],
      [null, "Rated total", fmt(counts[i])],
      ...(r.un ? [[cU, "No rating (not shown)", fmt(r.un)]] : [])]));
  });
  const peak = counts.indexOf(max);
  const pl = svgEl("text", { x: m.l + peak * iw + iw / 2, y: Math.max(H - m.b - max / max * (H - m.t - m.b) - 6, 12), "text-anchor": "middle", class: "fadein dlabel" });
  pl.textContent = fmt(max); svg.append(pl);
  $("#chart-monthly").replaceChildren(svg);
  const lg = $("#legend-monthly");
  if (lg) {
    lg.replaceChildren();
    for (const [c, n] of [[cG, "Pass"], [cW, "Conditional Pass"], [cC, "Closure"]]) {
      const key = el("span", "key"); const sw = el("span", "swatch"); sw.style.background = c;
      key.append(sw, document.createTextNode(n)); lg.append(key);
    }
  }
  tableTwin("#card-monthly", ["Month", "Pass", "Conditional Pass", "Closure", "No rating", "Total"],
    keys.map((k, i) => [k, fmt(rows[i].pass), fmt(rows[i].cp), fmt(rows[i].cl), fmt(rows[i].un), fmt(allCounts[i])]));
  const totalVisits = allCounts.reduce((a2, b2) => a2 + b2, 0);
  const perMonth = keys.length ? Math.round(totalVisits / keys.length) : 0;
  let drop = "";
  if (keys.length >= 18) {
    const avg = (arr) => arr.reduce((a2, b2) => a2 + b2, 0) / arr.length;
    const rAvg = Math.round(avg(allCounts.slice(-12))), pAvg = Math.round(avg(allCounts.slice(0, -12)));
    if (rAvg < pAvg * 0.75) drop = ` Monthly volume in the most recent year runs well below what came before (about ${fmt(rAvg)} vs ${fmt(pAvg)} per month); whether that is a real slowdown or records still arriving will become clear as weekly refreshes accumulate.`;
  }
  const totPass = rows.reduce((s2, r) => s2 + r.pass, 0);
  const totRated = rows.reduce((s2, r) => s2 + r.pass + r.cp + r.cl, 0);
  const greenShare = totRated ? Math.round(totPass * 100 / totRated) : 0;
  takeaway("#tk-monthly", `The health department made ${fmt(totalVisits)} inspection visits in this period, about ${fmt(perMonth)} per month. The bars show the ${fmt(totRated)} that received a rating: ${greenShare}% came back green, and the thin amber and red band on top is where enforcement begins.` + drop);
}

/* ---- chart: failures per month (Count bars / Rate line, one card) ---- */
function renderFailures(S) {
  const keys = monthKeys(S.cut);
  const cp = {}, cl = {};
  for (const e of S.eps) { const k = e.d.slice(0, 7); (e.r === "C" ? cl : cp)[k] = ((e.r === "C" ? cl : cp)[k] || 0) + 1; }
  const a = keys.map((k) => cp[k] || 0), b = keys.map((k) => cl[k] || 0);
  const agg = {};
  for (const v of S.visits) {
    if (v[2] === null) continue; /* unrated visits carry no grade */
    const k = v[0].slice(0, 7);
    const r = agg[k] || (agg[k] = { rated: 0, failed: 0 });
    r.rated++;
    if (v[2] !== "Pass") r.failed++;
  }
  const pts = keys.map((k) => {
    const r = agg[k] || { rated: 0, failed: 0 };
    return { k, ...r, rate: r.rated >= 50 ? r.failed * 100 / r.rated : null };
  });

  const chart = $("#chart-failures");
  const lg = $("#legend-failures"); lg.replaceChildren();
  const cWarn = CSS("--status-warning"), cCrit = CSS("--status-critical");

  if (state.failview === "rate") {
    /* rate line: comparable across volume swings; months under 50 rated visits stay blank */
    const W = chartWidth("#chart-failures", 900), H = 220, m = { l: 40, r: 10, t: 12, b: 26 };
    const maxRate = Math.max(...pts.map((p) => p.rate || 0), 4);
    const yMax = Math.ceil(maxRate / 2) * 2;
    const x = (i) => m.l + (W - m.l - m.r) * (keys.length > 1 ? i / (keys.length - 1) : 0.5);
    const y = (r) => m.t + (H - m.t - m.b) * (1 - r / yMax);
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Line chart, failure rate per month" });
    for (let t = 0; t <= yMax; t += yMax / 4) {
      svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? "axisline" : "gridline" }));
      const lbl = svgEl("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end" });
      lbl.textContent = t + "%"; svg.append(lbl);
    }
    /* the line is drawn in gap-separated runs so suppressed months stay honest blanks */
    let run = [];
    const flush = () => {
      if (run.length > 1) svg.append(svgEl("polyline", { points: run.map(([i, r]) => `${x(i)},${y(r)}`).join(" "), fill: "none", stroke: CSS("--series-1"), "stroke-width": 2, class: "fadein" }));
      run = [];
    };
    pts.forEach((p, i) => { p.rate === null ? flush() : run.push([i, p.rate]); });
    flush();
    const step = Math.ceil(keys.length / Math.floor(W / 76));
    pts.forEach((p, i) => {
      if (i % step === 0) {
        const lbl = svgEl("text", { x: x(i), y: H - 8, "text-anchor": "middle" });
        lbl.textContent = monthLabel(p.k); svg.append(lbl);
      }
      if (p.rate === null) return;
      svg.append(svgEl("circle", { cx: x(i), cy: y(p.rate), r: 3, fill: CSS("--series-1"), stroke: CSS("--page"), "stroke-width": 1, class: "fadein" }));
      hitArea(svg, x(i) - 8, m.t, 16, H - m.t - m.b, () => tipShow(monthLabel(p.k) + " " + p.k.slice(0, 4), [
        [CSS("--series-1"), "Failure rate", p.rate.toFixed(1) + "%"],
        [null, "Failures", fmt(p.failed)],
        [null, "Rated visits", fmt(p.rated)]]));
    });
    chart.replaceChildren(svg);
    const shown = pts.filter((p) => p.rate !== null);
    if (shown.length >= 2) {
      const avgOf = (arr) => arr.reduce((a2, p) => a2 + p.failed, 0) * 100 / Math.max(arr.reduce((a2, p) => a2 + p.rated, 0), 1);
      let cmp = "";
      if (shown.length > 12 && shown.slice(0, -12).length >= 6) {
        const rA = avgOf(shown.slice(-12)), pA = avgOf(shown.slice(0, -12));
        cmp = ` The most recent year runs at ${rA.toFixed(1)}% versus ${pA.toFixed(1)}% before, so enforcement intensity ${Math.abs(rA - pA) < 1.5 ? "held roughly steady" : rA > pA ? "rose" : "eased"} even as inspection volume changed.`;
      }
      takeaway("#tk-failures", "The share of rated visits that fail stays in a narrow band month to month. A rate, so it stays comparable even when inspection volume swings; months under 50 rated visits are left blank." + cmp);
    } else {
      takeaway("#tk-failures", "Too few rated visits per month in this selection to chart a fair rate.");
    }
  } else {
    /* count bars, stacked Conditional Pass / Closure */
    const W = chartWidth("#chart-failures", 900), H = 220, m = { l: 8, r: 8, t: 16, b: 26 };
    const max = Math.max(...keys.map((k, i) => a[i] + b[i]), 1);
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Stacked bar chart, failures per month" });
    const iw = (W - m.l - m.r) / keys.length, bw = Math.min(iw * 0.62, 34);
    svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: H - m.b + 0.5, y2: H - m.b + 0.5, class: "axisline" }));
    keys.forEach((k, i) => {
      const hA = a[i] / max * (H - m.t - m.b), hB = b[i] / max * (H - m.t - m.b);
      const x = m.l + i * iw + (iw - bw) / 2;
      const g = svgEl("g", { class: "grow" }); g.style.setProperty("--i", i);
      if (a[i]) g.append(svgEl("rect", { x, y: H - m.b - hA, width: bw, height: hA, fill: cWarn }));
      if (b[i]) g.append(svgEl("rect", { x, y: H - m.b - hA - hB, width: bw, height: hB, rx: Math.min(3, bw / 4), fill: cCrit }));
      svg.append(g);
      const step = Math.ceil(keys.length / Math.floor(W / 76));
      if (i % step === 0) {
        const t = svgEl("text", { x: m.l + i * iw + iw / 2, y: H - 8, "text-anchor": "middle" });
        t.textContent = monthLabel(k); svg.append(t);
      }
      hitArea(svg, m.l + i * iw, m.t, iw, H - m.t - m.b, () => tipShow(monthLabel(k) + " " + k.slice(0, 4),
        [[cWarn, "Conditional Pass", fmt(a[i])], [cCrit, "Closure", fmt(b[i])], [null, "Total", fmt(a[i] + b[i])]]));
    });
    chart.replaceChildren(svg);
    for (const [c, n] of [[cWarn, "Conditional Pass"], [cCrit, "Closure"]]) {
      const k = el("span", "key"); const sw = el("span", "swatch"); sw.style.background = c;
      k.append(sw, document.createTextNode(n)); lg.append(k);
    }
    const nCp = a.reduce((s2, v2) => s2 + v2, 0), nCl = b.reduce((s2, v2) => s2 + v2, 0);
    const rated = S.visits.filter((v) => v[2] !== null).length;
    const pct = rated ? ((nCp + nCl) * 100 / rated).toFixed(1) : "0";
    takeaway("#tk-failures", `${pct}% of rated visits found a problem serious enough to act on: ${fmt(nCp)} facilities were put on notice (Conditional Pass) and ${fmt(nCl)} were shut down on the spot (Closure). Flip to Rate to see the share of visits that fail instead of the raw count.`);
  }

  /* one table twin serves both views */
  tableTwin("#card-failures", ["Month", "Conditional Pass", "Closure", "Total failures", "Rated visits", "Failure rate"],
    keys.map((k, i) => {
      const p = pts[i];
      return [k, fmt(a[i]), fmt(b[i]), fmt(a[i] + b[i]), fmt(p.rated),
              p.rate === null ? `n/a (n=${fmt(p.rated)})` : p.rate.toFixed(1) + "%"];
    }));
}

/* ---- chart: enforcement funnel (waffle: one square per failure) ---- */
function renderFunnel(S) {
  const eps = S.eps;
  /* chapter pull-stat above the card: number left, explanation right */
  const resolvedAll = eps.filter((e) => e.rr !== null);
  const ps = $("#pull-funnel");
  if (ps) {
    if (resolvedAll.length) {
      ps.replaceChildren();
      const med = Math.round(median(resolvedAll.map((e) => e.dr)));
      const big = el("span", "big", Math.round(resolvedAll.length * 100 / eps.length) + "%");
      const wrapT = el("span", "pull-text");
      wrapT.append(
        el("span", "rest", `of ${fmt(eps.length)} failures were re-inspected; median ${med} days from failure to that follow-up.`),
        el("span", "pull-plain", `Meaning: after almost every failure, an inspector came back to re-check, typically in about ${med} day${med === 1 ? "" : "s"}.`));
      ps.append(big, wrapT); ps.hidden = false;
    } else ps.hidden = true;
  }

  const wrap = $("#chart-funnel"); wrap.replaceChildren();
  const groups = [["C", "After a Closure"], ["P", "After a Conditional Pass"]];
  const tableRows = [];
  for (const [code, title] of groups) {
    const g = eps.filter((e) => e.r === code);
    const resolved = g.filter((e) => e.rr !== null);
    const passed = g.filter((e) => e.rr === "Pass");
    const observed = passed.filter((e) => e.du !== null);
    const held = observed.filter((e) => e.du === "Pass");
    tableRows.push([title, g.length, resolved.length, passed.length, held.length]);

    const cats = [
      ["Fixed, and it stuck", held.length, CSS("--status-good")],
      ["Fixed, awaiting confirmation", passed.length - observed.length,
       `color-mix(in srgb, ${CSS("--status-good")} 55%, ${CSS("--page")})`],
      ["Fixed, then slipped back", observed.length - held.length, CSS("--status-warning")],
      ["Never fixed", resolved.length - passed.length, CSS("--status-critical")],
      ["Never re-checked", g.length - resolved.length, "url(#nodata-" + code + ")"],
    ];
    const panel = el("div");
    const h = el("h3", "waffle-title", `${title} (${fmt(g.length)} failures)`);
    panel.append(h);
    const cols = 25, cell = 11, gap = 2;
    /* each outcome starts on a fresh row, so the colors read as clean
       bands from best (top) to worst (bottom) instead of mid-row switches */
    let idx = 0;
    const cells = [];
    for (const [name, count, color] of cats) {
      if (!count) continue;
      if (idx % cols !== 0) idx += cols - (idx % cols);
      for (let k = 0; k < count; k++, idx++)
        cells.push({ x: (idx % cols) * (cell + gap), y: Math.floor(idx / cols) * (cell + gap), name, count, color });
    }
    const rowsN = Math.max(Math.ceil(idx / cols), 1);
    const W = cols * (cell + gap), H = rowsN * (cell + gap);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%",
                               style: "max-width:" + W * 1.6 + "px", role: "img",
                               "aria-label": `Waffle chart, outcomes ${title.toLowerCase()}` });
    const defs = svgEl("defs", {});
    const pat = svgEl("pattern", { id: "nodata-" + code, width: 5, height: 5,
                                   patternUnits: "userSpaceOnUse",
                                   patternTransform: "rotate(45)" });
    pat.append(svgEl("rect", { width: 5, height: 5, fill: CSS("--map-nodata-bg") }));
    pat.append(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 5,
                               stroke: CSS("--map-nodata-line"), "stroke-width": 1 }));
    defs.append(pat);
    svg.append(defs);
    for (const c of cells) {
      const r = svgEl("rect", { x: c.x, y: c.y, width: cell, height: cell, rx: 2, fill: c.color });
      r.dataset.cat = c.name; r.dataset.count = c.count; r.dataset.color = c.color;
      svg.append(r);
    }
    /* one delegated tooltip handler instead of a thousand listeners */
    const show = (evt) => {
      const t = evt.target;
      if (!t.dataset || !t.dataset.cat) { tipHide(); return; }
      tipShow(title, [[t.dataset.color.startsWith("url") ? CSS("--map-nodata-line") : t.dataset.color,
                       t.dataset.cat, fmt(Number(t.dataset.count))]]);
      tipMove(evt);
    };
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerleave", tipHide);
    panel.append(svg);
    const lg = el("div", "waffle-legend");
    for (const [name, count, color] of cats) {
      if (!count) continue;
      const k = el("span", "key");
      const sw = el("span", "swatch");
      if (color.startsWith("url")) sw.classList.add("swatch-hatch");
      else sw.style.background = color;
      k.append(sw, el("span", "", `${name}: ${fmt(count)}`));
      lg.append(k);
    }
    panel.append(lg);
    wrap.append(panel);
  }
  tableTwin("#card-funnel", ["", "Failures", "Re-rated", "Passed re-rating", "Held at next check"],
    tableRows.map((r) => r.map((c, i) => i === 0 ? c : fmt(c))));
  const cls = eps.filter((e) => e.r === "C");
  const clRes = cls.filter((e) => e.dr !== null);
  const medDays = clRes.length ? Math.round(median(clRes.map((e) => e.dr))) : null;
  const clPass = cls.filter((e) => e.rr === "Pass").length;
  const passPct = clRes.length ? Math.round(clPass * 100 / clRes.length) : null;
  takeaway("#tk-funnel", medDays === null
    ? "No closures in this selection."
    : `When a facility is shut down, inspectors typically return within ${fmt(medDays)} day${medDays === 1 ? "" : "s"}, and ${passPct}% pass that re-check. The catch is durability: across the full data, about one in five facilities that fixed their problem failed again within a year.`);
}

/* ---- chart: failure rate by neighborhood ---- */
function renderHoods(S) {
  const agg = new Map();
  for (const f of DATA.facilities) {
    if (state.hood !== "all" && f.hood !== state.hood) continue;
    const rows = DATA.history[f.permit] || [];
    const hood = f.hood || "Unknown";
    let a = agg.get(hood); if (!a) { a = { rated: 0, fail: 0 }; agg.set(hood, a); }
    for (const r of rows) { if (r[0] < S.cut || r[2] === null) continue; a.rated++; if (r[2] !== "Pass") a.fail++; }
  }
  const all = [...agg.entries()].map(([h, a]) => ({ h, ...a, rate: a.rated ? a.fail * 100 / a.rated : 0 }))
    .filter((r) => r.rated > 0).sort((x, y) => y.rate - x.rate);
  const quoted = all.filter((r) => r.rated >= MIN_HOOD_N);
  const W = chartWidth("#chart-hoods", 900), rowH = 30, narrow = W < 620;
  const m = { l: narrow ? 128 : 190, r: narrow ? 60 : 150 };
  const H = quoted.length * rowH + 6;
  const maxR = Math.max(...quoted.map((r) => r.rate), 1);
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Horizontal bar chart, failure rate by neighborhood" });
  const c = CSS("--series-1");
  quoted.forEach((r, i) => {
    const y = i * rowH;
    const lab = svgEl("text", { x: m.l - 10, y: y + rowH / 2 + 4, "text-anchor": "end" });
    lab.textContent = narrow && r.h.length > 16 ? r.h.slice(0, 15) + "…" : r.h; svg.append(lab);
    const bw = r.rate / maxR * (W - m.l - m.r);
    const rect = svgEl("rect", { x: m.l, y: y + rowH / 2 - 8, width: Math.max(bw, 2), height: 16, rx: 5, fill: c, class: "grow-x" });
    rect.style.setProperty("--i", i); svg.append(rect);
    const vl = svgEl("text", { x: m.l + Math.max(bw, 2) + 8, y: y + rowH / 2 + 4, class: "fadein" });
    vl.textContent = narrow ? r.rate.toFixed(1) + "%" : `${r.rate.toFixed(1)}% · n=${fmt(r.rated)}`;
    svg.append(vl);
    hitArea(svg, 0, y, W, rowH, () => tipShow(r.h, [
      [c, "Failure rate", r.rate.toFixed(1) + "%"],
      [null, "Rated inspections", fmt(r.rated)],
      [null, "Failures", fmt(r.fail)]]));
  });
  $("#chart-hoods").replaceChildren(svg);
  tableTwin("#card-hoods", ["Neighborhood", "Rated inspections", "Failures", "Failure rate"],
    all.map((r) => [r.h, fmt(r.rated), fmt(r.fail),
      r.rated >= MIN_HOOD_N ? r.rate.toFixed(1) + "%" : `too few to quote (n=${fmt(r.rated)})`]));
  if (quoted.length) {
    const top = quoted[0];
    takeaway("#tk-hoods", `${top.h} tops this view, with ${top.rate.toFixed(1)}% of its ${fmt(top.rated)} rated visits finding a problem. Read gently: neighborhoods differ in what kinds of food businesses they have, and restaurants fail more often than markets, so this partly reflects business mix, not just kitchen hygiene.`);
  } else {
    takeaway("#tk-hoods", "Not enough rated inspections in this selection to compare neighborhoods fairly.");
  }
}

/* ---- map: SF, mapped and ranked (always citywide, period-filtered;
   the hood filter highlights rather than hides) ---- */
function selectHood(name) {
  state.hood = state.hood === name ? "all" : name;
  $("#f-hood").value = state.hood;
  render();
}
function hoodDetail(name, cut) {
  let facs = 0, rated = 0, failed = 0, cp = 0, cl = 0;
  for (const f of DATA.facilities) {
    if (f.hood !== name) continue;
    let any = false;
    for (const r of DATA.history[f.permit] || []) {
      if (r[0] < cut) continue;
      any = true;
      if (r[2] === null) continue;
      rated++;
      if (r[2] !== "Pass") { failed++; r[2] === "Closure" ? cl++ : cp++; }
    }
    if (any) facs++;
  }
  return { facs, rated, failed, cp, cl };
}
function closeMapPop() {
  const pop = $("#map-pop");
  if (pop) pop.remove();
  document.removeEventListener("pointerdown", onPopOutside, true);
  document.removeEventListener("keydown", onPopEsc, true);
}
function onPopOutside(e) { if (!e.target.closest("#map-pop")) closeMapPop(); }
function onPopEsc(e) { if (e.key === "Escape") closeMapPop(); }
function openMapPop(name, rank, ev) {
  closeMapPop();
  const d = hoodDetail(name, cutoffISO());
  const pop = el("div"); pop.id = "map-pop";
  pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", name);
  const close = el("button", "map-pop-close", "\u00d7");
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", closeMapPop);
  const sub = el("p", "map-pop-sub", rank
    ? `#${rank} of the ranked neighborhoods in this period`
    : "Too few rated inspections to rank fairly in this period");
  const dl = el("dl");
  const rows = [
    ["Failure rate", d.rated >= MIN_HOOD_N ? (d.failed * 100 / d.rated).toFixed(1) + "%" : d.rated ? `too few to quote (n=${fmt(d.rated)})` : "n/a"],
    ["Rated inspections", fmt(d.rated)],
    ["Facilities inspected", fmt(d.facs)],
    ["Conditional Passes", fmt(d.cp)],
    ["Closures", fmt(d.cl)],
  ];
  for (const [k, v] of rows) dl.append(el("dt", "", k), el("dd", "", v));
  const btn = el("button", "ghost-btn map-pop-btn", state.hood === name ? "Unfocus the dashboard" : "Focus the dashboard on " + name);
  btn.addEventListener("click", () => { closeMapPop(); selectHood(name); });
  pop.append(close, el("h3", "", name), sub, dl, btn);
  document.body.append(pop);
  const W = 280, H = pop.offsetHeight || 300;
  const x = Math.max(8, Math.min((ev.clientX || innerWidth / 2) + 14, innerWidth - W - 12));
  const y = Math.max(8, Math.min((ev.clientY || innerHeight / 2) - H / 3, innerHeight - H - 12));
  pop.style.left = x + "px"; pop.style.top = y + "px";
  setTimeout(() => {
    document.addEventListener("pointerdown", onPopOutside, true);
    document.addEventListener("keydown", onPopEsc, true);
  }, 0);
}
function renderMap(S) {
  closeMapPop();
  const agg = new Map();
  for (const f of DATA.facilities) {
    let a = agg.get(f.hood); if (!a) { a = { rated: 0, fail: 0 }; agg.set(f.hood, a); }
    for (const r of DATA.history[f.permit] || []) { if (r[0] < S.cut || r[2] === null) continue; a.rated++; if (r[2] !== "Pass") a.fail++; }
  }
  const qualifying = [...agg.entries()]
    .filter(([h, a]) => a.rated >= MIN_HOOD_N && HOOD_GEO.hoods[h])
    .map(([h, a]) => ({ h, ...a, rate: a.fail * 100 / a.rated }))
    .sort((x, y) => y.rate - x.rate);
  const rankOf = {};
  qualifying.forEach((r, i) => { rankOf[r.h] = i + 1; });
  /* quartile shading: blues = calmer half, amber = third quarter, red = the
     city's highest failure rates — same hues the dashboard reserves for
     Conditional Pass and Closure. Quantiles because rates cluster at 4-8%. */
  const shades = ["--map-1", "--map-2", "--map-3", "--map-4"].map(CSS);
  const shadeOf = {};
  [...qualifying].sort((a, b) => a.rate - b.rate).forEach((r, i, arr) => {
    shadeOf[r.h] = shades[Math.min(3, Math.floor((i / arr.length) * 4))];
  });
  const host = $("#map-svg");
  host.replaceChildren();
  const svg = svgEl("svg", { viewBox: `0 0 ${HOOD_GEO.w} ${HOOD_GEO.h}`, width: "100%", role: "img", "aria-label": "Map of San Francisco neighborhoods shaded by failure rate" });
  const defs = svgEl("defs");
  const pat = svgEl("pattern", { id: "nodata", width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  pat.append(svgEl("rect", { width: 7, height: 7, fill: CSS("--map-nodata-bg") }));
  pat.append(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 7, stroke: CSS("--map-nodata-line"), "stroke-width": 1.2 }));
  defs.append(pat); svg.append(defs);
  const markers = [];
  for (const [name, g] of Object.entries(HOOD_GEO.hoods)) {
    const a = agg.get(name);
    const rated = a ? a.rated : 0;
    const qual = rated >= MIN_HOOD_N;
    const rate = rated ? a.fail * 100 / rated : null;
    const p = svgEl("path", { d: g.d, fill: qual ? shadeOf[name] : "url(#nodata)", class: "map-hood", tabindex: 0, stroke: CSS("--page"), "stroke-width": 1.5 });
    if (state.hood === name) { p.setAttribute("stroke", CSS("--text-primary")); p.setAttribute("stroke-width", 2.5); }
    const head = rankOf[name] ? `#${rankOf[name]} \u00b7 ${name}` : name;
    const tipRows = qual
      ? [[CSS("--series-1"), "Failure rate", rate.toFixed(1) + "%"], [null, "Rated inspections", fmt(rated)]]
      : [[null, "Rated inspections", fmt(rated)], [null, "Fair rating needs 100+", "too few"]];
    const show = (ev2) => { tipShow(head, tipRows); tipMove(ev2); };
    p.addEventListener("mouseenter", show);
    p.addEventListener("mousemove", tipMove);
    p.addEventListener("mouseleave", tipHide);
    p.addEventListener("click", (ev2) => { tipHide(); openMapPop(name, rankOf[name], ev2); });
    svg.append(p);
    if (rankOf[name]) markers.push({ name, g, rank: rankOf[name], show });
  }
  /* markers drawn after all polygons so they sit on top */
  for (const mk of markers) {
    const grp = svgEl("g", { class: "map-marker", tabindex: 0 });
    grp.append(svgEl("circle", { cx: mk.g.cx, cy: mk.g.cy, r: 11, fill: CSS("--text-primary"), stroke: CSS("--page"), "stroke-width": 1.5 }));
    const t = svgEl("text", { x: mk.g.cx, y: mk.g.cy + 3.5, "text-anchor": "middle", "font-size": "11", "font-weight": "700" });
    t.style.fill = CSS("--page");
    t.textContent = mk.rank; grp.append(t);
    grp.addEventListener("mouseenter", mk.show);
    grp.addEventListener("mousemove", tipMove);
    grp.addEventListener("mouseleave", tipHide);
    grp.addEventListener("click", (ev2) => { tipHide(); openMapPop(mk.name, mk.rank, ev2); });
    svg.append(grp);
  }
  host.append(svg);
  const legend = el("div", "map-legend");
  legend.append(el("span", "", "Fewer failures"), el("span", "map-legend-bar"), el("span", "", "More"));
  host.append(legend);
  const list = $("#map-list");
  list.replaceChildren();
  qualifying.forEach((r, i) => {
    const li = el("li", state.hood === r.h ? "active" : "");
    li.tabIndex = 0;
    li.append(el("span", "map-rank", String(i + 1)), el("span", "map-name", r.h), el("span", "map-val", r.rate.toFixed(1) + "%"));
    li.addEventListener("click", (ev2) => openMapPop(r.h, i + 1, ev2));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") openMapPop(r.h, i + 1, e); });
    list.append(li);
  });
  const unshaded = Object.keys(HOOD_GEO.hoods).length - qualifying.length;
  takeaway("#tk-map", qualifying.length
    ? `${qualifying[0].h} sits deepest in the red this period, with ${qualifying[0].rate.toFixed(1)}% of ${fmt(qualifying[0].rated)} rated visits finding a problem. Red marks the city's highest quarter of failure rates, not an absolute danger zone: even there, most inspections pass. ${unshaded} neighborhoods are hatched because they have too few rated inspections to quote a fair rate, so read the colors as enforcement activity, not a hygiene league table.`
    : "No neighborhood clears 100 rated inspections in this selection; widen the period for a fair map.");
}

/* ---------- facility search + neighborhood browse list ---------- */
function onSearch(e) {
  state.q = e.target.value;
  /* keep the top-bar and in-scene search boxes in step */
  for (const sel of ["#f-search", "#f-search-scene"]) {
    const n = $(sel);
    if (n && n !== e.target) n.value = e.target.value;
  }
  $("#facility-detail").hidden = true;
  if (e.target.id === "f-search" && state.q.trim().length >= 2) {
    const rct = $("#s-lookup").getBoundingClientRect();
    if (rct.top > innerHeight * 0.6 || rct.bottom < 160)
      window.scrollTo({ top: rct.top + scrollY, behavior: "smooth" });
  }
  updateLookup();
}
function updateLookup() {
  const res = $("#search-results"), head = $("#browse-head");
  res.replaceChildren();
  const q = (state.q || "").trim().toLowerCase();
  const pool = state.hood === "all"
    ? DATA.facilities
    : DATA.facilities.filter((f) => f.hood === state.hood);
  const where = state.hood === "all" ? "all neighborhoods" : state.hood;
  let list;
  if (q.length >= 2) {
    list = pool.filter((f) =>
      f.dba.toLowerCase().includes(q) || f.address.toLowerCase().includes(q)).slice(0, 30);
    head.textContent = list.length
      ? `${fmt(list.length)}${list.length === 30 ? "+" : ""} match${list.length === 1 ? "" : "es"} in ${where}`
      : "";
    if (!list.length) {
      res.append(el("div", "search-empty",
        `No facilities match in ${where}.` +
        (state.hood === "all" ? "" : " Set the neighborhood filter back to all for a citywide search.")));
      return;
    }
  } else {
    /* no query: browse the current neighborhood, most-inspected first */
    list = [...pool].sort((a, b) => b.inspections - a.inspections).slice(0, 30);
    head.textContent = `Browsing ${where}: the ${fmt(list.length)} most inspected of ${fmt(pool.length)} facilities. Search or pick one for its full history.`;
  }
  for (const f of list) {
    const b = el("button");
    b.type = "button";
    b.append(el("span", "", f.dba), el("span", "addr", `${f.address} · ${f.hood || "Unknown"}`));
    b.addEventListener("click", () => showFacility(f));
    res.append(b);
  }
}
function showFacility(f) {
  const det = $("#facility-detail");
  det.replaceChildren();
  const hist = [...(DATA.history[f.permit] || [])].sort((a, b) => b[0] < a[0] ? -1 : 1);
  const latest = hist.find(r => ["Pass", "Conditional Pass", "Closure"].includes(r[2]));
  if (latest) {
    const cls = latest[2] === "Pass" ? "pass" : latest[2] === "Conditional Pass" ? "cp" : "closure";
    const pl = el("div", "placard mini " + cls);
    pl.setAttribute("aria-label", `Current placard: ${latest[2]}, posted ${latest[0]}`);
    pl.innerHTML = `<div class="p-word${latest[2] === "Conditional Pass" ? " p-word-long" : ""}">${latest[2] === "Closure" ? "Closed" : latest[2]}</div><div class="p-date">${latest[0]}</div>`;
    det.append(pl);
  }
  det.append(el("h3", "", f.dba), el("div", "muted", `${f.address} · ${f.hood || "Unknown"}`));
  if (f.yelp_rating != null)
    det.append(el("div", "muted", `Yelp ${f.yelp_rating.toFixed(1)}★ (${fmt(f.yelp_reviews)} reviews)`));
  const ul = el("ul", "visits");
  const rows = hist;
  for (const [date, type, rating, viol, defIds] of rows) {
    const li = el("li");
    const chip = el("span", "chip " + (rating === "Pass" ? "pass" : rating === "Conditional Pass" ? "cp" : rating === "Closure" ? "closure" : "unrated"), rating || "No rating");
    li.append(el("span", "muted", date), chip);
    const label = viol != null ? `${viol} violation${viol === 1 ? "" : "s"}` : "";
    if (label && defIds && defIds.length && DATA.violDefs) {
      /* clickable: expand what the inspector actually wrote up */
      const btn = el("button", "viol-toggle", label + " ▸");
      btn.type = "button";
      btn.setAttribute("aria-expanded", "false");
      const detail = el("ul", "viol-list"); detail.hidden = true;
      for (const id of defIds) detail.append(el("li", "", DATA.violDefs[id] || ""));
      btn.addEventListener("click", () => {
        const open = detail.hidden;
        detail.hidden = !open;
        btn.setAttribute("aria-expanded", String(open));
        btn.textContent = label + (open ? " ▾" : " ▸");
      });
      li.append(btn);
      if (type) li.append(el("span", "muted", type));
      ul.append(li, detail);
      continue;
    }
    if (label) li.append(el("span", "", label));
    if (type) li.append(el("span", "muted", type));
    ul.append(li);
  }
  det.append(ul);
  det.hidden = false;
}

boot();
