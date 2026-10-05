'use strict';
/* Pen Journal — handwritten journal with categories, stickies, voice memos and Google Drive sync.
   All data lives in IndexedDB; Drive holds one rolling backup file plus a dated snapshot per day. */

const $ = (s) => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);
const STICKY_COLORS = ['#fff1a8', '#ffd1dc', '#c9f0d2', '#cfe6ff', '#ffe0b5'];

/* ---------------- storage (IndexedDB) ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('pen-journal', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('notes', { keyPath: 'id' });
        r.result.createObjectStore('meta');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('notes', 'readonly', (s) => s.getAll()); },
  put(n) { return this.tx('notes', 'readwrite', (s) => s.put(n)); },
  del(id) { return this.tx('notes', 'readwrite', (s) => s.delete(id)); },
  get(k) { return this.tx('meta', 'readonly', (s) => s.get(k)); },
  set(k, v) { return this.tx('meta', 'readwrite', (s) => s.put(v, k)); },
};

/* ---------------- state ---------------- */
const S = {
  notes: [],          // every note, sorted
  view: [],           // notes currently being flipped through (filter applied)
  idx: 0,
  categories: [],     // [{name, color}]
  tombs: {},          // deleted id -> timestamp (so deletions sync)
  filter: null,
  tool: 'pen', color: '#1d2b53', width: 3,
};
const cur = () => S.view[S.idx];
const catColor = (name) => (S.categories.find((c) => c.name === name) || {}).color || 'transparent';

function newNote(date = today()) {
  return { id: uid(), date, title: '', category: S.categories[0]?.name || '', strokes: [], stickies: [], created: Date.now(), updatedAt: Date.now() };
}
function sortNotes(list, mode = 'date') {
  return list.sort((a, b) =>
    (mode === 'category' ? (a.category || '').localeCompare(b.category || '') : 0) ||
    a.date.localeCompare(b.date) || a.created - b.created);
}

let saveTimer;
function touch(note = cur()) {
  note.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await DB.put(note); Sync.schedule(); }, 400);
}

/* ---------------- status toast ---------------- */
let statusTimer;
function status(msg, ms = 2200) {
  const el = $('#status'); el.textContent = msg; el.classList.add('show');
  clearTimeout(statusTimer); statusTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------------- ink canvas ---------------- */
const canvas = $('#ink');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;

function resizeCanvas() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}
// Points are stored normalised (0..1) so a page looks the same on the phone and on a desktop browser.
function segWidth(s, p) {
  const base = s.w * W / 700;
  return s.tool === 'highlighter' ? base * 4 : base * (0.35 + 1.1 * p);
}
function drawSegment(s, a, b) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color;
  if (s.tool === 'highlighter') { ctx.globalAlpha = 0.28; ctx.globalCompositeOperation = 'multiply'; }
  ctx.lineWidth = segWidth(s, (a[2] + b[2]) / 2);
  ctx.beginPath(); ctx.moveTo(a[0] * W, a[1] * H); ctx.lineTo(b[0] * W, b[1] * H); ctx.stroke();
  ctx.restore();
}
function drawStroke(s) {
  const p = s.pts;
  if (p.length === 1) return drawSegment(s, p[0], [p[0][0] + 0.0001, p[0][1], p[0][2]]);
  if (s.tool === 'highlighter') { // one path so overlapping segments don't darken
    ctx.save(); ctx.globalAlpha = 0.28; ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = s.color; ctx.lineWidth = segWidth(s, 0.5); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(p[0][0] * W, p[0][1] * H);
    for (const q of p) ctx.lineTo(q[0] * W, q[1] * H);
    ctx.stroke(); ctx.restore(); return;
  }
  for (let i = 1; i < p.length; i++) drawSegment(s, p[i - 1], p[i]);
}
function redraw() {
  ctx.clearRect(0, 0, W, H);
  const n = cur(); if (!n) return;
  n.strokes.filter((s) => s.tool === 'highlighter').forEach(drawStroke);
  n.strokes.filter((s) => s.tool !== 'highlighter').forEach(drawStroke);
}

