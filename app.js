(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ALAND = '21';

  // Base colors for files, in the order they are handed out.
  const HUES = [
    { h: 212, s: 72 }, // blue
    { h: 2, s: 72 },   // red
    { h: 135, s: 48 }, // green
    { h: 27, s: 88 },  // orange
    { h: 275, s: 48 }, // purple
    { h: 178, s: 62 }, // teal
    { h: 325, s: 62 }, // pink
    { h: 40, s: 55 },  // brown
  ];

  const state = {
    files: [],          // order = priority, first wins
    classes: 5,
    method: 'quantile',
    webCheck: true,
    nextId: 1,
  };

  // ======================================================================
  // Name lookup
  // ======================================================================

  const byCode = new Map();          // current code -> municipality record
  const oldCodeToCurrent = new Map(); // old / renamed code -> current code
  const exactIndex = new Map();      // normalized name -> entry
  const foldIndex = new Map();       // normalized name without ä/ö/å accents -> entry

  const STRENGTH = { name: 0, swedish: 0, old: 1 };

  function baseKey(s) {
    return String(s)
      .normalize('NFC')
      .toLowerCase()
      .replace(/[‐-―−]/g, '-')
      .replace(/[.'’"]/g, '')
      .replace(/\s*-\s*/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function foldKey(s) {
    return baseKey(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function putIndex(index, key, entry) {
    if (!key) return;
    const existing = index.get(key);
    if (!existing) { index.set(key, entry); return; }
    if (existing.ambiguous || existing.code === entry.code) return;
    const a = STRENGTH[existing.how], b = STRENGTH[entry.how];
    if (b < a) index.set(key, entry);
    else if (b === a) index.set(key, { ambiguous: true, codes: [existing.code, entry.code] });
  }

  function nameVariants(name) {
    const out = new Set([name]);
    // "Maarianhamina - Mariehamn" style names: each part on its own too
    if (/\s-\s/.test(name)) name.split(/\s-\s/).forEach((p) => out.add(p));
    for (const v of [...out]) {
      if (/ mlk$/i.test(v)) out.add(v.replace(/ mlk$/i, ' maalaiskunta'));
      if (/ maalaiskunta$/i.test(v)) out.add(v.replace(/ maalaiskunta$/i, ' mlk'));
      if (/ lk$/i.test(v)) out.add(v.replace(/ lk$/i, ' landskommun'));
    }
    return [...out];
  }

  function addName(name, code, how) {
    for (const v of nameVariants(name)) {
      const entry = { code, how, name: v };
      putIndex(exactIndex, baseKey(v), entry);
      putIndex(foldIndex, foldKey(v), entry);
    }
  }

  function buildLookup() {
    for (const m of window.MUNICIPALITIES) {
      byCode.set(m.code, m);
      oldCodeToCurrent.set(m.code, m.code);
    }
    for (const m of window.MUNICIPALITIES) {
      addName(m.fi, m.code, 'name');
      if (m.sv && m.sv !== m.fi) addName(m.sv, m.code, 'swedish');
    }
    for (const m of window.MUNICIPALITIES) {
      for (const o of m.old) {
        addName(o.name, m.code, 'old');
        if (!oldCodeToCurrent.has(o.code)) oldCodeToCurrent.set(o.code, m.code);
      }
    }
  }

  function displayName(m) {
    if (m.region === ALAND) return m.sv;
    return m.fi.split(/\s-\s/)[0];
  }

  // Ways a CSV value may differ from the bare municipality name.
  function inputVariants(raw) {
    const out = new Set([raw]);
    out.add(raw.replace(/\(.*?\)/g, ' '));
    out.add(raw.replace(/[()]/g, ' '));
    const suffix = /\s+(kaupunki|kunta|stad|kommun|municipality|town|city)$/i;
    for (const v of [...out]) {
      const stripped = v.trim().replace(suffix, '');
      if (stripped) out.add(stripped);
      const prefix = v.trim().replace(/^(city|town|municipality) of\s+/i, '');
      if (prefix) out.add(prefix);
    }
    return [...out].map((v) => v.trim()).filter(Boolean);
  }

  function levenshtein(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  // Returns { code, how, name } | { ambiguous: [codes] } | null
  function matchLocal(raw) {
    const variants = inputVariants(raw);
    let ambiguous = null;
    for (const v of variants) {
      const e = exactIndex.get(baseKey(v));
      if (e && !e.ambiguous) return e;
      if (e && e.ambiguous) ambiguous = e.codes;
    }
    for (const v of variants) {
      const e = foldIndex.get(foldKey(v));
      if (e && !e.ambiguous) return { ...e, how: e.how === 'old' ? 'old' : 'spelling' };
      if (e && e.ambiguous) ambiguous = e.codes;
    }
    if (ambiguous) return { ambiguous };

    // Typos: closest name within 1-2 edits, only when one municipality is clearly closest.
    let best = Infinity;
    let bestCodes = new Set();
    let bestEntry = null;
    for (const v of variants) {
      const key = foldKey(v);
      const max = key.length < 5 ? 0 : key.length <= 7 ? 1 : 2;
      if (!max) continue;
      for (const [k, e] of foldIndex) {
        if (e.ambiguous) continue;
        const d = levenshtein(key, k, Math.min(max, best));
        if (d > max) continue;
        if (d < best) { best = d; bestCodes = new Set([e.code]); bestEntry = e; }
        else if (d === best) bestCodes.add(e.code);
      }
    }
    if (bestEntry && bestCodes.size === 1) return { ...bestEntry, how: 'fuzzy' };
    if (bestCodes.size > 1) return { ambiguous: [...bestCodes] };
    return null;
  }

  // ======================================================================
  // Online check (Wikidata): find the place, walk up "located in" until a
  // Finnish municipality (it carries a municipality code, property P1203).
  // ======================================================================

  const WD_API = 'https://www.wikidata.org/w/api.php';
  const WD_FINLAND = 'Q33';
  const CACHE_PREFIX = 'breaker.webcheck.v1.';
  const entityCache = new Map();

  async function wdGet(params) {
    const url = WD_API + '?' + new URLSearchParams({ ...params, format: 'json', origin: '*' });
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function getEntities(ids) {
    const need = ids.filter((id) => !entityCache.has(id));
    for (let i = 0; i < need.length; i += 50) {
      const chunk = need.slice(i, i + 50);
      const j = await wdGet({ action: 'wbgetentities', ids: chunk.join('|'), props: 'claims|labels', languages: 'fi|sv|en' });
      for (const [id, e] of Object.entries(j.entities || {})) entityCache.set(id, e);
    }
    return ids.map((id) => entityCache.get(id)).filter((e) => e && !e.missing);
  }

  function claimValues(e, prop) {
    return ((e.claims && e.claims[prop]) || [])
      .filter((c) => c.rank !== 'deprecated' && c.mainsnak && c.mainsnak.datavalue)
      .map((c) => c.mainsnak.datavalue.value);
  }

  function entityLabel(e) {
    const l = e.labels || {};
    return (l.fi || l.sv || l.en || {}).value || e.id;
  }

  async function webLookup(name) {
    const candidates = [];
    for (const lang of ['fi', 'sv', 'en']) {
      const j = await wdGet({ action: 'wbsearchentities', search: name, language: lang, uselang: lang, type: 'item', limit: '6' });
      for (const s of j.search || []) if (!candidates.includes(s.id)) candidates.push(s.id);
      if (candidates.length >= 6) break;
    }
    await getEntities(candidates.slice(0, 8));
    for (const id of candidates.slice(0, 8)) {
      const start = entityCache.get(id);
      if (!start || start.missing) continue;
      let frontier = [id];
      const seen = new Set();
      for (let depth = 0; depth < 5 && frontier.length; depth++) {
        const next = [];
        for (const e of await getEntities(frontier)) {
          seen.add(e.id);
          const countries = claimValues(e, 'P17').map((v) => v.id);
          if (countries.length && !countries.includes(WD_FINLAND)) continue;
          for (const raw of claimValues(e, 'P1203')) {
            const code = oldCodeToCurrent.get(String(raw).padStart(3, '0'));
            if (code) return { code, place: entityLabel(start) };
          }
          for (const v of claimValues(e, 'P131')) if (v && v.id && !seen.has(v.id)) next.push(v.id);
        }
        frontier = next;
      }
    }
    return null;
  }

  function cacheGet(key) {
    try {
      const v = localStorage.getItem(CACHE_PREFIX + key);
      return v ? JSON.parse(v) : undefined;
    } catch (e) { return undefined; }
  }
  function cacheSet(key, value) {
    try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }

  const webQueue = [];
  let webBusy = false;

  function queueWebCheck(file, row) {
    webQueue.push({ file, row });
    file.pending++;
    runWebQueue();
  }

  async function runWebQueue() {
    if (webBusy) return;
    webBusy = true;
    while (webQueue.length) {
      updateWebStatus();
      const { file, row } = webQueue.shift();
      if (!state.files.includes(file)) continue;
      const key = foldKey(row.location);
      let result = cacheGet(key);
      let error = null;
      if (result === undefined) {
        try {
          result = await webLookup(row.location);
          cacheSet(key, result);
        } catch (e) {
          error = e;
          result = null;
        }
      }
      file.pending--;
      if (!state.files.includes(file)) continue;
      if (result && byCode.has(result.code)) {
        addMatch(file, row, { code: result.code, how: 'web', name: result.place });
      } else {
        file.skipped.push({
          line: row.line,
          raw: row.location,
          reason: error ? 'not found; online check failed (offline?)' : 'not found, also not online',
        });
      }
      render();
    }
    webBusy = false;
    updateWebStatus();
  }

  function updateWebStatus() {
    const el = document.getElementById('web-status');
    const n = webQueue.length + (webBusy ? 1 : 0);
    if (webBusy && n > 0) {
      el.hidden = false;
      el.textContent = `Checking ${n} unknown name${n === 1 ? '' : 's'} online…`;
    } else {
      el.hidden = true;
    }
  }

  // ======================================================================
  // CSV reading
  // ======================================================================

  function decodeText(buffer) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (e) {
      return new TextDecoder('windows-1252').decode(buffer); // Excel "CSV" export on Finnish Windows
    }
  }

  function splitLine(line, delim) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function detectDelimiter(line) {
    const count = (ch) => splitLine(line, ch).length - 1;
    if (count(';') > 0) return ';';
    if (count('\t') > 0) return '\t';
    return ',';
  }

  function parseNumber(s) {
    let t = String(s).replace(/[\s  ]/g, '');
    if (!t) return NaN;
    if (t.includes(',') && t.includes('.')) {
      t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    } else if (t.includes(',')) {
      t = t.replace(',', '.');
    }
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : NaN;
  }

  function parseCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
    const first = lines.find((l) => l.trim());
    if (!first) return { rows: [], skipped: [] };
    const delim = detectDelimiter(first);
    const rows = [];
    const skipped = [];
    let seenData = false;
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const f = splitLine(line, delim);
      const location = f[0] || '';
      let numText = f[1] || '';
      // "Espoo,12,5" = decimal comma in an unquoted comma-separated file
      if (delim === ',' && f.length === 3 && /^\d+$/.test(f[2]) && /^-?\d+$/.test(f[1])) numText = f[1] + '.' + f[2];
      const value = parseNumber(numText);
      if (!seenData && isNaN(value)) {
        seenData = true;
        return; // header row
      }
      seenData = true;
      if (!location) skipped.push({ line: i + 1, raw: line, reason: 'location is empty' });
      else if (!numText) skipped.push({ line: i + 1, raw: location, reason: 'number is missing' });
      else if (isNaN(value)) skipped.push({ line: i + 1, raw: location, reason: `number "${numText}" is not valid` });
      else rows.push({ line: i + 1, location, value });
    });
    return { rows, skipped };
  }

  // ======================================================================
  // Files
  // ======================================================================

  function nextHue() {
    const used = state.files.map((f) => f.hue);
    for (let i = 0; i < HUES.length; i++) if (!used.includes(i)) return i;
    return state.files.length % HUES.length;
  }

  function addMatch(file, row, match) {
    const existing = file.values.get(match.code);
    if (existing) {
      existing.value += row.value;
      existing.rows.push(row);
      file.notes.push({ line: row.line, raw: row.location, code: match.code, how: 'sum', name: match.name, origHow: match.how });
    } else {
      file.values.set(match.code, { value: row.value, rows: [row] });
      if (match.how !== 'name') file.notes.push({ line: row.line, raw: row.location, code: match.code, how: match.how, name: match.name });
    }
  }

  async function loadFiles(fileList) {
    for (const f of fileList) {
      const text = decodeText(await f.arrayBuffer());
      const { rows, skipped } = parseCsv(text);
      const file = {
        id: state.nextId++,
        name: f.name,
        hue: nextHue(),
        visible: true,
        rowCount: rows.length + skipped.length,
        values: new Map(),
        notes: [],
        skipped,
        pending: 0,
        breaks: null,
      };
      state.files.push(file);
      for (const row of rows) {
        const m = matchLocal(row.location);
        if (m && !m.ambiguous) addMatch(file, row, m);
        else if (state.webCheck) queueWebCheck(file, row);
        else {
          const reason = m && m.ambiguous
            ? 'could be ' + m.ambiguous.map((c) => byCode.get(c).fi).join(' or ')
            : 'not found';
          skipped.push({ line: row.line, raw: row.location, reason });
        }
      }
    }
    render();
  }

  // ======================================================================
  // Classes and colors
  // ======================================================================

  function shade(file, k) {
    const hue = HUES[file.hue];
    const n = state.classes;
    const t = n === 1 ? 1 : k / (n - 1);
    const light = 90 - t * 60;
    const sat = hue.s + t * 8;
    return `hsl(${hue.h}, ${Math.min(sat, 100)}%, ${light}%)`;
  }

  // Assigns each value a class 0..n-1 and returns the value range of each class.
  function computeClasses(file) {
    const n = state.classes;
    const entries = [...file.values.entries()];
    const values = entries.map(([, v]) => v.value).sort((a, b) => a - b);
    const classOf = new Map();
    if (!values.length) { file.classOf = classOf; file.ranges = []; return; }
    const distinct = [...new Set(values)];
    const min = values[0], max = values[values.length - 1];

    let classify;
    if (distinct.length <= n) {
      // Few different numbers: spread them over the shades, keeping the biggest darkest.
      classify = (v) => distinct.length === 1 ? n - 1 : Math.round(distinct.indexOf(v) * (n - 1) / (distinct.length - 1));
    } else if (state.method === 'equal') {
      classify = (v) => Math.min(n - 1, Math.floor((v - min) / (max - min) * n));
    } else {
      // Equal counts: position of the value among all values (ties get the same shade).
      const firstIndex = new Map();
      values.forEach((v, i) => { if (!firstIndex.has(v)) firstIndex.set(v, i); });
      classify = (v) => Math.min(n - 1, Math.floor(firstIndex.get(v) * n / values.length));
    }

    const ranges = Array.from({ length: n }, () => null);
    for (const [code, v] of entries) {
      const k = classify(v.value);
      classOf.set(code, k);
      const r = ranges[k];
      if (!r) ranges[k] = { min: v.value, max: v.value, count: 1 };
      else { r.min = Math.min(r.min, v.value); r.max = Math.max(r.max, v.value); r.count++; }
    }
    file.classOf = classOf;
    file.ranges = ranges;
  }

  const numberFormat = new Intl.NumberFormat('fi-FI', { maximumFractionDigits: 2 });
  const fmt = (v) => numberFormat.format(v);

  // ======================================================================
  // Map
  // ======================================================================

  const mapEl = document.getElementById('map');
  const tooltip = document.getElementById('tooltip');
  const pathByCode = new Map();
  let svg, highlight;
  let view;

  function buildMap() {
    const data = window.MAP_DATA;
    view = { x: 0, y: 0, w: data.width, h: data.height };
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${data.width} ${data.height}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Map of Finnish municipalities');

    const shapes = document.createElementNS(SVG_NS, 'g');
    const labels = document.createElementNS(SVG_NS, 'g');
    labels.setAttribute('class', 'labels');
    for (const [code, s] of Object.entries(data.shapes)) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', s.d);
      p.setAttribute('class', 'mun');
      p.setAttribute('fill-rule', 'evenodd');
      p.dataset.code = code;
      shapes.appendChild(p);
      pathByCode.set(code, p);
    }
    highlight = document.createElementNS(SVG_NS, 'path');
    highlight.setAttribute('class', 'highlight');
    svg.append(shapes, highlight, labels);
    mapEl.appendChild(svg);

    // Labels sized to fit the municipality's width (needs the paths to be in the page first).
    for (const [code, s] of Object.entries(data.shapes)) {
      const m = byCode.get(code);
      if (!m) continue;
      const name = displayName(m);
      const box = pathByCode.get(code).getBBox();
      const size = Math.max(1.6, Math.min(6, (box.width * 0.9) / (name.length * 0.55), box.height * 0.5));
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', s.label[0]);
      t.setAttribute('y', s.label[1]);
      t.setAttribute('font-size', size.toFixed(2));
      t.textContent = name;
      labels.appendChild(t);
    }
    setupInteraction();
  }

  // Color of a municipality: the first visible file (in list order) that has it.
  function fillFor(code) {
    const file = state.files.find((f) => f.visible && f.values.has(code));
    return file ? shade(file, file.classOf.get(code)) : '';
  }

  function paintMap() {
    for (const [code, p] of pathByCode) p.style.fill = fillFor(code);
  }

  function setView(v) {
    const data = window.MAP_DATA;
    v.w = Math.min(data.width, Math.max(data.width / 16, v.w));
    v.h = v.w * data.height / data.width;
    v.x = Math.min(data.width - v.w, Math.max(0, v.x));
    v.y = Math.min(data.height - v.h, Math.max(0, v.y));
    view = v;
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    mapEl.classList.toggle('zoomed', v.w < data.width - 0.01);
  }

  function zoom(factor, cx, cy) {
    if (cx === undefined) { cx = view.x + view.w / 2; cy = view.y + view.h / 2; }
    const w = view.w / factor;
    const h = view.h / factor;
    setView({ x: cx - (cx - view.x) / factor, y: cy - (cy - view.y) / factor, w, h });
  }

  function toMapPoint(evt) {
    const r = svg.getBoundingClientRect();
    return { x: view.x + (evt.clientX - r.left) / r.width * view.w, y: view.y + (evt.clientY - r.top) / r.height * view.h };
  }

  function setupInteraction() {
    let drag = null;

    svg.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, view: { ...view }, moved: false, id: e.pointerId };
    });
    window.addEventListener('pointermove', (e) => {
      if (drag && drag.id === e.pointerId) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4 && mapEl.classList.contains('zoomed')) {
          drag.moved = true;
          mapEl.classList.add('panning');
          hideTooltip();
        }
        if (drag.moved) {
          const r = svg.getBoundingClientRect();
          setView({ ...drag.view, x: drag.view.x - dx / r.width * drag.view.w, y: drag.view.y - dy / r.height * drag.view.h });
          return;
        }
      }
      const target = e.target;
      if (target instanceof SVGPathElement && target.dataset.code && svg.contains(target)) showTooltip(target.dataset.code, e);
      else hideTooltip();
    });
    window.addEventListener('pointerup', (e) => {
      if (drag && drag.id === e.pointerId) {
        // A tap on a touch screen shows the tooltip like hovering does with a mouse.
        if (!drag.moved && e.pointerType !== 'mouse' && e.target instanceof SVGPathElement && e.target.dataset.code) {
          showTooltip(e.target.dataset.code, e);
        }
        mapEl.classList.remove('panning');
        drag = null;
      }
    });
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideTooltip(); });
    svg.addEventListener('dblclick', (e) => {
      const p = toMapPoint(e);
      zoom(2, p.x, p.y);
    });
    document.getElementById('zoom-in').addEventListener('click', () => zoom(2));
    document.getElementById('zoom-out').addEventListener('click', () => zoom(0.5));
    document.getElementById('zoom-reset').addEventListener('click', () => setView({ x: 0, y: 0, w: window.MAP_DATA.width }));
    document.getElementById('download-png').addEventListener('click', downloadPng);
    document.getElementById('download-svg').addEventListener('click', downloadSvg);
  }

  // ======================================================================
  // Image download: the whole map as currently colored, with a legend band
  // ======================================================================

  const EXPORT_PNG_WIDTH = 2000;

  function xml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Builds a standalone SVG (styles inlined, since the page's CSS doesn't travel with the file).
  function buildExportSvg() {
    const data = window.MAP_DATA;
    const W = data.width, H = data.height;
    const pad = 12;
    const parts = [];

    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#e3f0fa"/>`);
    parts.push('<g stroke="#8a8f98" stroke-width="0.25" stroke-linejoin="round" fill-rule="evenodd">');
    for (const [code, p] of pathByCode) {
      parts.push(`<path d="${p.getAttribute('d')}" fill="${fillFor(code) || '#ffffff'}"/>`);
    }
    parts.push('</g>');

    if (!mapEl.classList.contains('no-labels')) {
      parts.push('<g font-family="Arial, sans-serif" fill="#222" stroke="#ffffff" stroke-opacity="0.75" stroke-width="0.5" paint-order="stroke" text-anchor="middle" dominant-baseline="central">');
      for (const t of svg.querySelectorAll('.labels text')) {
        parts.push(`<text x="${t.getAttribute('x')}" y="${t.getAttribute('y')}" font-size="${t.getAttribute('font-size')}">${xml(t.textContent)}</text>`);
      }
      parts.push('</g>');
    }

    // Legend: one block per visible file, in priority order.
    let y = H + pad;
    const legend = [];
    const files = state.files.filter((f) => f.visible && f.values.size);
    for (const f of files) {
      legend.push(`<text x="${pad}" y="${y + 8}" font-size="9" font-weight="bold">${xml(f.name)}</text>`);
      y += 13;
      const stepW = Math.min(110, (W - 2 * pad) / f.ranges.length);
      f.ranges.forEach((r, k) => {
        const x = pad + k * stepW;
        const label = r ? (r.min === r.max ? fmt(r.min) : `${fmt(r.min)} – ${fmt(r.max)}`) : '–';
        legend.push(`<rect x="${x}" y="${y}" width="${stepW - 2}" height="9" fill="${shade(f, k)}" stroke="#00000022" stroke-width="0.3"/>`);
        legend.push(`<text x="${x}" y="${y + 17}" font-size="7" fill="#5d6676">${xml(label)}</text>`);
      });
      y += 30;
    }
    const credit = `Municipalities ${window.MUNICIPALITY_YEAR}: Statistics Finland, CC BY 4.0`;
    legend.push(`<text x="${pad}" y="${y + 6}" font-size="6" fill="#5d6676">${xml(credit)}</text>`);
    y += 6 + pad;

    const totalH = Math.ceil(y);
    return {
      width: W,
      height: totalH,
      text: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${totalH}" width="${W * 2}" height="${totalH * 2}">` +
        `<rect x="0" y="0" width="${W}" height="${totalH}" fill="#ffffff"/>` +
        parts.join('') +
        `<g font-family="Arial, sans-serif" fill="#1d2330">${legend.join('')}</g></svg>`,
    };
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadSvg() {
    const { text } = buildExportSvg();
    saveBlob(new Blob([text], { type: 'image/svg+xml' }), 'municipality-map.svg');
  }

  function downloadPng() {
    const { width, height, text } = buildExportSvg();
    const outW = EXPORT_PNG_WIDTH;
    const outH = Math.round(outW * height / width);
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      canvas.getContext('2d').drawImage(img, 0, 0, outW, outH);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => saveBlob(blob, 'municipality-map.png'), 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert('Could not create the PNG image. Try "Download SVG" instead.');
    };
    img.src = url;
  }

  let tooltipCode = null;

  function showTooltip(code, evt) {
    const m = byCode.get(code);
    if (!m) return;
    if (tooltipCode !== code) {
      tooltipCode = code;
      highlight.setAttribute('d', pathByCode.get(code).getAttribute('d'));
      const region = window.REGIONS[m.region];
      const fiName = m.fi.split(/\s-\s/)[0];
      const names = m.sv && m.sv !== fiName ? `${fiName} / ${m.sv}` : fiName;
      const winner = state.files.find((f) => f.visible && f.values.has(code));
      const rows = state.files.filter((f) => f.values.has(code)).map((f) => {
        const v = f.values.get(code);
        let note = '';
        if (!f.visible) note = ' (hidden)';
        else if (f !== winner) note = ' (covered)';
        return `<div class="tt-row${f === winner ? '' : ' dim'}">
          <span class="sw" style="background:${shade(f, f.classOf.get(code))}"></span>
          <span class="tt-file">${esc(f.name)}${note}</span>
          <span class="tt-val">${fmt(v.value)}</span></div>`;
      });
      tooltip.innerHTML = `<div class="tt-name">${esc(names)}</div>
        <div class="tt-sub">${esc(region ? region.fi : '')}</div>
        ${rows.length ? rows.join('') : '<div class="tt-none">No data</div>'}`;
      tooltip.hidden = false;
    }
    const pad = 14;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + tw > window.innerWidth - 4) x = evt.clientX - tw - pad;
    if (y + th > window.innerHeight - 4) y = evt.clientY - th - pad;
    tooltip.style.left = Math.max(4, x) + 'px';
    tooltip.style.top = Math.max(4, y) + 'px';
  }

  function hideTooltip() {
    if (tooltipCode === null) return;
    tooltipCode = null;
    tooltip.hidden = true;
    highlight.removeAttribute('d');
  }

  // ======================================================================
  // Panels
  // ======================================================================

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderFiles() {
    const list = document.getElementById('file-list');
    document.getElementById('files-panel').hidden = state.files.length === 0;
    list.innerHTML = '';
    state.files.forEach((f, i) => {
      const li = document.createElement('li');
      li.className = 'file' + (f.visible ? '' : ' hidden-file');
      const matchedRows = [...f.values.values()].reduce((n, v) => n + v.rows.length, 0);
      const stats = [
        `${f.rowCount} rows`,
        `${f.values.size} municipalities on map`,
        f.skipped.length ? `${f.skipped.length} skipped` : '',
        f.pending ? `${f.pending} being checked online` : '',
      ].filter(Boolean).join(' · ');
      const ramp = f.ranges.map((r, k) => `
        <div class="ramp-step">
          <div class="ramp-color" style="background:${shade(f, k)}"></div>
          <div class="ramp-range">${r ? (r.min === r.max ? fmt(r.min) : `${fmt(r.min)} – ${fmt(r.max)}`) : '–'}</div>
        </div>`).join('');
      li.innerHTML = `
        <div class="file-head">
          <input type="checkbox" ${f.visible ? 'checked' : ''} title="Show on map" aria-label="Show ${esc(f.name)} on map">
          <span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>
          <button type="button" class="icon-btn" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
          <button type="button" class="icon-btn" data-act="down" title="Move down" ${i === state.files.length - 1 ? 'disabled' : ''}>&#9660;</button>
          <button type="button" class="icon-btn" data-act="remove" title="Remove file">&times;</button>
        </div>
        <div class="file-body">
          <div class="file-stats">${stats}${matchedRows > f.values.size ? ' · some rows added together' : ''}</div>
          <div class="ramp">${ramp}</div>
        </div>`;
      li.querySelector('input').addEventListener('change', (e) => { f.visible = e.target.checked; render(); });
      li.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        const idx = state.files.indexOf(f);
        if (b.dataset.act === 'remove') state.files.splice(idx, 1);
        else {
          const to = b.dataset.act === 'up' ? idx - 1 : idx + 1;
          state.files.splice(idx, 1);
          state.files.splice(to, 0, f);
        }
        render();
      }));
      list.appendChild(li);
    });
  }

  const HOW_TEXT = {
    swedish: 'Swedish name',
    spelling: 'spelling (ä/ö/å)',
    old: 'old municipality / earlier name',
    fuzzy: 'probable typo',
    web: 'online check',
  };

  function renderReport() {
    const panel = document.getElementById('report-panel');
    const body = document.getElementById('report-body');
    let total = 0;
    let skippedTotal = 0;
    const parts = state.files.map((f) => {
      const items = [
        ...f.notes.map((n) => ({ line: n.line, html: noteHtml(n) })),
        ...f.skipped.map((s) => ({ line: s.line, html: `<td>${esc(s.raw)}</td><td><span class="tag skip">skipped</span> ${esc(s.reason)}</td>` })),
      ].sort((a, b) => a.line - b.line);
      total += items.length;
      skippedTotal += f.skipped.length;
      if (!items.length) return '';
      return `<div class="report-file"><h3>${esc(f.name)}</h3>
        <table class="report-table"><thead><tr><th>Row</th><th>Location in file</th><th>Result</th></tr></thead>
        <tbody>${items.map((it) => `<tr><td>${it.line}</td>${it.html}</tr>`).join('')}</tbody></table></div>`;
    }).join('');
    panel.hidden = total === 0;
    document.getElementById('report-count').textContent =
      `(${total - skippedTotal} matched differently, ${skippedTotal} skipped)`;
    body.innerHTML = parts;
  }

  function noteHtml(n) {
    const target = byCode.get(n.code).fi;
    const how = n.how === 'sum' ? n.origHow : n.how;
    const cls = how === 'web' ? 'web' : how === 'fuzzy' ? 'fuzzy' : '';
    let detail = '';
    if (how === 'web' && n.name) detail = ` (found “${esc(n.name)}”)`;
    if (n.how === 'sum') detail += ' – same municipality as an earlier row, values added together';
    const tag = HOW_TEXT[how] ? ` <span class="tag ${cls}">${HOW_TEXT[how]}</span>` : '';
    return `<td>${esc(n.raw)}</td><td>→ <strong>${esc(target)}</strong>${tag}${detail}</td>`;
  }

  function render() {
    state.files.forEach(computeClasses);
    renderFiles();
    renderReport();
    paintMap();
    tooltipCode = null;
    tooltip.hidden = true;
    if (highlight) highlight.removeAttribute('d');
    updateWebStatus();
  }

  // ======================================================================
  // Controls
  // ======================================================================

  function setupControls() {
    const input = document.getElementById('file-input');
    input.addEventListener('change', () => {
      loadFiles([...input.files]);
      input.value = '';
    });

    const drop = document.getElementById('drop');
    let depth = 0;
    document.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('dragging'); });
    document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('dragging'); } });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      drop.classList.remove('dragging');
      const files = [...e.dataTransfer.files];
      if (files.length) loadFiles(files);
    });

    document.querySelectorAll('input[name="classes"]').forEach((r) => r.addEventListener('change', () => {
      state.classes = Number(r.value);
      render();
    }));
    document.querySelectorAll('input[name="method"]').forEach((r) => r.addEventListener('change', () => {
      state.method = r.value;
      render();
    }));
    document.getElementById('web-check').addEventListener('change', (e) => { state.webCheck = e.target.checked; });
    document.getElementById('show-labels').addEventListener('change', (e) => {
      mapEl.classList.toggle('no-labels', !e.target.checked);
    });

    // Restore form state the browser may keep after a reload.
    state.classes = Number(document.querySelector('input[name="classes"]:checked').value);
    state.method = document.querySelector('input[name="method"]:checked').value;
    state.webCheck = document.getElementById('web-check').checked;
    mapEl.classList.toggle('no-labels', !document.getElementById('show-labels').checked);
  }

  buildLookup();
  buildMap();
  setupControls();

  // Exposed for testing in the browser console.
  window.breaker = { matchLocal, webLookup, parseCsv, loadFiles, state };
})();
