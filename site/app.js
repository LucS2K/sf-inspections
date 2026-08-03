/* SF inspections dashboard. Static data, client-side slicing.
   All injected names use textContent, never innerHTML with data. */
"use strict";

const $ = (s) => document.querySelector(s);
const CSS = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = (n) => n.toLocaleString("en-US");

let DATA = null;
let state = { period: "all", hood: "all" };

/* ---------- boot ---------- */

async function boot() {
  const [summary, facilities, history, episodes] = await Promise.all(
    ["summary", "facilities", "history", "episodes"].map((f) =>
      fetch(`data/${f}.json`).then((r) => r.json())));
  DATA = { summary, facilities, history, episodes };
  DATA.hoodOf = Object.fromEntries(facilities.map((f) => [f.permit, f.hood || "Unknown"]));

  $("#window-note").textContent =
    ` Data ${summary.window_start} to ${summary.window_end}.`;
  $("#stamp").textContent =
    `Generated ${summary.generated_at.replace("T", " ")}. Source: SF DPH via data.sfgov.org (tvy3-wexg); business registry g8m3-pdis.`;

  const hoods = [...new Set(facilities.map((f) => f.hood).filter(Boolean))].sort();
  for (const h of hoods) {
    const o = document.createElement("option");
    o.value = h; o.textContent = h;
    $("#f-hood").appendChild(o);
  }

  for (const b of document.querySelectorAll("#f-period button"))
    b.addEventListener("click", () => {
      state.period = b.dataset.value;
      for (const o of document.querySelectorAll("#f-period button"))
        o.setAttribute("aria-pressed", String(o === b));
      render();
    });
  $("#f-hood").addEventListener("change", (e) => { state.hood = e.target.value; render(); });
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#f-search").addEventListener("input", onSearch);
  for (const btn of document.querySelectorAll(".table-toggle")) {
    btn.addEventListener("click", () => {
      const card = btn.closest(".card");
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      card.querySelector(".table-view").hidden = !on;
      for (const c of card.querySelectorAll(".chart, .legend")) c.style.display = on ? "none" : "";
    });
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  addEventListener("resize", debounce(render, 150));
  render();
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const cur = root.dataset.theme || (dark ? "dark" : "light");
  root.dataset.theme = cur === "dark" ? "light" : "dark";
  render();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------- filtering ---------- */

function cutoff() {
  const end = new Date(DATA.summary.window_end);
  if (state.period === "12m") { const d = new Date(end); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0, 10); }
  if (state.period === "90d") { const d = new Date(end); d.setDate(d.getDate() - 90); return d.toISOString().slice(0, 10); }
  return "0000";
}

/* visits under current filter: [permit, date, type, rating, violations] */
function visits() {
  const from = cutoff();
  const out = [];
  for (const [permit, rowsArr] of Object.entries(DATA.history)) {
    if (state.hood !== "all" && DATA.hoodOf[permit] !== state.hood) continue;
    for (const v of rowsArr) if (v[0] >= from) out.push([permit, ...v]);
  }
  return out;
}

function episodesF() {
  const from = cutoff();
  return DATA.episodes.filter((e) =>
    e.d >= from && (state.hood === "all" || e.h === state.hood));
}

/* ---------- render ---------- */

function render() {
  const vs = visits();
  const eps = episodesF();
  renderKPIs(vs, eps);
  renderMonthly(vs);
  renderFailures(vs);
  renderFunnel(eps);
  renderHoods();
  renderYelp();
  renderFacilityList(vs);
}

let listShown = 30;
let listCache = [];

function renderFacilityList(vs, keepShown) {
  if (!keepShown) listShown = 30;
  const per = new Map();
  for (const [permit, date, type, rating] of vs) {
    const e = per.get(permit) || { visits: 0, fails: 0, last: "", lastRating: null };
    e.visits++;
    if (rating === "Conditional Pass" || rating === "Closure") e.fails++;
    if (date >= e.last) {
      e.last = date;
      if (rating !== null || e.lastRating === null) e.lastRating = rating;
    }
    per.set(permit, e);
  }
  const facByPermit = new Map(DATA.facilities.map((f) => [f.permit, f]));
  listCache = [...per.entries()]
    .map(([permit, e]) => ({ f: facByPermit.get(permit), ...e }))
    .filter((r) => r.f)
    .sort((a, b) => b.last.localeCompare(a.last));

  $("#list-head").textContent =
    `${fmt(listCache.length)} facilities inspected in this selection`;
  const box = $("#facility-list");
  box.replaceChildren();
  for (const r of listCache.slice(0, listShown)) {
    const b = document.createElement("button");
    const left = document.createElement("span");
    const name = document.createElement("strong"); name.textContent = r.f.dba || r.f.permit;
    const addr = document.createElement("span"); addr.className = "addr";
    addr.textContent = " " + (r.f.address || "").replace(/\s+/g, " ");
    left.append(name, addr);
    const right = document.createElement("span"); right.className = "addr";
    right.append(document.createTextNode(r.last + " "));
    right.append(chipFor(r.lastRating));
    if (r.fails) {
      const w = document.createElement("span");
      w.textContent = ` ${r.fails} failure${r.fails === 1 ? "" : "s"} in period`;
      right.append(w);
    }
    if (r.f.yelp_rating !== null && r.f.yelp_rating !== undefined) {
      const y = document.createElement("span");
      y.textContent = ` ★ ${Number(r.f.yelp_rating).toFixed(1)}`;
      right.append(y);
    }
    b.append(left, right);
    b.addEventListener("click", () => {
      showFacility(r.f);
      $("#facility-detail").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    box.append(b);
  }
  const more = $("#list-more");
  more.hidden = listCache.length <= listShown;
  more.textContent = `Show more (${fmt(listCache.length - listShown)} remaining)`;
  more.onclick = () => { listShown += 50; renderFacilityList(vs, true); };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function renderKPIs(vs, eps) {
  const facilities = new Set(vs.map((v) => v[0])).size;
  const resolved = eps.filter((e) => e.rr !== null);
  const tiles = [
    ["Inspections", fmt(vs.length), ""],
    ["Facilities", fmt(facilities), ""],
    ["Failures", fmt(eps.length), "Conditional Pass or Closure"],
    ["Re-rated", eps.length ? Math.round(resolved.length * 100 / eps.length) + "%" : "n/a",
     eps.length ? "share of " + fmt(eps.length) + " failures with a later graded visit"
                : "failures with a later graded visit"],
    ["Median response", resolved.length ? Math.round(median(resolved.map((e) => e.dr))) + " d" : "n/a",
     resolved.length ? "days from failure to next graded visit \u00b7 n=" + fmt(resolved.length)
                     : "days from failure to next graded visit"],
  ];
  const row = $("#kpi-row");
  row.replaceChildren();
  for (const [label, value, hint] of tiles) {
    const t = document.createElement("div");
    t.className = "tile";
    const l = document.createElement("div"); l.className = "label"; l.textContent = label;
    const v = document.createElement("div"); v.className = "value"; v.textContent = value;
    t.append(l, v);
    if (hint) { const h = document.createElement("div"); h.className = "hint"; h.textContent = hint; t.append(h); }
    row.append(t);
  }
}

/* ---------- chart helpers ---------- */

const tooltip = $("#tooltip");
function showTip(evt, head, rowsArr) {
  tooltip.replaceChildren();
  const h = document.createElement("div"); h.className = "t-head"; h.textContent = head;
  tooltip.append(h);
  for (const [color, value, name] of rowsArr) {
    const r = document.createElement("div"); r.className = "t-row";
    const k = document.createElement("span"); k.className = "t-key"; k.style.background = color;
    const v = document.createElement("span"); v.className = "t-val"; v.textContent = value;
    const n = document.createElement("span"); n.className = "t-name"; n.textContent = name;
    r.append(k, v, n); tooltip.append(r);
  }
  tooltip.hidden = false;
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  const w = tooltip.offsetWidth, hgt = tooltip.offsetHeight;
  if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
  if (y + hgt > innerHeight - 8) y = evt.clientY - hgt - pad;
  tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
}
function hideTip() { tooltip.hidden = true; }

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/* rounded top (4px), square baseline */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const step = Math.pow(10, Math.floor(Math.log10(max / count)));
  const s = [1, 2, 5, 10].map((m) => m * step).find((m) => max / m <= count) || step * 10;
  const out = [];
  for (let v = 0; v <= max; v += s) out.push(v);
  return out;
}

/* string arithmetic only: Date-parsing ISO strings shifts months across
   timezones (Jan 1 UTC renders as "Dec 23" in Pacific) */
function monthKeys() {
  const from = cutoff() === "0000" ? DATA.summary.window_start : cutoff();
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ey, em] = DATA.summary.window_end.slice(0, 7).split("-").map(Number);
  const keys = [];
  while (y < ey || (y === ey && m <= em)) {
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
    m === 12 ? (y++, m = 1) : m++;
  }
  return keys;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function monthLabel(mk) {
  const [y, m] = mk.split("-").map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

/* generic monthly column chart; series = [{name, color, byMonth}] stacked */
function columnChart(el, months, series, tableEl) {
  el.replaceChildren();
  const W = Math.max(el.clientWidth || 480, 320), H = 220;
  const m = { t: 12, r: 8, b: 26, l: 40 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const totals = months.map((mo) => series.reduce((s, sr) => s + (sr.byMonth[mo] || 0), 0));
  const max = Math.max(...totals, 1);
  const ticks = niceTicks(max);
  const band = iw / months.length;
  const bw = Math.min(24, band * 0.7);
  const y = (v) => m.t + ih - (v / (ticks.at(-1) || 1)) * ih;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img" });

  for (const t of ticks) {
    svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: CSS("--grid"), "stroke-width": 1 }));
    const lbl = svgEl("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end" });
    lbl.textContent = fmt(t); svg.append(lbl);
  }
  svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: CSS("--baseline"), "stroke-width": 1 }));

  months.forEach((mo, i) => {
    const cx = m.l + band * i + (band - bw) / 2;
    const gap = 2;              /* surface gap between stacked segments */
    let cum = 0;
    series.forEach((sr, si) => {
      const v = sr.byMonth[mo] || 0;
      if (!v) return;
      const y0 = y(cum);        /* bottom edge before gap */
      cum += v;
      const y1 = y(cum);        /* top edge */
      const bottom = si > 0 ? y0 - gap : y0;
      const hgt = bottom - y1;
      if (hgt <= 0) return;
      const isTop = si === series.length - 1 ||
        series.slice(si + 1).every((s2) => !(s2.byMonth[mo] || 0));
      const p = isTop
        ? svgEl("path", { d: barPath(cx, y1, bw, hgt), fill: sr.color })
        : svgEl("rect", { x: cx, y: y1, width: bw, height: hgt, fill: sr.color });
      svg.append(p);
    });
    /* hit target spans the full band height */
    const hit = svgEl("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: "transparent", tabindex: 0 });
    const show = (evt) => showTip(evt, monthLabel(mo),
      series.map((sr) => [sr.color, fmt(sr.byMonth[mo] || 0), sr.name]).reverse());
    hit.addEventListener("pointermove", show);
    hit.addEventListener("mousemove", show);
    hit.addEventListener("focus", (e) => {
      const r = hit.getBoundingClientRect();
      show({ clientX: r.x + r.width / 2, clientY: r.y + 20 });
    });
    hit.addEventListener("pointerleave", hideTip);
    hit.addEventListener("blur", hideTip);
    svg.append(hit);
    if (i % Math.ceil(months.length / 10) === 0) {
      const lbl = svgEl("text", { x: cx + bw / 2, y: H - 8, "text-anchor": "middle" });
      lbl.textContent = monthLabel(mo); svg.append(lbl);
    }
  });
  el.append(svg);

  /* table twin */
  const tbl = document.createElement("table");
  const thead = document.createElement("tr");
  for (const h of ["Month", ...series.map((s) => s.name)]) {
    const th = document.createElement("th"); th.textContent = h; thead.append(th);
  }
  tbl.append(thead);
  for (const mo of months) {
    const tr = document.createElement("tr");
    const td = document.createElement("td"); td.textContent = mo; tr.append(td);
    for (const sr of series) {
      const c = document.createElement("td"); c.textContent = fmt(sr.byMonth[mo] || 0); tr.append(c);
    }
    tbl.append(tr);
  }
  tableEl.replaceChildren(tbl);
}