/* Pointer handling: pen and mouse write; a finger swipes pages (palm rejection for free). */
let live = null, erasing = false, swipe = null, sawPen = false;
const norm = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.pointerType === 'mouse' ? 0.5 : (e.pressure || 0.5)]; };

function eraseAt(pt) {
  const n = cur(), rad = 0.018, before = n.strokes.length;
  n.strokes = n.strokes.filter((s) => !s.pts.some((q) => Math.hypot(q[0] - pt[0], (q[1] - pt[1]) * 1.414) < rad));
  if (n.strokes.length !== before) { redraw(); touch(); }
}

canvas.addEventListener('pointerdown', (e) => {
  if (!cur()) return;
  if (e.pointerType === 'pen') sawPen = true;
  if (e.pointerType === 'touch') { swipe = { x: e.clientX, y: e.clientY, t: Date.now() }; return; }
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  // S-Pen side button reports as buttons & 2; some styluses report eraser end as buttons & 32
  erasing = S.tool === 'eraser' || (e.buttons & 2) || (e.buttons & 32);
  if (erasing) { eraseAt(norm(e)); return; }
  live = { tool: S.tool, color: S.color, w: S.width, pts: [norm(e)] };
  drawSegment(live, live.pts[0], live.pts[0]);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (!evs.length) evs = [e];
  if (erasing && e.buttons) { evs.forEach((ev) => eraseAt(norm(ev))); return; }
  if (!live) return;
  for (const ev of evs) {
    const p = norm(ev), last = live.pts[live.pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.0012) continue;
    live.pts.push(p);
    if (live.tool !== 'highlighter') drawSegment(live, last, p);
  }
  if (live.tool === 'highlighter') { redraw(); drawStroke(live); }
});
const endStroke = () => {
  if (live) { cur().strokes.push(live); live = null; redraw(); touch(); }
  erasing = false;
};
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch' && swipe) {
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - swipe.t < 800) flip(dx < 0 ? 1 : -1);
    swipe = null; return;
  }
  endStroke();
});
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------------- page rendering & flipping ---------------- */
function renderPage() {
  const n = cur();
  $('#noteDate').value = n ? n.date : '';
  $('#noteTitle').value = n ? n.title : '';
  fillCatSelect($('#noteCat'), false);
  $('#noteCat').value = n ? n.category : '';
  $('#ribbon').style.setProperty('--cat', n ? catColor(n.category) : 'transparent');
  $('#pageNo').textContent = S.view.length ? `${S.idx + 1} / ${S.view.length}` : '';
  renderStickies();
  redraw();
}

let flipping = false;
async function flip(dir) {
  const next = S.idx + dir;
  if (flipping) return;
  if (next < 0) return status('First page');
  if (next >= S.view.length) {
    if (S.filter) return status('End of results');
    return addPage();
  }
  flipping = true;
  const page = $('#page');
  // Turning forward: page swings left around the spine. Backward: previous page swings back in.
  const out = dir > 0
    ? [{ transform: 'rotateY(0)' }, { transform: 'rotateY(-95deg)', filter: 'brightness(.7)' }]
    : [{ transform: 'rotateY(0)' }, { transform: 'rotateY(30deg) translateX(4%)', opacity: 0.2 }];
  await page.animate(out, { duration: 260, easing: 'ease-in' }).finished;
  S.idx = next; renderPage();
  const inn = dir > 0
    ? [{ transform: 'rotateY(18deg)', opacity: 0.4 }, { transform: 'rotateY(0)', opacity: 1 }]
    : [{ transform: 'rotateY(-95deg)', filter: 'brightness(.7)' }, { transform: 'rotateY(0)' }];
  await page.animate(inn, { duration: 280, easing: 'ease-out' }).finished;
  flipping = false;
}

async function addPage() {
  clearFilter(false);
  const n = newNote();
  if (S.notes.length) n.category = S.notes[S.notes.length - 1].category;
  S.notes.push(n); sortNotes(S.notes);
  await DB.put(n);
  S.view = S.notes; S.idx = S.view.indexOf(n);
  renderPage(); Sync.schedule();
  status('New page');
}

/* ---------------- page header fields ---------------- */
$('#noteDate').addEventListener('change', (e) => { const n = cur(); n.date = e.target.value || today(); touch(n); sortNotes(S.notes); S.idx = S.view.indexOf(n); renderPage(); });
$('#noteTitle').addEventListener('input', (e) => { cur().title = e.target.value; touch(); });
$('#noteCat').addEventListener('change', (e) => { cur().category = e.target.value; touch(); renderPage(); });

function fillCatSelect(sel, withAll) {
  const v = sel.value;
  sel.innerHTML = (withAll ? '<option value="">All categories</option>' : '<option value="">— no category —</option>') +
    S.categories.map((c) => `<option>${esc(c.name)}</option>`).join('');
  sel.value = v;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- stickies ---------------- */
function renderStickies() {
  const host = $('#stickies'); host.innerHTML = '';
  const n = cur(); if (!n) return;
  for (const st of n.stickies) host.appendChild(stickyEl(st));
}
function stickyEl(st) {
  const el = document.createElement('div');
  el.className = 'sticky';
  el.style.left = st.x * 100 + '%'; el.style.top = st.y * 100 + '%';
  el.style.setProperty('--sc', st.color); el.style.setProperty('--rot', st.rot + 'deg');
  el.innerHTML = `<div class="bar"><span>${st.type === 'voice' ? '🎙 voice memo' : '📝'}</span>
    <span><button class="c" title="Colour">🎨</button><button class="x" title="Remove">✕</button></span></div>`;
  if (st.type === 'voice') {
    const a = document.createElement('audio'); a.controls = true; a.src = st.audio; el.appendChild(a);
    const t = document.createElement('textarea'); t.placeholder = 'caption…'; t.value = st.text || ''; t.rows = 2;
    t.oninput = () => { st.text = t.value; touch(); }; el.appendChild(t);
  } else {
    const t = document.createElement('textarea'); t.placeholder = 'Type a note…'; t.value = st.text || '';
    t.oninput = () => { st.text = t.value; touch(); }; el.appendChild(t);
    setTimeout(() => { if (!st.text) t.focus(); }, 50);
  }
  el.querySelector('.x').onclick = () => {
    if ((st.text || st.audio) && !confirm('Remove this sticky note?')) return;
    cur().stickies = cur().stickies.filter((x) => x !== st); touch(); renderStickies();
  };
  el.querySelector('.c').onclick = () => {
    st.color = STICKY_COLORS[(STICKY_COLORS.indexOf(st.color) + 1) % STICKY_COLORS.length];
    el.style.setProperty('--sc', st.color); touch();
  };
  // drag by the bar
  const bar = el.querySelector('.bar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    try { bar.setPointerCapture(e.pointerId); } catch {}
    const r = $('#page').getBoundingClientRect(), sx = e.clientX, sy = e.clientY, ox = st.x, oy = st.y;
    const move = (ev) => {
      st.x = Math.min(0.9, Math.max(0, ox + (ev.clientX - sx) / r.width));
      st.y = Math.min(0.92, Math.max(0, oy + (ev.clientY - sy) / r.height));
      el.style.left = st.x * 100 + '%'; el.style.top = st.y * 100 + '%';
    };
    const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); touch(); };
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up);
  });
  return el;
}
function addSticky(extra) {
  const n = cur(); if (!n) return;
  const k = n.stickies.length;
  const st = { id: uid(), type: 'text', text: '', x: 0.6 - (k % 3) * 0.05, y: 0.12 + (k % 5) * 0.08,
    rot: (Math.random() * 5 - 2.5).toFixed(1), color: STICKY_COLORS[k % STICKY_COLORS.length], ...extra };
  n.stickies.push(st); touch(); renderStickies();
}
$('#btnSticky').onclick = () => addSticky();