function takeaway(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function renderMonthly(vs) {
  const months = monthKeys(vs);
  const byMonth = {};
  for (const v of vs) byMonth[v[1].slice(0, 7)] = (byMonth[v[1].slice(0, 7)] || 0) + 1;
  columnChart($("#chart-monthly"), months,
    [{ name: "Inspections", color: CSS("--series-1"), byMonth }],
    $("#card-monthly .table-view"));
  const perMonth = months.length ? Math.round(vs.length / months.length) : 0;
  takeaway("#tk-monthly", `The health department made ${fmt(vs.length)} `
    + `inspection visits in this period, about ${fmt(perMonth)} per month.`);
}

function renderFailures(vs) {
  const months = monthKeys(vs);
  const cp = {}, cl = {};
  for (const v of vs) {
    const mo = v[1].slice(0, 7);
    if (v[3] === "Conditional Pass") cp[mo] = (cp[mo] || 0) + 1;
    else if (v[3] === "Closure") cl[mo] = (cl[mo] || 0) + 1;
  }
  const series = [
    { name: "Closure", color: CSS("--status-critical"), byMonth: cl },
    { name: "Conditional Pass", color: CSS("--status-warning"), byMonth: cp },
  ];
  const legend = $("#legend-failures");
  legend.replaceChildren();
  for (const sr of [...series].reverse()) {
    const k = document.createElement("span"); k.className = "key";
    const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = sr.color;
    const t = document.createElement("span"); t.textContent = sr.name;
    k.append(sw, t); legend.append(k);
  }
  columnChart($("#chart-failures"), months, series, $("#card-failures .table-view"));
  const nCp = Object.values(cp).reduce((a, b) => a + b, 0);
  const nCl = Object.values(cl).reduce((a, b) => a + b, 0);
  const rated = vs.filter((v) => v[3] !== null).length;
  const pct = rated ? ((nCp + nCl) * 100 / rated).toFixed(1) : "0";
  takeaway("#tk-failures", `${pct}% of graded visits found a problem serious `
    + `enough to act on: ${fmt(nCp)} facilities were put on notice (Conditional Pass) and `
    + `${fmt(nCl)} were shut down on the spot (Closure).`);
}

function renderFunnel(eps) {
  const el = $("#chart-funnel");
  el.replaceChildren();
  const groups = [["C", "After a Closure"], ["P", "After a Conditional Pass"]];
  const ramp = [CSS("--ord-1"), CSS("--ord-2"), CSS("--ord-3"), CSS("--ord-4")];
  const tableRows = [];

  for (const [code, title] of groups) {
    const g = eps.filter((e) => e.r === code);
    const resolved = g.filter((e) => e.rr !== null);
    const passed = g.filter((e) => e.rr === "Pass");
    const observed = passed.filter((e) => e.du !== null);
    const held = observed.filter((e) => e.du === "Pass");
    const stages = [
      ["Failures", g.length, g.length],
      ["Re-rated", resolved.length, g.length],
      ["Passed re-rating", passed.length, resolved.length],
      [`Held at next check (of ${fmt(observed.length)} observed)`, held.length, observed.length],
    ];
    tableRows.push([title, ...stages.map((s) => s[1])]);

    const wrap = document.createElement("div");
    const h = document.createElement("h3"); h.textContent = title;
    h.style.cssText = "font-size:13px;margin:0 0 6px;color:var(--text-secondary);font-weight:600";
    wrap.append(h);
    const W = Math.max((el.clientWidth || 640) / 2 - 20, 280), rowH = 34, H = stages.length * rowH + 6;
    const max = Math.max(g.length, 1);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img" });
    stages.forEach(([name, val], i) => {
      /* reserve label room so a full-width bar never clips its value */
      const bw = Math.max((val / max) * (W - 58), val > 0 ? 3 : 0);
      const yy = i * rowH + 16;
      const lbl = svgEl("text", { x: 0, y: yy - 4, class: "stage-label" });
      lbl.textContent = name; svg.append(lbl);
      const bar = svgEl("rect", { x: 0, y: yy, width: bw, height: 12, rx: 4, fill: ramp[i] });
      svg.append(bar);
      const vl = svgEl("text", { x: bw + 6, y: yy + 10, class: "dlabel" });
      vl.textContent = fmt(val); svg.append(vl);
      const hit = svgEl("rect", { x: 0, y: yy - 12, width: W, height: rowH, fill: "transparent", tabindex: 0 });
      const show = (evt) => showTip(evt, title, [[ramp[i], fmt(val), name]]);
      hit.addEventListener("pointermove", show);
    hit.addEventListener("mousemove", show);
      hit.addEventListener("pointerleave", hideTip);
      hit.addEventListener("blur", hideTip);
      svg.append(hit);
    });
    wrap.append(svg);
    el.append(wrap);
  }

  const tbl = document.createElement("table");
  const thead = document.createElement("tr");
  for (const h of ["", "Failures", "Re-rated", "Passed re-rating", "Held at next check"]) {
    const th = document.createElement("th"); th.textContent = h; thead.append(th);
  }
  tbl.append(thead);
  for (const r of tableRows) {
    const tr = document.createElement("tr");
    r.forEach((c, i) => {
      const td = document.createElement("td");
      td.textContent = i === 0 ? c : fmt(c); tr.append(td);
    });
    tbl.append(tr);
  }
  $("#card-funnel .table-view").replaceChildren(tbl);

  const cl = eps.filter((e) => e.r === "C");
  const clRes = cl.filter((e) => e.dr !== null);
  const medDays = clRes.length ? Math.round(median(clRes.map((e) => e.dr))) : null;
  const clPass = cl.filter((e) => e.rr === "Pass").length;
  const passPct = clRes.length ? Math.round(clPass * 100 / clRes.length) : null;
  takeaway("#tk-funnel", medDays === null
    ? "No closures in this selection."
    : `When a facility is shut down, inspectors typically return within `
      + `${fmt(medDays)} day${medDays === 1 ? "" : "s"}, and ${passPct}% pass that re-check. `
      + `The catch is durability: across the full data, about one in five facilities that `
      + `fixed their problem failed again within a year.`);
}

function renderHoods() {
  const from = cutoff();
  const agg = {};
  for (const [permit, rowsArr] of Object.entries(DATA.history)) {
    const hood = DATA.hoodOf[permit] || "Unknown";
    for (const v of rowsArr) {
      if (v[0] < from) continue;
      const rating = v[2];
      if (rating === null) continue;
      agg[hood] = agg[hood] || { rated: 0, failed: 0 };
      agg[hood].rated++;
      if (rating !== "Pass") agg[hood].failed++;
    }
  }
  const rows = Object.entries(agg)
    .map(([hood, a]) => ({ hood, ...a, rate: a.failed * 100 / a.rated }))
    .sort((a, b) => b.rate - a.rate);
  const big = rows.filter((r) => r.rated >= 100).slice(0, 12);

  const el = $("#chart-hoods");
  el.replaceChildren();
  const W = Math.max(el.clientWidth || 640, 320), rowH = 26,
        m = { l: W >= 620 ? 190 : 132, r: W >= 620 ? 156 : 64 };
  const H = big.length * rowH + 4;
  const max = Math.max(...big.map((r) => r.rate), 1);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img" });
  big.forEach((r, i) => {
    const yy = i * rowH + 6;
    const lbl = svgEl("text", { x: m.l - 8, y: yy + 11, "text-anchor": "end", class: "stage-label" });
    lbl.textContent = r.hood; svg.append(lbl);
    const bw = ((r.rate / max) * (W - m.l - m.r));
    svg.append(svgEl("rect", { x: m.l, y: yy, width: Math.max(bw, 2), height: 12, rx: 4, fill: CSS("--series-1") }));
    const vl = svgEl("text", { x: m.l + Math.max(bw, 2) + 6, y: yy + 11, class: "dlabel" });
    vl.textContent = W >= 620 ? r.rate.toFixed(1) + "% \u00b7 n=" + fmt(r.rated)
                              : r.rate.toFixed(1) + "%"; svg.append(vl);
    const hit = svgEl("rect", { x: 0, y: yy - 4, width: W, height: rowH, fill: "transparent", tabindex: 0 });
    const show = (evt) => showTip(evt, r.hood, [
      [CSS("--series-1"), r.rate.toFixed(1) + "%", "failure rate"],
      [CSS("--baseline"), fmt(r.rated), "graded inspections"],
    ]);
    hit.addEventListener("pointermove", show);
    hit.addEventListener("mousemove", show);
    hit.addEventListener("pointerleave", hideTip);
    hit.addEventListener("blur", hideTip);
    svg.append(hit);
  });
  el.append(svg);

  const tbl = document.createElement("table");
  const thead = document.createElement("tr");
  for (const h of ["Neighborhood", "Graded inspections", "Failures", "Failure rate"]) {
    const th = document.createElement("th"); th.textContent = h; thead.append(th);
  }
  tbl.append(thead);
  for (const r of rows) {
    const tr = document.createElement("tr");
    const c0 = document.createElement("td"); c0.textContent = r.hood;
    const c1 = document.createElement("td"); c1.textContent = fmt(r.rated);
    const c2 = document.createElement("td"); c2.textContent = fmt(r.failed);
    const c3 = document.createElement("td");
    c3.textContent = r.rated >= 100 ? r.rate.toFixed(1) + "%" : `n/a (n=${r.rated})`;
    tr.append(c0, c1, c2, c3); tbl.append(tr);
  }
  $("#card-hoods .table-view").replaceChildren(tbl);

  if (big.length) {
    const top = big[0];
    takeaway("#tk-hoods", `${top.hood} tops this view, with `
      + `${top.rate.toFixed(1)}% of its ${fmt(top.rated)} graded visits finding a problem. `
      + `Read gently: neighborhoods differ in what kinds of food businesses they have, and `
      + `restaurants fail more often than markets, so this partly reflects business mix, `
      + `not just kitchen hygiene.`);
  } else {
    takeaway("#tk-hoods", "Not enough graded inspections in this selection to compare neighborhoods fairly.");
  }
}

function renderYelp() {
  const from = cutoff();
  /* rating snapshot is present-day: the date filter cannot re-slice it,
     but the neighborhood filter can */
  const groups = [
    ["Ever closed", (f) => f.failures > 0 && f.ever_closed === 1],
    ["Conditional Pass only", (f) => f.failures > 0 && f.ever_closed !== 1],
    ["Never failed", (f) => !f.failures],
  ];
  const rows = groups.map(([name, pred]) => {
    const g = DATA.facilities.filter((f) =>
      pred(f) && f.yelp_rating !== null && f.yelp_rating !== undefined &&
      (state.hood === "all" || f.hood === state.hood));
    const n = g.length;
    const mean = n ? g.reduce((s2, f) => s2 + Number(f.yelp_rating), 0) / n : null;
    return { name, n, mean };
  });

  const el = $("#chart-yelp");
  el.replaceChildren();
  const W = Math.max(el.clientWidth || 640, 320), rowH = 30, m = { l: 170, r: 90 };
  const H = rows.length * rowH + 4;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img" });
  rows.forEach((r, i) => {
    const yy = i * rowH + 8;
    const lbl = svgEl("text", { x: m.l - 8, y: yy + 11, "text-anchor": "end", class: "stage-label" });
    lbl.textContent = r.name; svg.append(lbl);
    if (r.mean === null || r.n < 30) {
      const note = svgEl("text", { x: m.l, y: yy + 11, class: "dlabel" });
      note.textContent = r.n === 0 ? "no matched facilities" : `n=${r.n}, too few to quote`;
      svg.append(note);
      return;
    }
    /* zero-baseline on the 5-star scale, so near-equal bars look near-equal */
    const bw = (r.mean / 5) * (W - m.l - m.r);
    svg.append(svgEl("rect", { x: m.l, y: yy, width: bw, height: 12, rx: 4, fill: CSS("--series-1") }));
    const vl = svgEl("text", { x: m.l + bw + 6, y: yy + 11, class: "dlabel" });
    vl.textContent = `${r.mean.toFixed(2)} (n=${fmt(r.n)})`; svg.append(vl);
  });
  el.append(svg);

  const tbl = document.createElement("table");
  const thead = document.createElement("tr");
  for (const h of ["Group", "Matched facilities", "Mean rating"]) {
    const th = document.createElement("th"); th.textContent = h; thead.append(th);
  }
  tbl.append(thead);
  for (const r of rows) {
    const tr = document.createElement("tr");
    const c0 = document.createElement("td"); c0.textContent = r.name;
    const c1 = document.createElement("td"); c1.textContent = fmt(r.n);
    const c2 = document.createElement("td");
    c2.textContent = r.mean === null ? "n/a" : r.n < 30 ? `n/a (n=${r.n})` : r.mean.toFixed(2);
    tr.append(c0, c1, c2); tbl.append(tr);
  }
  $("#card-yelp .table-view").replaceChildren(tbl);

  const ok = rows.filter((r) => r.mean !== null && r.n >= 30);
  if (ok.length >= 2) {
    const worst = ok[0], best = ok[ok.length - 1];
    takeaway("#tk-yelp", `The ratings barely differ, and that IS the finding. `
      + `Facilities that were once shut down average ${worst.mean.toFixed(2)} stars; facilities `
      + `with a clean record average ${best.mean.toFixed(2)}. Star ratings measure taste and `
      + `service, not kitchen hygiene: you cannot spot a health risk from a review score.`);
  } else {
    takeaway("#tk-yelp", "Too few Yelp-matched facilities in this selection to compare fairly.");
  }
}

/* ---------- facility lookup ---------- */

function onSearch(e) {
  const q = e.target.value.trim().toUpperCase();
  const box = $("#search-results");
  box.replaceChildren();
  $("#facility-detail").hidden = true;
  if (q.length < 2) return;
  /* search lives in the top bar; bring the results section into view */
  const card = document.querySelector("#card-lookup");
  const rct = card.getBoundingClientRect();
  if (rct.top > innerHeight * 0.7 || rct.bottom < 120)
    window.scrollTo({ top: rct.top + scrollY - 130, behavior: "smooth" });
  const hits = DATA.facilities
    .filter((f) => (f.dba || "").toUpperCase().includes(q) ||
                   (f.address || "").toUpperCase().includes(q))
    .slice(0, 20);
  for (const f of hits) {
    const b = document.createElement("button");
    b.setAttribute("role", "option");
    const name = document.createElement("span"); name.textContent = f.dba || f.permit;
    const addr = document.createElement("span"); addr.className = "addr";
    const bits = [`${(f.address || "").replace(/\s+/g, " ")} · ${f.hood || ""}`];
    if (f.failures > 0) bits.push(`${f.failures} failure${f.failures === 1 ? "" : "s"}`);
    if (f.yelp_rating !== null && f.yelp_rating !== undefined)
      bits.push(`★ ${Number(f.yelp_rating).toFixed(1)}`);
    addr.textContent = bits.join(" · ");
    b.append(name, addr);
    b.addEventListener("click", () => showFacility(f));
    box.append(b);
  }
}

function chipFor(rating) {
  const c = document.createElement("span");
  if (rating === "Pass") { c.className = "chip pass"; c.textContent = "Pass"; }
  else if (rating === "Conditional Pass") { c.className = "chip cp"; c.textContent = "Conditional Pass"; }
  else if (rating === "Closure") { c.className = "chip closure"; c.textContent = "Closure"; }
  else { c.className = "chip unrated"; c.textContent = "No rating"; }
  return c;
}

function showFacility(f) {
  const d = $("#facility-detail");
  d.replaceChildren();
  const h = document.createElement("h3"); h.textContent = f.dba || f.permit;
  const sub = document.createElement("div"); sub.className = "muted";
  sub.textContent = `${(f.address || "").replace(/\s+/g, " ")} · ${f.hood || "Unknown"} · permit ${f.permit}`;
  d.append(h, sub);
  if (f.yelp_rating !== null && f.yelp_rating !== undefined) {
    const yl = document.createElement("div"); yl.className = "muted";
    const closed = f.yelp_closed === "True" || f.yelp_closed === true;
    yl.textContent = `Yelp: ${Number(f.yelp_rating).toFixed(1)} stars, ` +
      `${fmt(Number(f.yelp_reviews || 0))} reviews` +
      (closed ? ", marked closed on Yelp" : "");
    d.append(yl);
  }
  const ul = document.createElement("ul"); ul.className = "visits";
  const hist = (DATA.history[f.permit] || []).slice().reverse();
  for (const [date, type, rating, viol] of hist) {
    const li = document.createElement("li");
    const dt = document.createElement("span"); dt.textContent = date; dt.style.minWidth = "90px";
    const ty = document.createElement("span"); ty.className = "muted";
    ty.textContent = type || "Type pending"; ty.style.minWidth = "140px";
    const vi = document.createElement("span"); vi.className = "muted";
    vi.textContent = viol !== null ? `${viol} violation${viol === 1 ? "" : "s"}` : "";
    li.append(dt, ty, chipFor(rating), vi);
    ul.append(li);
  }
  d.append(ul);
  d.hidden = false;
}

boot();