/* voice memo */
let rec = null;
$('#btnVoice').onclick = async () => {
  if (rec) { rec.stop(); return; }
  if (!cur()) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [], started = Date.now();
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      $('#btnVoice').classList.remove('rec'); rec = null;
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      const fr = new FileReader();
      fr.onload = () => addSticky({ type: 'voice', audio: fr.result, dur: Math.round((Date.now() - started) / 1000), color: '#cfe6ff' });
      fr.readAsDataURL(blob); // data URL so the memo travels inside the JSON backup
    };
    rec.start(); $('#btnVoice').classList.add('rec'); status('Recording… tap 🎙 again to stop', 3000);
  } catch (err) { status('Microphone unavailable: ' + err.message, 4000); }
};

/* ---------------- toolbar ---------------- */
document.querySelectorAll('[data-tool]').forEach((b) => b.onclick = () => {
  S.tool = b.dataset.tool;
  document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('on', x === b));
});
document.querySelectorAll('.swatch').forEach((b) => b.onclick = () => {
  S.color = b.dataset.color;
  document.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
  if (S.tool === 'eraser') document.querySelector('[data-tool=pen]').click();
});
$('#width').oninput = (e) => S.width = +e.target.value;
$('#btnUndo').onclick = () => { const n = cur(); if (n && n.strokes.pop()) { redraw(); touch(); } };
$('#btnNew').onclick = addPage;
$('#btnPrev').onclick = () => flip(-1);
$('#btnNext').onclick = () => flip(1);
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea,select')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') flip(1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') flip(-1);
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') $('#btnUndo').click();
});

/* ---------------- search / filter ---------------- */
const openDrawer = (id) => { document.querySelectorAll('.drawer').forEach((d) => d.hidden = d.id !== id); };
$('#btnSearch').onclick = () => { fillCatSelect($('#fCat'), true); openDrawer('drawer'); runSearch(); $('#fText').focus(); };
$('#btnCloseDrawer').onclick = () => $('#drawer').hidden = true;

function matches(n, f) {
  if (f.cat && n.category !== f.cat) return false;
  if (f.from && n.date < f.from) return false;
  if (f.to && n.date > f.to) return false;
  if (f.text) {
    const hay = [n.title, n.category, n.date, ...n.stickies.map((s) => s.text || '')].join(' ').toLowerCase();
    if (!f.text.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}
const readFilter = () => ({ text: $('#fText').value.trim(), cat: $('#fCat').value, from: $('#fFrom').value, to: $('#fTo').value, sort: $('#fSort').value });
function runSearch() {
  const f = readFilter();
  const res = sortNotes(S.notes.filter((n) => matches(n, f)), f.sort);
  $('#results').innerHTML = res.map((n) =>
    `<li data-id="${n.id}"><span class="dot" style="background:${catColor(n.category)}"></span>
     <span class="t">${esc(n.title || 'Untitled')}</span><span class="d">${n.date}${n.category ? ' · ' + esc(n.category) : ''}${n.stickies.length ? ' · ' + n.stickies.length + '📝' : ''}</span></li>`).join('')
    || '<li>No matching pages</li>';
  return res;
}
['#fText', '#fCat', '#fFrom', '#fTo', '#fSort'].forEach((s) => $(s).addEventListener('input', runSearch));
$('#results').onclick = (e) => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  applyFilter(); S.idx = Math.max(0, S.view.findIndex((n) => n.id === li.dataset.id)); renderPage();
  $('#drawer').hidden = true;
};
function applyFilter() {
  const f = readFilter();
  const any = f.text || f.cat || f.from || f.to || f.sort !== 'date';
  S.filter = any ? f : null;
  S.view = any ? runSearch() : S.notes;
  S.idx = 0;
  $('#filterBadge').hidden = !any;
  if (!S.view.length) { status('No matching pages'); clearFilter(); return; }
  renderPage();
}
$('#btnApply').onclick = () => { applyFilter(); $('#drawer').hidden = true; };
function clearFilter(render = true) {
  const id = cur()?.id;
  ['#fText', '#fFrom', '#fTo', '#fCat'].forEach((s) => $(s).value = ''); $('#fSort').value = 'date';
  S.filter = null; S.view = S.notes; $('#filterBadge').hidden = true;
  S.idx = Math.max(0, S.view.findIndex((n) => n.id === id));
  if (render) renderPage();
}
$('#btnClear').onclick = () => { clearFilter(); runSearch(); };
$('#filterBadge').onclick = () => clearFilter();

/* ---------------- menu: categories, backup, delete ---------------- */
$('#btnMenu').onclick = () => { renderCatList(); $('#clientId').value = Sync.clientId || ''; Sync.info(); openDrawer('menu'); };
$('#btnCloseMenu').onclick = () => $('#menu').hidden = true;
function renderCatList() {
  $('#catList').innerHTML = S.categories.map((c, i) =>
    `<li><span class="dot" style="background:${c.color}"></span><span class="n">${esc(c.name)}</span>
     <span class="d">${S.notes.filter((n) => n.category === c.name).length} pages</span><button data-i="${i}">✕</button></li>`).join('');
}
$('#catList').onclick = async (e) => {
  const i = e.target.dataset.i; if (i == null) return;
  const c = S.categories[i];
  if (!confirm(`Remove category "${c.name}"? Pages keep their ink but lose the category.`)) return;
  S.categories.splice(i, 1);
  for (const n of S.notes) if (n.category === c.name) { n.category = ''; n.updatedAt = Date.now(); await DB.put(n); }
  await saveMeta(); renderCatList(); renderPage();
};
$('#btnAddCat').onclick = async () => {
  const name = $('#newCat').value.trim(); if (!name || S.categories.some((c) => c.name === name)) return;
  S.categories.push({ name, color: $('#newCatColor').value, updatedAt: Date.now() });
  $('#newCat').value = ''; await saveMeta(); renderCatList(); renderPage();
};
$('#btnDelete').onclick = async () => {
  const n = cur(); if (!n || !confirm('Delete this page permanently (also from Drive on next sync)?')) return;
  S.tombs[n.id] = Date.now();
  S.notes = S.notes.filter((x) => x !== n); await DB.del(n.id); await saveMeta();
  if (!S.notes.length) { const f = newNote(); S.notes.push(f); await DB.put(f); }
  clearFilter(false); S.idx = Math.min(S.idx, S.view.length - 1); renderPage();
  $('#menu').hidden = true;
};
async function saveMeta() {
  await DB.set('categories', S.categories); await DB.set('tombs', S.tombs); Sync.schedule();
}

const snapshot = () => ({ app: 'pen-journal', version: 1, exportedAt: new Date().toISOString(), notes: S.notes, categories: S.categories, tombs: S.tombs });
$('#btnExport').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(snapshot())], { type: 'application/json' }));
  a.download = `pen-journal-${today()}.json`; a.click();
};
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await mergeIn(JSON.parse(await f.text())); status('Imported and merged'); } catch (err) { status('Import failed: ' + err.message, 4000); }
  e.target.value = '';
};

/* Merge another copy of the journal into ours: newest edit of each page wins, deletions win if newer. */
async function mergeIn(remote) {
  if (!remote || remote.app !== 'pen-journal') throw new Error('not a Pen Journal backup');
  let changed = false;
  for (const [id, t] of Object.entries(remote.tombs || {})) if (!(S.tombs[id] >= t)) { S.tombs[id] = t; changed = true; }
  const byId = new Map(S.notes.map((n) => [n.id, n]));
  for (const r of remote.notes || []) {
    const l = byId.get(r.id);
    if (!l || r.updatedAt > l.updatedAt) { byId.set(r.id, r); await DB.put(r); changed = true; }
  }
  for (const [id, t] of Object.entries(S.tombs)) {
    const n = byId.get(id);
    if (n && n.updatedAt <= t) { byId.delete(id); await DB.del(id); changed = true; }
  }
  for (const c of remote.categories || []) {
    const l = S.categories.find((x) => x.name === c.name);
    if (!l) { S.categories.push(c); changed = true; } else if ((c.updatedAt || 0) > (l.updatedAt || 0)) { Object.assign(l, c); changed = true; }
  }
  if (changed) {
    const id = cur()?.id;
    S.notes = sortNotes([...byId.values()]);
    if (!S.notes.length) { const f = newNote(); S.notes.push(f); await DB.put(f); }
    await DB.set('categories', S.categories); await DB.set('tombs', S.tombs);
    if (S.filter) S.view = sortNotes(S.notes.filter((n) => matches(n, S.filter)), S.filter.sort); else S.view = S.notes;
    S.idx = Math.max(0, S.view.findIndex((n) => n.id === id));
    renderPage();
  }
  return changed;
}

/* ---------------- Google Drive sync ---------------- */
const Sync = {
  FILE: 'pen-journal-backup.json',
  FOLDER: 'Pen Journal',
  clientId: '', token: null, exp: 0, tokenClient: null, timer: null, busy: false, lastSync: 0,

  async init() {
    this.clientId = (await DB.get('clientId')) || '';
    this.lastSync = (await DB.get('lastSync')) || 0;
    this.paint();
    if (this.clientId) this.loadGis().catch(() => {});
  },
  loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.onload = res; s.onerror = () => rej(new Error('offline'));
      document.head.appendChild(s);
    });
  },
  async getToken(interactive) {
    if (this.token && Date.now() < this.exp - 60000) return this.token;
    if (!interactive) return null; // browsers block auth popups that aren't from a tap
    await this.loadGis();
    return new Promise((res, rej) => {
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (r) => {
          if (r.error) return rej(new Error(r.error));
          this.token = r.access_token; this.exp = Date.now() + r.expires_in * 1000; res(this.token);
        },
        error_callback: (e) => rej(new Error(e.message || e.type)),
      });
      this.tokenClient.requestAccessToken({ prompt: '' });
    });
  },
  async api(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + this.token, ...(opts.headers || {}) } });
    if (r.status === 401) { this.token = null; throw new Error('Google sign-in expired — tap ☁️'); }
    if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return r;
  },
  async find(name, parent) {
    const q = encodeURIComponent(`name='${name}' and trashed=false${parent ? ` and '${parent}' in parents` : ''}`);
    const r = await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`);
    return (await r.json()).files[0]?.id;
  },
  async folderId() {
    let id = await DB.get('driveFolder');
    if (id) return id;
    id = await this.find(this.FOLDER);
    if (!id) {
      const r = await this.api('https://www.googleapis.com/drive/v3/files', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.FOLDER, mimeType: 'application/vnd.google-apps.folder' }) });
      id = (await r.json()).id;
    }
    await DB.set('driveFolder', id); return id;
  },
  async upload(name, folder, body, fileId) {
    const meta = fileId ? {} : { name, parents: [folder], mimeType: 'application/json' };
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    fd.append('file', new Blob([body], { type: 'application/json' }));
    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const r = await this.api(url, { method: fileId ? 'PATCH' : 'POST', body: fd });
    return (await r.json()).id;
  },

  /* pull → merge → push; also leaves one dated snapshot per day in the Drive folder */
  async sync(interactive = false) {
    if (!this.clientId) { if (interactive) { $('#btnMenu').click(); status('Add your Google OAuth Client ID first', 4000); } return; }
    if (location.protocol === 'file:') { if (interactive) status('Google sign-in only works from https://fmsjay.github.io/pen-journal/ — not a local file', 6000); return; }
    if (this.busy) return;
    if (!navigator.onLine) return this.paint('offline');
    this.busy = true; this.paint('syncing');
    try {
      if (!(await this.getToken(interactive))) { this.paint('signin'); return; }
      const folder = await this.folderId();
      let fileId = await this.find(this.FILE, folder);
      if (fileId) {
        const remote = await (await this.api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`)).json();
        await mergeIn(remote);
      }
      const body = JSON.stringify(snapshot());
      fileId = await this.upload(this.FILE, folder, body, fileId);
      const snapName = `pen-journal-${today()}.json`;
      if ((await DB.get('lastSnapshot')) !== today()) {
        const existing = await this.find(snapName, folder);
        await this.upload(snapName, folder, body, existing);
        await DB.set('lastSnapshot', today());
      }
      this.lastSync = Date.now(); await DB.set('lastSync', this.lastSync);
      this.paint('ok'); if (interactive) status('Synced with Google Drive');
    } catch (err) {
      if (/folder|404/.test(err.message)) await DB.set('driveFolder', null);
      this.paint('error'); status(err.message, 5000);
    } finally { this.busy = false; }
  },
  schedule() {
    clearTimeout(this.timer);
    if (this.clientId) this.timer = setTimeout(() => this.sync(false), 8000);
  },
  paint(state) {
    const b = $('#btnSync');
    b.textContent = { syncing: '🔄', error: '⚠️', signin: '☁️', offline: '📴' }[state] || '☁️';
    b.title = state === 'signin' ? 'Tap to sign in to Google Drive' : this.lastSync ? 'Last synced ' + new Date(this.lastSync).toLocaleString() : 'Google Drive sync';
    this.info();
  },
  info() {
    $('#syncInfo').textContent = !this.clientId ? 'Not connected. See README for the 5-minute Client ID setup.'
      : `Backups go to "My Drive › ${this.FOLDER}". ` + (this.lastSync ? `Last sync ${new Date(this.lastSync).toLocaleString()}.` : 'Not synced yet.');
  },
};
$('#btnSync').onclick = () => Sync.sync(true);
$('#btnSaveClient').onclick = async () => {
  Sync.clientId = $('#clientId').value.trim(); await DB.set('clientId', Sync.clientId);
  Sync.token = null; await Sync.sync(true);
};
$('#btnSignOut').onclick = () => {
  if (Sync.token && window.google) google.accounts.oauth2.revoke(Sync.token, () => {});
  Sync.token = null; Sync.paint('signin'); status('Signed out of Google');
};
window.addEventListener('online', () => Sync.schedule());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') Sync.sync(false);        // pull edits made on the web
  else if (Sync.token) { clearTimeout(saveTimer); if (cur()) DB.put(cur()); Sync.sync(false); }
});

/* ---------------- boot ---------------- */
(async function boot() {
  await DB.open();
  S.categories = (await DB.get('categories')) || [
    { name: 'Personal', color: '#7a4e2d' }, { name: 'Work', color: '#2f5d8a' }, { name: 'Ideas', color: '#c08a00' }, { name: 'Music', color: '#6b3d8a' }];
  S.tombs = (await DB.get('tombs')) || {};
  S.notes = sortNotes(await DB.all());
  if (!S.notes.length) { const n = newNote(); n.category = 'Personal'; S.notes.push(n); await DB.put(n); await DB.set('categories', S.categories); }
  S.view = S.notes; S.idx = S.notes.length - 1;
  new ResizeObserver(resizeCanvas).observe(canvas);
  renderPage();
  await Sync.init();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
})();
