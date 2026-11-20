'use strict';

/* ============ helpers ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const textToHtml = t => esc(t).replace(/\n/g, '<br>');
const fmtSize = n => n == null ? '' : n > 1048576 ? (n/1048576).toFixed(1)+'M'
  : n > 1024 ? (n/1024).toFixed(0)+'K' : n + 'B';

function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

function setStatus(msg) { $('#status-msg').textContent = msg; }

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  let res, data;
  try {
    res = await fetch(path, init);
    data = await res.json();
  } catch (e) {
    toast('MAINFRAME UNREACHABLE — ' + (e.message || e), 'err');
    throw e;
  }
  if (!res.ok || (data && data.error)) {
    const msg = (data && data.error) || ('HTTP ' + res.status);
    toast(msg, 'err');
    throw new Error(msg);
  }
  return data;
}

/* ============ virtualized list ============ */
const ROW_H = 36, V_OVERSCAN = 12;
function vlistRender(box, items, sel, rowHtml, onPick) {
  // spacer model: top spacer + visible rows; box is the scroll container
  const ch = box.clientHeight || 600;
  const start = Math.max(0, Math.floor(box.scrollTop / ROW_H) - V_OVERSCAN);
  const end = Math.min(items.length,
    Math.ceil((box.scrollTop + ch) / ROW_H) + V_OVERSCAN);
  let html = `<div style="height:${start * ROW_H}px"></div>`;
  for (let i = start; i < end; i++) html += rowHtml(items[i], i);
  html += `<div style="height:${(items.length - end) * ROW_H}px"></div>`;
  box.innerHTML = html;
  box.querySelectorAll('.row').forEach(r => r.addEventListener('click', () => {
    const i = +r.dataset.i;
    onPick(i);
  }));
}
function vlistEnsureVisible(box, sel) {
  const top = sel * ROW_H, ch = box.clientHeight;
  if (top < box.scrollTop) box.scrollTop = top;
  else if (top + ROW_H > box.scrollTop + ch) box.scrollTop = top + ROW_H - ch;
}

/* ============ sound (default OFF) ============ */
let soundOn = false, actx = null;
function blip(freq = 880, dur = .06) {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(.06, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001, actx.currentTime + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch (e) { /* no audio, no problem */ }
}
$('#snd').addEventListener('click', () => {
  soundOn = !soundOn;
  $('#snd').textContent = 'SND:' + (soundOn ? 'ON' : 'OFF');
  $('#snd').classList.toggle('on', soundOn);
  if (soundOn) blip(660);
});

/* ============ boot splash ============ */
const boot = $('#boot');
let bootDone = false, bootDismissedAt = 0;
function finishBoot() {
  if (bootDone) return;
  bootDone = true;
  bootDismissedAt = performance.now();
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 600);
}
window.addEventListener('keydown', e => { if (!bootDone) finishBoot(); }, true);
window.addEventListener('pointerdown', () => { if (!bootDone) finishBoot(); }, true);

async function runBoot() {
  const lines = [];
  try {
    const h = await api('/api/health');
    lines.push('ATLAS-86 BIOS v0.1', 'COPYRIGHT (C) 1986 MAINFRAME SYSTEMS',
      'MEM CHECK ............ 640K OK', 'PHOSPHOR DRIVER ...... OK',
      'JIRA LINK ............ ' + (h.configured ? 'OK' : 'NOT CONFIGURED'),
      'CONFLUENCE LINK ...... ' + (h.configured ? 'OK' : 'NOT CONFIGURED'),
      'BOOT ATLAS-86.SYS .....');
    setConn(h.configured);
    state.configured = !!h.configured;
    setTimeout(() => switchTab(state.configured ? 'home' : 'setup'), 0);
  } catch (e) {
    lines.push('ATLAS-86 BIOS v0.1', 'MAINFRAME UNREACHABLE', 'CHECK YOUR WIRE, OPERATOR.');
    setConn(false); state.configured = false;
    setTimeout(() => switchTab('setup'), 0);
  }
  const pre = $('#boot-text');
  let i = 0;
  const iv = setInterval(() => {
    pre.textContent = lines.slice(0, ++i).join('\n');
    if (i >= lines.length) { clearInterval(iv); }
  }, 140);
  setTimeout(() => { clearInterval(iv); pre.textContent = lines.join('\n'); }, lines.length * 140 + 400);
}

function setConn(on) {
  const c = $('#conn');
  c.textContent = on ? '● ONLINE' : '● OFFLINE';
  c.classList.toggle('on', !!on);
}

/* ============ state ============ */
const state = {
  configured: false,
  tab: 'home',
  home: { data: null },
  jira: { jql: 'assignee = currentUser() ORDER BY updated DESC', issues: [], sel: -1,
          detail: null, mode: 'list', view: 'issues', bulk: false, checked: new Set(),
          boards: [], board: null, boardCfg: null, sprints: [], sprint: null,
          columns: [], group: 'status', bsel: { s: -1, i: -1 },
          backlog: { sections: [], checked: new Set() },
          versionsMode: false, versions: null,
          reportMode: false, report: null },
  conf: { spaces: [], space: '', pages: [], sel: -1, detail: null, mode: 'list',
          q: '', cql: '', adv: false },
};
const cur = () => state.tab === 'jira' ? state.jira : state.conf;

/* ============ overlays ============ */
function showOverlay(id) { $(id).hidden = false; }
function hideOverlay(id) { $(id).hidden = true; }

function confirmDialog(title, msg) {
  return new Promise(resolve => {
    $('#cf-title').textContent = title;
    $('#cf-msg').textContent = msg;
    showOverlay('#confirm-overlay');
    const done = v => { hideOverlay('#confirm-overlay'); resolve(v); };
    $('#cf-yes').onclick = () => done(true);
    $('#cf-no').onclick = () => done(false);
    cfResolve = done;
  });
}
let cfResolve = null;

$('#help-overlay').hidden = true;
function toggleHelp(force) {
  const h = $('#help-overlay');
  const show = force !== undefined ? force : h.hidden;
  h.hidden = !show;
}
$('#help-close').addEventListener('click', () => toggleHelp(false));

/* ============ editor overlay ============ */
let editorCtx = null;
function openEditor(ctx) {
  editorCtx = ctx;
  $('#ed-title-row').hidden = !ctx.title;
  if (ctx.title) $('#ed-title').value = ctx.titleValue || '';
  $('#ed-fields').hidden = !ctx.fieldsHTML;
  $('#ed-fields').innerHTML = ctx.fieldsHTML || '';
  $('#editor').innerHTML = ctx.html || '';
  showOverlay('#editor-overlay');
  setTimeout(() => $('#editor').focus(), 30);
}
function closeEditor() { hideOverlay('#editor-overlay'); editorCtx = null; }

$('#toolbar').addEventListener('mousedown', e => {
  // keep selection inside contenteditable when clicking toolbar buttons
  e.preventDefault();
  const b = e.target.closest('button'); if (!b) return;
  const cmd = b.dataset.cmd, val = b.dataset.val;
  $('#editor').focus();
  if (cmd === 'createLink') {
    const url = prompt('ENTER URL');
    if (url) document.execCommand('createLink', false, url);
  } else if (cmd === 'formatBlock') {
    document.execCommand('formatBlock', false, '<' + val + '>');
  } else {
    document.execCommand(cmd, false, val || null);
  }
});

function readEditor() {
  return {
    title: $('#ed-title-row').hidden ? null : $('#ed-title').value.trim(),
    // execCommand emits <strike>; backend whitelist only knows <s>
    html: $('#editor').innerHTML.replace(/<\/?strike>/g, m => m.replace('strike', 's')),
  };
}
function readField(id) { const n = document.getElementById(id); return n ? n.value.trim() : ''; }

$('#ed-cancel').addEventListener('click', closeEditor);
$('#ed-save').addEventListener('click', () => {
  if (!editorCtx) return;
  const ed = readEditor();
  Promise.resolve(editorCtx.onSave(ed)).then(() => { blip(880); closeEditor(); })
    .catch(() => {});
});

/* ============ tabs ============ */
const TABS = ['home', 'jira', 'conf', 'setup'];
const TAB_STATUS = { home: 'HOME // YOUR WORK', jira: 'JIRA MODULE LOADED',
                     conf: 'CONFLUENCE MODULE LOADED', setup: 'SETUP / CONFIGURATION' };
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  // setup-mode = full-width single pane (setup form and home dashboard)
  document.body.classList.toggle('setup-mode', tab === 'setup' || tab === 'home');
  $('#list-pane').style.display = (tab === 'setup' || tab === 'home') ? 'none' : '';
  setStatus(TAB_STATUS[tab] || '');
  if (tab === 'home') { loadHome(); }
  else if (tab === 'jira') {
    if (state.jira.view === 'boards') renderJiraBoardHead();
    else if (state.jira.view === 'backlog') renderJiraBacklogHead();
    else { renderJiraListHead(); loadJiraIssues(); }
    loadProjects();
  }
  else if (tab === 'conf') { loadSpaces(); renderConfListHead(); }
  else renderSetup();
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

/* ============ shared detail widgets ============ */

function attRowsHtml(atts) {
  if (!atts || !atts.length) return '';
  return atts.map(a => {
    const img = (a.mime || '').startsWith('image/') && a.url;
    const inner = img
      ? `<img class="att-img" src="${esc(a.url)}" alt="${esc(a.filename)}" loading="lazy">`
      : `<a href="${esc(a.url || '#')}" ${a.url ? 'target="_blank" rel="noopener"' : ''}>[ ${esc(a.filename || 'file')} ]</a>`;
    return `<div class="att-row">${inner}
      <span class="att-meta">${esc(a.mime || '')} ${fmtSize(a.size)}${a.author ? ' · ' + esc(a.author) : ''}</span></div>`;
  }).join('');
}

function wireAttachments(uploadPath) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.hidden = true;
  document.body.appendChild(inp);
  inp.addEventListener('change', async () => {
    if (!inp.files.length) return;
    const fd = new FormData();
    fd.append('file', inp.files[0]);
    try {
      setStatus('UPLOADING ' + inp.files[0].name + '...');
      const res = await fetch(uploadPath, { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || 'HTTP ' + res.status);
      toast('ATTACHMENT UPLOADED', 'ok'); blip(1200, .04);
      refreshDetail();
    } catch (e) { /* toast shown by fetch? no — show manually */ toast('UPLOAD FAILED: ' + e.message, 'err'); }
    inp.value = ''; inp.remove();
  });
  const btn = document.getElementById('att-upload');
  if (btn) btn.onclick = () => inp.click();
}
let refreshDetail = () => {};

/* ============ HOME (dashboard-lite) ============ */
async function loadHome() {
  setStatus('LOADING HOME...');
  try {
    state.home.data = await api('/api/home');
    renderHome();
    setStatus('HOME READY — 0-3 TABS · CLICK A KEY TO OPEN');
    blip(1200, .04);
  } catch (e) { renderHome(); }
}

function renderHome() {
  const d = state.home.data || {};
  const row = (it, extra) => `
    <div class="link-row">
      <a class="link-key home-key" data-key="${esc(it.key)}">${esc(it.key)}</a>
      <span class="link-sum">${esc(it.summary || '')} · ${esc(it.status || '')}${it.assignee ? ' · ' + esc(it.assignee) : ''}</span>
      <span class="link-desc">${esc(extra || (it.duedate ? 'DUE ' + it.duedate : (it.updated || '').slice(0, 10)))}</span>
    </div>`;
  const bucket = (title, items, extraFn) => `
    <div class="detail-section"><h2>${title} <span class="sub">(${(items || []).length})</span></h2>
      ${(items || []).map(it => row(it, extraFn && extraFn(it))).join('') || '<div class="sub">NOTHING HERE. ENJOY IT.</div>'}
    </div>`;
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <h1>HOME // YOUR WORK</h1>
      <div class="sub">MY OPEN · DUE THIS WEEK · WATCHED · ACTIVE SPRINT — CLICK A KEY TO OPEN IN JIRA</div>
      <div class="btn-row" style="margin-top:6px"><button id="home-reload" class="act">[ R / RELOAD ]</button></div>
    </div>
    ${bucket('MY OPEN ISSUES', d.mine)}
    ${bucket('DUE THIS WEEK', d.due, it => 'DUE ' + (it.duedate || ''))}
    ${bucket('WATCHED ISSUES', d.watched)}
    ${bucket('ACTIVE SPRINT', d.sprint, it => (it.updated || '').slice(0, 10))}`;
  document.querySelectorAll('.home-key').forEach(a => a.addEventListener('click', () => {
    state.jira.view = 'issues';
    switchTab('jira');
    openJiraIssue(a.dataset.key);
  }));
  const hr = $('#home-reload');
  if (hr) hr.onclick = loadHome;
}

/* ============ mentions ============ */
function wireMentions(root) {
  // wrap @name text nodes in <span class="mention">; text nodes only so
  // markup from sanitized html is never reparsed
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(n => {
    if (!/@[A-Za-z0-9_.-]+/.test(n.nodeValue || '')) return;
    const frag = document.createDocumentFragment();
    n.nodeValue.split(/(@[A-Za-z0-9_.-]+)/g).forEach(p => {
      if (!p) return;
      if (p[0] === '@' && p.length > 1) {
        const s = document.createElement('span');
        s.className = 'mention'; s.textContent = p;
        frag.appendChild(s);
      } else {
        frag.appendChild(document.createTextNode(p));
      }
    });
    n.parentNode.replaceChild(frag, n);
  });
}

/* ============ JIRA ============ */
const JQL_PRESETS = [
  ['ALL ASSIGNED TO ME', 'assignee = currentUser() ORDER BY updated DESC'],
  ['MY OPEN ISSUES', 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'],
  ['MY ISSUES THIS SPRINT', 'assignee = currentUser() AND sprint in openSprints() ORDER BY rank'],
  ['ALL ISSUES THIS SPRINT', 'sprint in openSprints() ORDER BY rank'],
  ['REPORTED BY ME', 'reporter = currentUser() ORDER BY created DESC'],
  ['UNASSIGNED', 'assignee is EMPTY AND resolution = Unresolved ORDER BY priority DESC'],
  ['RESOLVED LAST 7 DAYS', 'resolved >= -7d ORDER BY resolved DESC'],
];
function savedJqls() {
  try { return JSON.parse(localStorage.getItem('a86.jql.saved') || '[]'); }
  catch (e) { return []; }
}

function renderJiraListHead() {
  const preset = JQL_PRESETS.some(([, j]) => j === state.jira.jql)
    || savedJqls().some(s => s.jql === state.jira.jql)
    ? state.jira.jql : '';
  const saved = savedJqls();
  $('#list-head').innerHTML = `
    <div class="btn-row" style="margin:0">
      <button class="act${state.jira.view === 'issues' ? ' primary' : ''}" data-view="issues">[ ISSUES ]</button>
      <button class="act${state.jira.view === 'boards' ? ' primary' : ''}" data-view="boards">[ BOARDS ]</button>
      <button class="act${state.jira.view === 'backlog' ? ' primary' : ''}" data-view="backlog">[ BACKLOG ]</button>
    </div>
    <label>QUERY</label>
    <select id="jql-preset">
      <option value=""${preset === '' ? ' selected' : ''}>— CUSTOM JQL —</option>
      <optgroup label="PRESETS">
      ${JQL_PRESETS.map(([n, j]) => `<option value="${esc(j)}"${j === preset ? ' selected' : ''}>${n}</option>`).join('')}
      </optgroup>
      ${saved.length ? `<optgroup label="SAVED">${saved.map(s =>
        `<option value="${esc(s.jql)}"${s.jql === preset ? ' selected' : ''}>★ ${esc(s.name)}</option>`).join('')}</optgroup>` : ''}
    </select>
    <input id="jql" type="text" value="${esc(state.jira.jql)}" spellcheck="false">
    <div class="btn-row">
      <button id="jrun" class="act primary">[ RUN QUERY ]</button>
      <button id="jsave" class="act">[ SAVE JQL ]</button>
      <button id="jbulk" class="act${state.jira.bulk ? ' primary' : ''}">[ BULK ]</button>
      <button id="jnew" class="act">[ NEW ISSUE ]</button>
    </div>
    <div class="btn-row" id="bulk-bar" ${state.jira.bulk ? '' : 'hidden'} style="margin:0">
      <button id="bulk-trans" class="act primary">[ TRANSITION SELECTED ]</button>
      <button id="bulk-edit" class="act">[ EDIT FIELDS ]</button>
      <span class="sub" id="bulk-count">${state.jira.checked.size} SELECTED</span>
    </div>`;
  document.querySelectorAll('#list-head [data-view]').forEach(b =>
    b.addEventListener('click', () => { state.jira.view = b.dataset.view; routeJiraView(); }));
  $('#jql-preset').addEventListener('change', e => {
    if (!e.target.value) return;
    $('#jql').value = e.target.value;
    loadJiraIssues();
  });
  $('#jql').addEventListener('keydown', e => { if (e.key === 'Enter') loadJiraIssues(); });
  $('#jrun').addEventListener('click', loadJiraIssues);
  $('#jsave').addEventListener('click', () => {
    const jql = ($('#jql') || {}).value || state.jira.jql;
    const name = prompt('NAME THIS FILTER');
    if (!name) return;
    const list = savedJqls().filter(s => s.name !== name);
    list.push({ name, jql });
    localStorage.setItem('a86.jql.saved', JSON.stringify(list));
    renderJiraListHead();
    toast('FILTER SAVED', 'ok');
  });
  $('#jbulk').addEventListener('click', () => {
    state.jira.bulk = !state.jira.bulk;
    if (!state.jira.bulk) state.jira.checked.clear();
    renderJiraListHead(); renderJiraRows();
  });
  $('#jnew').addEventListener('click', newJiraIssue);
}

const box = () => $('#list-body');
let vScrollBound = false;
function bindVScroll() {
  if (vScrollBound) return;
  vScrollBound = true;
  $('#list-body').addEventListener('scroll', () => {
    if (state.tab === 'jira' && state.jira.view === 'issues') renderJiraRows();
    else if (state.tab === 'conf') renderConfRows();
  });
}
bindVScroll();

async function loadJiraIssues() {
  state.jira.jql = $('#jql') ? $('#jql').value.trim() : state.jira.jql;
  setStatus('FETCHING TICKETS...');
  try {
    const d = await api('/api/jira/issues?jql=' + encodeURIComponent(state.jira.jql) + '&limit=200');
    state.jira.jql = d.jql || state.jira.jql;
    if ($('#jql')) $('#jql').value = state.jira.jql;
    state.jira.issues = d.issues || [];
    state.jira.sel = -1; state.jira.mode = 'list';
    renderJiraRows();
    setStatus(state.jira.issues.length + ' TICKET(S) FOUND');
    blip(1200, .04);
  } catch (e) { renderJiraRows(); }
}

function renderJiraRows() {
  const b = box(), items = state.jira.issues;
  if (!items.length) { b.innerHTML = '<div class="empty">NO TICKETS. TRY ANOTHER JQL.</div>'; return; }
  const bulk = state.jira.bulk;
  vlistRender(b, items, state.jira.sel, (it, i) => `
    <div class="row${i === state.jira.sel ? ' sel' : ''}" data-i="${i}">
      ${bulk ? `<input type="checkbox" class="ck" data-key="${esc(it.key)}"${state.jira.checked.has(it.key) ? ' checked' : ''}>` : ''}
      <span class="key">${esc(it.key)}</span>
      <span class="title">${esc(it.summary)}</span>
      <span class="meta">${esc(it.status)} · ${esc(it.assignee || '—')} · ${esc((it.updated || '').slice(0, 10))}</span>
    </div>`, i => {
    state.jira.sel = i;
    renderJiraRows();
    openJiraIssue(items[i].key);
  });
  b.querySelectorAll('.ck').forEach(c => c.addEventListener('click', e => {
    e.stopPropagation();
    const k = c.dataset.key;
    c.checked ? state.jira.checked.add(k) : state.jira.checked.delete(k);
    setStatus(state.jira.checked.size + ' SELECTED');
    const bc = $('#bulk-count'); if (bc) bc.textContent = state.jira.checked.size + ' SELECTED';
  }));
  const bt = $('#bulk-trans');
  if (bt) bt.onclick = bulkTransition;
  const be = $('#bulk-edit');
  if (be) be.onclick = bulkEdit;
}

function bulkEdit() {
  const keys = [...state.jira.checked];
  if (!keys.length) { toast('NOTHING SELECTED', 'err'); return; }
  openEditor({
    title: false,
    fieldsHTML: `
      <label>APPLY TO ${keys.length} ISSUE(S) — BLANK = UNCHANGED</label>
      <label>ASSIGNEE (NAME / ACCOUNT ID)</label>
      <input id="be-assignee" type="text" list="dl-be-users">
      <datalist id="dl-be-users"></datalist>
      <label>PRIORITY</label>
      <input id="be-priority" type="text">
      <label>DUE DATE</label>
      <input id="be-duedate" type="date">
      <label>LABELS ADD (COMMA SEPARATED)</label>
      <input id="be-labels-add" type="text">
      <label>LABELS REMOVE (COMMA SEPARATED)</label>
      <input id="be-labels-remove" type="text">`,
    html: '',
    onSave: async () => {
      const fields = {}, split = v => v.split(',').map(x => x.trim()).filter(Boolean);
      const who = readField('be-assignee');
      if (who) fields.assignee = /^[A-Za-z0-9:._-]{8,}$/.test(who) && who.length > 12
        ? { accountId: who } : who;
      const pr = readField('be-priority'); if (pr) fields.priority = pr;
      const dd = readField('be-duedate'); if (dd) fields.duedate = dd;
      const la = split(readField('be-labels-add'));
      const lr = split(readField('be-labels-remove'));
      if (!Object.keys(fields).length && !la.length && !lr.length) {
        toast('NOTHING TO EDIT', 'err'); throw new Error('validation');
      }
      const ok = await confirmDialog('[ BULK EDIT ]',
        'APPLY TO ' + keys.length + ' ISSUE(S)?\n' + keys.slice(0, 8).join(', ') +
        (keys.length > 8 ? ' +' + (keys.length - 8) + ' MORE' : ''));
      if (!ok) throw new Error('cancelled');
      const body = { keys };
      if (Object.keys(fields).length) body.fields = fields;
      if (la.length) body.labels_add = la;
      if (lr.length) body.labels_remove = lr;
      const r = await api('/api/jira/bulk/edit', { method: 'POST', body });
      if (r.errors && r.errors.length) {
        toast((r.results.length - r.errors.length) + ' OK, ' +
          r.errors.length + ' FAILED: ' + r.errors[0].error, 'err');
      } else {
        toast(keys.length + ' ISSUE(S) UPDATED', 'ok'); blip(1320, .05);
      }
      state.jira.checked.clear();
      await loadJiraIssues();
    },
  });
  const inp = $('#be-assignee');
  inp && inp.addEventListener('input', async () => {
    const q = inp.value.trim();
    if (q.length < 2) return;
    try {
      const users = await api('/api/jira/users?q=' + encodeURIComponent(q));
      $('#dl-be-users').innerHTML = users.map(u =>
        `<option value="${esc(u.displayName || u.name)}"></option>`).join('');
    } catch (e) { /* ignore */ }
  });
}

async function bulkTransition() {
  const keys = [...state.jira.checked];
  if (!keys.length) { toast('NOTHING SELECTED', 'err'); return; }
  try {
    const d = await api('/api/jira/issue/' + encodeURIComponent(keys[0]));
    const trans = d.transitions || [];
    if (!trans.length) { toast('NO TRANSITIONS ON ' + keys[0], 'err'); return; }
    const menu = trans.map((t, i) => `${i + 1}) ${t.name}`).join('\n');
    const pick = prompt('TRANSITION ' + keys.length + ' ISSUE(S) TO:\n' + menu + '\n\nENTER NUMBER');
    const t = trans[+pick - 1];
    if (!t) return;
    const ok = await confirmDialog('[ BULK ] TRANSITION',
      keys.length + ' ISSUE(S) WILL MOVE TO "' + t.name + '".\nPROCEED?');
    if (!ok) return;
    const r = await api('/api/jira/transition', {
      method: 'POST', body: { keys, transition_id: t.id },
    });
    if (r.errors && r.errors.length) {
      toast(r.errors.length + ' FAILED: ' + r.errors[0].error, 'err');
    } else {
      toast(keys.length + ' ISSUE(S) TRANSITIONED', 'ok'); blip(1320, .05);
    }
    state.jira.checked.clear();
    await loadJiraIssues();
  } catch (e) { /* toast shown */ }
}

async function openJiraIssue(key) {
  setStatus('OPENING ' + key + '...');
  try {
    const it = await api('/api/jira/issue/' + encodeURIComponent(key));
    state.jira.detail = it; state.jira.mode = 'detail';
    renderJiraDetail();
    blip(980, .05);
  } catch (e) { /* toast already shown */ }
}

const person = p => esc((p && (p.displayName || p.name)) || '—');

function renderJiraDetail() {
  const it = state.jira.detail;
  refreshDetail = () => openJiraIssue(it.key);
  const statusName = (it.status && it.status.name) || it.status || '';
  const typeName = (it.issuetype && it.issuetype.name) || it.issuetype || '';
  const comments = (it.comments || []).map(c => `
    <div class="comment">
      <div class="who">${esc(c.author)} — ${esc((c.created || '').replace('T', ' ').slice(0, 16))}</div>
      <div class="detail-body-html">${c.body_html || ''}</div>
    </div>`).join('');
  const trans = (it.transitions || []).map(t =>
    `<button class="act" data-tid="${esc(t.id)}" data-toname="${esc(t.to || t.name || '')}">[ ${esc((t.name || '').toUpperCase())} ]</button>`).join('');
  const links = (it.links || []).map(l => `
    <div class="link-row">
      <span class="link-desc">${l.direction === 'outward' ? '→' : '←'} ${esc(l.desc || l.type || '')}</span>
      <a class="link-key" data-key="${esc(l.key)}">${esc(l.key)}</a>
      <span class="link-sum">${esc(l.summary || '')} ${l.status ? '· ' + esc(l.status) : ''}</span>
      <button class="act danger link-del" data-lid="${esc(l.id)}">[X]</button>
    </div>`).join('');
  const atts = attRowsHtml(it.attachments);
  const remotes = (it.remote_links || []).map(r => `
    <div class="link-row">
      <span class="link-desc">REMOTE</span>
      <a class="link-ext" href="${esc(r.url || '#')}" target="_blank" rel="noopener">${esc(r.title || r.url || '')}</a>
      <button class="act danger link-del" data-rid="${esc(r.id)}">[X]</button>
    </div>`).join('');
  const watches = it.watches || {};
  const votes = it.votes || {};
  const tt = it.timetracking || {};
  const hierarchy = [];
  if (it.epic) hierarchy.push(`<div class="link-row"><span class="link-desc">EPIC</span><a class="link-key" data-key="${esc(it.epic)}">${esc(it.epic)}</a></div>`);
  if (it.parent) hierarchy.push(`<div class="link-row"><span class="link-desc">PARENT</span><a class="link-key" data-key="${esc(it.parent.key)}">${esc(it.parent.key)}</a><span class="link-sum">${esc(it.parent.summary || '')}</span></div>`);
  (it.children || []).forEach(c => hierarchy.push(
    `<div class="link-row"><span class="link-desc">CHILD</span><a class="link-key" data-key="${esc(c.key)}">${esc(c.key)}</a><span class="link-sum">${esc(c.summary || '')} · ${esc(c.status || '')}</span></div>`));
  (it.subtasks || []).forEach(s => hierarchy.push(
    `<div class="link-row"><span class="link-desc">SUBTASK</span><a class="link-key" data-key="${esc(s.key)}">${esc(s.key)}</a><span class="link-sum">${esc(s.summary || '')} · ${esc(s.status || '')}</span></div>`));
  const history = (it.history || []).slice(0, 30).map(h => `
    <div class="link-row">
      <span class="link-desc">${esc((h.when || '').slice(0, 10))}</span>
      <span class="link-sum">${esc(h.by || '')}: ${(h.items || []).map(i =>
        `${esc(i.field)}: ${esc(i.from ?? '∅')} → ${esc(i.to ?? '∅')}`).join(' · ')}</span>
    </div>`).join('');
  const attrs = (it.attributes || []).map(a => `
    <span class="k">${esc((a.name || '').toUpperCase())}</span>
    <span class="v">${esc(a.value)}${a.editable ? ` <button class="act attr-edit" data-fid="${esc(a.id)}" data-val="${esc(a.value)}" data-name="${esc(a.name)}">[E]</button>` : ''}</span>`).join('');
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <h1>${esc(it.key)} — ${esc(it.summary)}</h1>
      <div class="sub">${esc(statusName)} · ${esc(typeName)} · UPDATED ${esc(it.updated || '')}</div>
    </div>
    <div class="kv">
      <span class="k">ASSIGNEE</span><span class="v">${person(it.assignee)}</span>
      <span class="k">REPORTER</span><span class="v">${person(it.reporter)}</span>
      ${it.priority ? `<span class="k">PRIORITY</span><span class="v">${esc(it.priority.name || it.priority)}</span>` : ''}
      ${it.duedate ? `<span class="k">DUE DATE</span><span class="v">${esc(it.duedate)}</span>` : ''}
      ${it.labels && it.labels.length ? `<span class="k">LABELS</span><span class="v">${it.labels.map(esc).join(', ')}</span>` : ''}
      ${it.components && it.components.length ? `<span class="k">COMPONENTS</span><span class="v">${it.components.map(esc).join(', ')}</span>` : ''}
      ${it.fixVersions && it.fixVersions.length ? `<span class="k">FIX VERSIONS</span><span class="v">${it.fixVersions.map(esc).join(', ')}</span>` : ''}
      ${(tt.originalEstimate || tt.remainingEstimate || tt.timeSpent) ? `<span class="k">TIME TRACK</span><span class="v">${esc([tt.timeSpent && 'spent ' + tt.timeSpent, tt.remainingEstimate && 'left ' + tt.remainingEstimate, tt.originalEstimate && 'orig ' + tt.originalEstimate].filter(Boolean).join(' · '))}</span>` : ''}
      ${watches.watchCount != null ? `<span class="k">WATCHERS</span><span class="v">${watches.watchCount}${watches.isWatching ? ' (YOU)' : ''}</span>` : ''}
      ${votes.votes != null ? `<span class="k">VOTES</span><span class="v">${votes.votes}${votes.hasVoted ? ' (YOU)' : ''}</span>` : ''}
      ${attrs}
    </div>
    ${hierarchy.length ? `<div class="detail-section"><h2>HIERARCHY</h2>${hierarchy.join('')}</div>` : ''}
    <div class="detail-section"><h2>DESCRIPTION</h2>
      <div class="detail-body-html">${it.description_html || '<i>(empty)</i>'}</div></div>
    <div class="detail-section"><h2>COMMENTS</h2>${comments || '<div class="sub">NO COMMENTS YET.</div>'}
      <textarea id="cmt" class="comment-box" placeholder="WRITE A COMMENT..."></textarea>
      <div class="link-add">
        <input id="cmt-user" type="text" list="dl-cmt-users" placeholder="@USER">
        <datalist id="dl-cmt-users"></datalist>
        <button id="cmt-men" class="act">[ @ ]</button>
      </div>
      <div class="btn-row"><button id="cmt-post" class="act primary">[ POST COMMENT ]</button></div>
    </div>
    ${(it.history || []).length ? `<div class="detail-section"><h2>HISTORY <span class="sub">(${it.history.length})</span></h2>${history}</div>` : ''}
    <div class="detail-section"><h2>TRANSITION STATUS</h2>
      <div class="btn-row" id="trans-row">${trans || '<span class="sub">NO TRANSITIONS AVAILABLE</span>'}</div>
    </div>
    <div class="detail-section"><h2>LINKS</h2>
      <div id="links-list">${links || '<div class="sub">NO LINKS.</div>'}</div>
      <div class="link-add">
        <select id="lk-type"></select>
        <select id="lk-dir"></select>
        <input id="lk-other" type="text" placeholder="ISSUE KEY">
        <button id="lk-add" class="act">[ LINK ]</button>
      </div>
    </div>
    <div class="detail-section"><h2>REMOTE LINKS</h2>
      <div id="remlinks-list">${remotes || '<div class="sub">NONE.</div>'}</div>
      <div class="link-add">
        <input id="rl-url" type="text" placeholder="URL (PAGE / DOC / TICKET)" style="flex:2">
        <input id="rl-title" type="text" placeholder="TITLE" style="flex:1">
        <button id="rl-add" class="act">[ ADD ]</button>
      </div>
    </div>
    <div class="detail-section"><h2>WORKLOG</h2>
      <div id="worklog-list"><div class="sub">LOADING...</div></div>
      <div class="link-add">
        <input id="wl-time" type="text" placeholder="TIME (1h 30m)" style="flex:1">
        <input id="wl-date" type="date">
        <input id="wl-comment" type="text" placeholder="COMMENT" style="flex:2">
        <button id="wl-add" class="act">[ LOG ]</button>
      </div>
    </div>
    <div class="detail-section"><h2>ATTACHMENTS</h2>
      ${atts || '<div class="sub">NO ATTACHMENTS.</div>'}
      <div class="btn-row"><button id="att-upload" class="act">[ ATTACH FILE ]</button></div>
    </div>
    <div class="detail-section"><h2>ACTIONS</h2>
      <div class="btn-row">
        <button id="d-watch" class="act">[ ${watches.isWatching ? 'UNWATCH' : 'WATCH'} ]</button>
        <button id="d-vote" class="act" ${votes.hasVoted ? 'disabled' : ''}>[ VOTE${votes.votes ? ' (' + votes.votes + ')' : ''} ]</button>
        <button id="d-fields" class="act">[ EDIT FIELDS ]</button>
        <button id="d-subtask" class="act">[ SUBTASK ]</button>
        <button id="d-edit" class="act primary">[ E / EDIT ]</button>
        <button id="d-back" class="act">[ ESC / BACK ]</button>
        <button id="d-del" class="act danger">[ D / DELETE ]</button>
      </div>
      <div class="link-add" id="watch-add-row" style="margin-top:8px">
        <input id="watch-user" type="text" placeholder="ADD WATCHER (NAME / ACCOUNT ID)" style="flex:1">
        <button id="watch-add" class="act">[ ADD WATCHER ]</button>
      </div>
    </div>`;
  $('#d-edit').onclick = editJiraIssue;
  $('#d-back').onclick = backToList;
  $('#d-del').onclick = deleteJiraIssue;
  $('#d-fields').onclick = editJiraFields;
  $('#cmt-post').onclick = postComment;
  $('#d-watch').onclick = toggleWatch;
  $('#d-vote').onclick = () => voteIssue(it.key);
  $('#watch-add').onclick = addWatcher;
  wireAttachments('/api/jira/issue/' + encodeURIComponent(it.key) + '/attachment');
  document.querySelectorAll('#trans-row .act').forEach(b =>
    b.addEventListener('click', () => applyTransition(b.dataset.tid)));
  document.querySelectorAll('.link-key').forEach(a =>
    a.addEventListener('click', () => openJiraIssue(a.dataset.key)));
  document.querySelectorAll('.link-del').forEach(b =>
    b.addEventListener('click', () => b.dataset.rid
      ? deleteRemoteLink(b.dataset.rid) : deleteLink(b.dataset.lid)));
  $('#rl-add').onclick = addRemoteLink;
  $('#wl-add').onclick = addWorklog;
  $('#d-subtask').onclick = newSubtask;
  wireMentions($('#detail-body'));
  document.querySelectorAll('.attr-edit').forEach(b =>
    b.addEventListener('click', () => editCustomField(b.dataset.fid, b.dataset.name, b.dataset.val)));
  wireCommentMention();
  loadWorklogs(it.key);
  loadLinkTypes(it.key);
}

async function editCustomField(fid, name, cur) {
  const it = state.jira.detail;
  const raw = prompt('NEW VALUE FOR ' + (name || fid).toUpperCase(), cur || '');
  if (raw === null) return;
  let v = raw.trim();
  if (v !== '' && !isNaN(+v)) v = +v;  // keep numeric fields numeric
  await api('/api/jira/issue/' + encodeURIComponent(it.key), {
    method: 'PUT', body: { custom_fields: { [fid]: v } },
  });
  toast((name || fid).toUpperCase() + ' UPDATED', 'ok');
  await openJiraIssue(it.key);
}

function wireCommentMention() {
  const inp = $('#cmt-user'), dl = $('#dl-cmt-users');
  if (!inp) return;
  inp.addEventListener('input', async () => {
    const q = inp.value.replace(/^@/, '').trim();
    if (q.length < 2) return;
    try {
      const users = await api('/api/jira/users?q=' + encodeURIComponent(q));
      dl.innerHTML = users.map(u =>
        `<option value="${esc(u.displayName || u.name)}"></option>`).join('');
    } catch (e) { /* ignore */ }
  });
  $('#cmt-men').onclick = () => {
    const who = inp.value.replace(/^@/, '').trim();
    if (!who) { toast('PICK A USER FIRST', 'err'); return; }
    const ta = $('#cmt'), pos = ta.selectionStart || ta.value.length;
    ta.value = ta.value.slice(0, pos) + '@' + who + ' ' + ta.value.slice(pos);
    ta.focus();
  };
}

async function loadLinkTypes(key) {
  const sel = $('#lk-type'), dir = $('#lk-dir');
  if (!sel) return;
  try {
    const types = await api('/api/jira/issue/' + encodeURIComponent(key) + '/linktypes');
    sel.innerHTML = types.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
    const paintDir = () => {
      const t = types.find(x => x.name === sel.value) || types[0] || {};
      dir.innerHTML =
        `<option value="outward">THIS ISSUE ${esc(t.outward || 'OUTWARD')} ${esc($('#lk-other').value || 'OTHER')}</option>` +
        `<option value="inward">THIS ISSUE ${esc(t.inward || 'INWARD')} ${esc($('#lk-other').value || 'OTHER')}</option>`;
    };
    sel.onchange = paintDir;
    $('#lk-other').addEventListener('input', paintDir);
    paintDir();
    $('#lk-add').onclick = async () => {
      const other = $('#lk-other').value.trim();
      if (!other) { toast('ENTER AN ISSUE KEY', 'err'); return; }
      await api('/api/jira/issue/' + encodeURIComponent(key) + '/link', {
        method: 'POST',
        body: { type: sel.value, other, direction: dir.value },
      });
      toast('LINK ADDED', 'ok'); blip(1200, .04);
      await openJiraIssue(key);
    };
  } catch (e) { sel.innerHTML = ''; }
}

async function deleteLink(lid) {
  const it = state.jira.detail;
  await api('/api/jira/issue/' + encodeURIComponent(it.key) + '/link/' + encodeURIComponent(lid),
    { method: 'DELETE' });
  toast('LINK REMOVED', 'ok');
  await openJiraIssue(it.key);
}

async function toggleWatch() {
  const it = state.jira.detail;
  if (it.watches && it.watches.isWatching) {
    await api('/api/jira/issue/' + encodeURIComponent(it.key) + '/watchers',
      { method: 'DELETE' });
  } else {
    await api('/api/jira/issue/' + encodeURIComponent(it.key) + '/watchers',
      { method: 'POST', body: {} });
  }
  toast('WATCH UPDATED', 'ok');
  await openJiraIssue(it.key);
}

async function addWatcher() {
  const it = state.jira.detail, inp = $('#watch-user');
  const who = inp.value.trim();
  if (!who) return;
  const body = /^[A-Za-z0-9:._-]{8,}$/.test(who) && who.length > 12
    ? { accountId: who } : { name: who };
  await api('/api/jira/issue/' + encodeURIComponent(it.key) + '/watchers',
    { method: 'POST', body });
  toast('WATCHER ADDED', 'ok');
  await openJiraIssue(it.key);
}

async function voteIssue(key) {
  await api('/api/jira/issue/' + encodeURIComponent(key) + '/vote', { method: 'POST', body: {} });
  toast('VOTE CAST', 'ok'); blip(1320, .05);
  await openJiraIssue(key);
}

let wlEditId = null;
async function loadWorklogs(key) {
  const box = $('#worklog-list');
  if (!box) return;
  try {
    const d = await api('/api/jira/issue/' + encodeURIComponent(key) + '/worklog');
    const ws = d.worklogs || [];
    box.innerHTML = ws.map(w => `
      <div class="link-row">
        <span class="link-desc">${esc(w.timeSpent || '')}</span>
        <span class="link-sum">${esc(w.author || '')} · ${esc((w.started || '').slice(0, 10))}${w.comment ? ' · ' + esc(w.comment) : ''}</span>
        <button class="act wl-edit" data-wid="${esc(w.id)}" data-time="${esc(w.timeSpent || '')}" data-date="${esc((w.started || '').slice(0, 10))}" data-comment="${esc(w.comment || '')}">[E]</button>
        <button class="act danger wl-del" data-wid="${esc(w.id)}">[X]</button>
      </div>`).join('') || '<div class="sub">NO WORK LOGGED.</div>';
    box.querySelectorAll('.wl-edit').forEach(b => b.addEventListener('click', () => {
      wlEditId = b.dataset.wid;
      $('#wl-time').value = b.dataset.time || '';
      $('#wl-date').value = b.dataset.date || '';
      $('#wl-comment').value = b.dataset.comment || '';
      $('#wl-add').textContent = '[ SAVE ]';
      $('#wl-time').focus();
    }));
    box.querySelectorAll('.wl-del').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog('[ DELETE ] WORKLOG',
        'DELETE WORKLOG ENTRY ' + b.dataset.wid + '?');
      if (!ok) return;
      await api('/api/jira/issue/' + encodeURIComponent(key) +
        '/worklog/' + encodeURIComponent(b.dataset.wid), { method: 'DELETE' });
      toast('WORKLOG DELETED', 'ok');
      wlEditId = null;
      loadWorklogs(key);
    }));
  } catch (e) { box.innerHTML = '<div class="sub">WORKLOG UNAVAILABLE</div>'; }
}

async function addWorklog() {
  const it = state.jira.detail;
  const time = ($('#wl-time') || {}).value.trim();
  if (!time) { toast('ENTER TIME (e.g. 1h 30m)', 'err'); return; }
  const body = { timeSpent: time };
  const d = ($('#wl-date') || {}).value;
  if (d) body.started = d + 'T12:00:00.000+0000';
  const c = ($('#wl-comment') || {}).value.trim();
  if (c) body.comment = c;
  if (wlEditId) {
    await api('/api/jira/issue/' + encodeURIComponent(it.key) +
      '/worklog/' + encodeURIComponent(wlEditId), { method: 'PUT', body });
    toast('WORKLOG UPDATED', 'ok');
  } else {
    await api('/api/jira/issue/' + encodeURIComponent(it.key) + '/worklog',
      { method: 'POST', body });
    toast('WORK LOGGED', 'ok'); blip(1200, .04);
  }
  wlEditId = null;
  $('#wl-add').textContent = '[ LOG ]';
  loadWorklogs(it.key);
  $('#wl-time').value = ''; $('#wl-comment').value = '';
}

async function addRemoteLink() {
  const it = state.jira.detail;
  const url = ($('#rl-url') || {}).value.trim();
  if (!url) { toast('ENTER A URL', 'err'); return; }
  await api('/api/jira/issue/' + encodeURIComponent(it.key) + '/remlink',
    { method: 'POST', body: { url, title: ($('#rl-title') || {}).value.trim() } });
  toast('REMOTE LINK ADDED', 'ok');
  await openJiraIssue(it.key);
}

async function deleteRemoteLink(rid) {
  const it = state.jira.detail;
  await api('/api/jira/issue/' + encodeURIComponent(it.key) + '/remlink/' + encodeURIComponent(rid),
    { method: 'DELETE' });
  toast('REMOTE LINK REMOVED', 'ok');
  await openJiraIssue(it.key);
}

function newSubtask() {
  const it = state.jira.detail;
  if (!it) return;
  const project = (it.key || '').split('-')[0];
  openEditor({
    title: true, titleValue: '',
    fieldsHTML: `
      <label>PARENT</label>
      <input type="text" value="${esc(it.key)}" disabled>
      <label>TYPE</label>
      <input type="text" value="Sub-task" disabled>`,
    html: '',
    onSave: async ed => {
      if (!ed.title) { toast('SUMMARY REQUIRED', 'err'); throw new Error('validation'); }
      const d = await api('/api/jira/issue', { method: 'POST',
        body: { project, issuetype: 'Sub-task', parent: it.key,
                summary: ed.title, description_html: ed.html } });
      toast('SUBTASK FILED: ' + d.key, 'ok');
      await openJiraIssue(it.key);
    },
  });
}

async function editJiraFields() {
  const it = state.jira.detail;
  if (!it) return;
  let meta = { fields: {} };
  try { meta = await api('/api/jira/issue/' + encodeURIComponent(it.key) + '/editmeta'); } catch (e) { /* degrade to plain inputs */ }
  const byName = n => Object.values(meta.fields || {}).find(f =>
    (f.name || '').toLowerCase() === n);
  const opts = f => (f && f.allowedValues || []).map(v =>
    `<option value="${esc(v.value ?? v.id ?? '')}">${esc(v.value ?? v.id ?? '')}</option>`).join('');
  const dl = (id, f) => `<datalist id="${id}">${opts(f)}</datalist>`;
  const prio = byName('priority'), comp = byName('components'), fv = byName('fix versions');
  openEditor({
    title: false,
    fieldsHTML: `
      <label>PRIORITY</label>
      <input id="f-priority" type="text" list="dl-prio" value="${esc(it.priority ? (it.priority.name || it.priority) : '')}">
      ${dl('dl-prio', prio)}
      <label>DUE DATE</label>
      <input id="f-duedate" type="date" value="${esc(it.duedate || '')}">
      <label>LABELS (COMMA SEPARATED)</label>
      <input id="f-labels" type="text" value="${esc((it.labels || []).join(', '))}">
      <label>COMPONENTS (COMMA SEPARATED)</label>
      <input id="f-components" type="text" list="dl-comp" value="${esc((it.components || []).join(', '))}">
      ${dl('dl-comp', comp)}
      <label>FIX VERSIONS (COMMA SEPARATED)</label>
      <input id="f-fixversions" type="text" list="dl-fv" value="${esc((it.fixVersions || []).join(', '))}">
      ${dl('dl-fv', fv)}
      <label>ASSIGNEE (NAME / ACCOUNT ID / EMAIL)</label>
      <input id="f-assignee" type="text" list="dl-users" value="${esc(person(it.assignee))}">
      <datalist id="dl-users"></datalist>`,
    html: '',
    onSave: async () => {
      const fields = {};
      const pr = readField('f-priority'); if (pr) fields.priority = pr;
      const dd = readField('f-duedate'); if (dd) fields.duedate = dd;
      fields.labels = readField('f-labels');
      fields.components = readField('f-components');
      fields.fixVersions = readField('f-fixversions');
      const who = readField('f-assignee');
      if (who && who !== person(it.assignee)) {
        try {
          const users = await api('/api/jira/users?q=' + encodeURIComponent(who));
          const u = users.find(x =>
            [x.displayName, x.name, x.email].includes(who)) || users[0];
          fields.assignee = u && u.accountId ? { accountId: u.accountId } : who;
        } catch (e) { fields.assignee = who; }
      }
      setStatus('WRITING FIELDS...');
      await api('/api/jira/issue/' + encodeURIComponent(it.key), {
        method: 'PUT', body: { fields },
      });
      toast(it.key + ' FIELDS UPDATED', 'ok');
      await openJiraIssue(it.key);
    },
  });
  // warm the assignee datalist
  const inp = $('#f-assignee');
  inp && inp.addEventListener('input', async () => {
    const q = inp.value.trim();
    if (q.length < 2) return;
    try {
      const users = await api('/api/jira/users?q=' + encodeURIComponent(q));
      $('#dl-users').innerHTML = users.map(u =>
        `<option value="${esc(u.displayName || u.name)}">${esc(u.email || '')}</option>`).join('');
    } catch (e) { /* ignore */ }
  });
}

function editJiraIssue() {
  const it = state.jira.detail;
  if (!it) return;
  openEditor({
    title: true, titleValue: it.summary,
    html: it.description_html || '',
    onSave: async ed => {
      setStatus('WRITING TO THE MAINFRAME...');
      await api('/api/jira/issue/' + encodeURIComponent(it.key), {
        method: 'PUT', body: { summary: ed.title, description_html: ed.html },
      });
      toast(it.key + ' UPDATED', 'ok');
      await openJiraIssue(it.key);
    },
  });
}

async function postComment() {
  const it = state.jira.detail, box = $('#cmt');
  const text = box.value.trim();
  if (!text) return;
  await api('/api/jira/issue/' + encodeURIComponent(it.key) + '/comment', {
    method: 'POST', body: { body_html: textToHtml(text) },
  });
  toast('COMMENT POSTED', 'ok'); blip(1200, .04);
  await openJiraIssue(it.key);
}

const isCommentField = (fid, f) =>
  /comment/i.test(fid) || /comment/i.test((f && f.name) || '');

function transitionForm(t) {
  const it = state.jira.detail;
  const fields = t.fields || {};
  const fids = Object.keys(fields);
  if (!fids.length) return false;
  let html = '';
  for (const fid of fids) {
    const f = fields[fid] || {};
    const label = ((f.name || fid) + (f.required ? ' *' : '')).toUpperCase();
    const av = f.allowedValues || [];
    if (av.length) {
      html += `<label>${esc(label)}</label><select id="tf-${esc(fid)}">` +
        av.map(v => `<option value="${esc(v.id || v.value)}" data-name="${esc(v.value || v.id || '')}">${esc(v.value || v.id || '')}</option>`).join('') +
        `</select>`;
    } else if (isCommentField(fid, f)) {
      html += `<label>${esc(label)}</label><textarea id="tf-${esc(fid)}" class="comment-box" rows="3" placeholder="COMMENT..."></textarea>`;
    } else {
      html += `<label>${esc(label)}</label><input id="tf-${esc(fid)}" type="text">`;
    }
  }
  openEditor({
    title: false, fieldsHTML: html, html: '',
    onSave: async () => {
      const tf = {};
      for (const fid of fids) {
        const f = fields[fid] || {};
        const el = document.getElementById('tf-' + fid);
        if (!el || !el.value) {
          if (f.required) { toast('REQUIRED: ' + (f.name || fid).toUpperCase(), 'err'); throw new Error('validation'); }
          continue;
        }
        if ((f.allowedValues || []).length) {
          const opt = el.selectedOptions && el.selectedOptions[0];
          tf[fid] = { id: el.value, name: opt ? opt.dataset.name : el.value };
        } else {
          tf[fid] = isCommentField(fid, f) ? textToHtml(el.value) : el.value;
        }
      }
      setStatus('TRANSITIONING ' + it.key + '...');
      await api('/api/jira/issue/' + encodeURIComponent(it.key), {
        method: 'PUT', body: { transition_id: t.id, transition_fields: tf },
      });
      toast('STATUS TRANSITIONED', 'ok'); blip(1200, .04);
      await openJiraIssue(it.key);
    },
  });
  return true;
}

async function applyTransition(tid) {
  const it = state.jira.detail;
  if (!tid) return;
  const t = (it.transitions || []).find(x => String(x.id) === String(tid));
  if (t && transitionForm(t)) return;
  await api('/api/jira/issue/' + encodeURIComponent(it.key), {
    method: 'PUT', body: { transition_id: tid },
  });
  toast('STATUS TRANSITIONED', 'ok'); blip(1200, .04);
  await openJiraIssue(it.key);
}

async function deleteJiraIssue() {
  const it = state.jira.detail;
  if (!it) return;
  const ok = await confirmDialog('[ DANGER ] DELETE ' + it.key, 'THIS WILL SEND ' + it.key + ' TO THE VOID.\nPROCEED?');
  if (!ok) return;
  setStatus('DELETING ' + it.key + '...');
  await api('/api/jira/issue/' + encodeURIComponent(it.key), { method: 'DELETE' });
  toast(it.key + ' DELETED', 'ok'); blip(300, .08);
  backToList();
}

function newJiraIssue() {
  const projList = (state.projects || []).map(p => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('');
  openEditor({
    title: true, titleValue: '',
    fieldsHTML: `
      <label>PROJECT</label>
      <input id="f-project" type="text" list="projlist" placeholder="PROJ">
      <datalist id="projlist">${projList}</datalist>
      <label>ISSUE TYPE</label>
      <input id="f-type" type="text" value="Task">`,
    html: '',
    onSave: async ed => {
      const project = readField('f-project'), type = readField('f-type') || 'Task';
      if (!project || !ed.title) { toast('PROJECT AND SUMMARY REQUIRED', 'err'); throw new Error('validation'); }
      setStatus('FILING NEW TICKET...');
      const d = await api('/api/jira/issue', {
        method: 'POST',
        body: { project, summary: ed.title, issuetype: type, description_html: ed.html },
      });
      toast('TICKET FILED: ' + d.key, 'ok'); blip(1320, .06);
      await loadJiraIssues();
      if (d.key) openJiraIssue(d.key);
    },
  });
}

async function loadProjects() {
  try { state.projects = await api('/api/jira/projects'); } catch (e) { state.projects = []; }
  if (state.tab === 'jira' && state.jira.view === 'boards') renderJiraBoardHead();
}

function routeJiraView() {
  const v = state.jira.view;
  if (v === 'boards') renderJiraBoardHead();
  else if (v === 'backlog') { renderJiraBacklogHead(); renderBacklog(); }
  else { renderJiraListHead(); loadJiraIssues(); }
}

/* ============ JIRA BOARDS ============ */
function renderJiraBoardHead() {
  const j = state.jira;
  const projOpts = (state.projects || []).map(p =>
    `<option value="${esc(p.key)}"${p.key === j.boardProject ? ' selected' : ''}>${esc(p.key)} — ${esc(p.name)}</option>`).join('');
  const boardOpts = j.boards.map(b =>
    `<option value="${b.id}"${String(b.id) === String(j.board && j.board.id) ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  const sprintOpts = j.sprints.map(s =>
    `<option value="${s.id}"${String(s.id) === String(j.sprint && j.sprint.id) ? ' selected' : ''}>${esc(s.name)} [${esc(s.state || '')}]</option>`).join('');
  $('#list-head').innerHTML = `
    <div class="btn-row" style="margin:0">
      <button class="act" data-view="issues">[ ISSUES ]</button>
      <button class="act primary" data-view="boards">[ BOARDS ]</button>
      <button class="act" data-view="backlog">[ BACKLOG ]</button>
    </div>
    <label>PROJECT</label>
    <select id="b-project"><option value="">— ALL PROJECTS —</option>${projOpts}</select>
    <label>BOARD</label>
    <select id="b-board"><option value="">— PICK PROJECT FIRST —</option>${boardOpts}</select>
    <label>SPRINT</label>
    <select id="b-sprint"><option value="">— PICK BOARD FIRST —</option>${sprintOpts}</select>
    <div class="btn-row">
      <button id="b-load" class="act primary">[ LOAD BOARD ]</button>
      <button id="b-group" class="act">[ GROUP: ${j.group.toUpperCase()} ]</button>
      ${j.sprint ? `<button id="b-report" class="act">[ ${j.reportMode ? 'BOARD' : 'REPORT'} ]</button>` : ''}
      ${j.boardProject ? `<button id="b-vers" class="act">[ ${j.versionsMode ? 'BOARD' : 'VERSIONS'} ]</button>` : ''}
      ${j.board ? `<button id="b-newsprint" class="act">[ NEW SPRINT ]</button>
      ${j.sprint && j.sprint.state === 'future' ? '<button id="b-start" class="act">[ START ]</button>' : ''}
      ${j.sprint && j.sprint.state === 'active' ? '<button id="b-close" class="act">[ COMPLETE ]</button>' : ''}` : ''}
    </div>`;
  document.querySelectorAll('#list-head [data-view]').forEach(b =>
    b.addEventListener('click', () => { state.jira.view = b.dataset.view; routeJiraView(); }));
  $('#b-project').addEventListener('change', async e => {
    j.boardProject = e.target.value;
    j.board = null; j.sprints = []; j.sprint = null; j.columns = [];
    j.versionsMode = false; j.versions = null;
    j.reportMode = false; j.report = null;
    setStatus('FETCHING BOARDS...');
    try {
      j.boards = await api('/api/jira/boards?project=' + encodeURIComponent(j.boardProject));
      toast(j.boards.length + ' BOARD(S)', 'info');
    } catch (err) { j.boards = []; }
    renderJiraBoardHead();
  });
  $('#b-board').addEventListener('change', async e => {
    j.board = j.boards.find(b => String(b.id) === e.target.value) || null;
    j.sprints = []; j.sprint = null; j.columns = [];
    j.versionsMode = false; j.versions = null;
    j.reportMode = false; j.report = null;
    if (!j.board) { renderJiraBoardHead(); return; }
    setStatus('FETCHING SPRINTS...');
    try {
      j.sprints = await api('/api/jira/boards/' + encodeURIComponent(j.board.id) + '/sprints');
      j.sprint = j.sprints.find(s => s.state === 'active') || j.sprints[0] || null;
      if (j.sprint) await loadBoard();
    } catch (err) { /* toast shown */ }
    renderJiraBoardHead();
  });
  $('#b-sprint').addEventListener('change', async e => {
    j.sprint = j.sprints.find(s => String(s.id) === e.target.value) || null;
    j.versionsMode = false;
    j.reportMode = false; j.report = null;
    if (j.sprint) await loadBoard();
    renderJiraBoardHead();
  });
  $('#b-load').addEventListener('click', loadBoard);
  $('#b-group').addEventListener('click', () => {
    j.group = j.group === 'status' ? 'epic' : 'status';
    if (j.sprint) loadBoard(); else renderJiraBoardHead();
  });
  const bv = $('#b-vers');
  if (bv) bv.onclick = toggleVersions;
  const br = $('#b-report');
  if (br) br.onclick = toggleReport;
  const ns = $('#b-newsprint');
  if (ns) ns.onclick = async () => {
    const name = prompt('NEW SPRINT NAME');
    if (!name) return;
    try {
      await api('/api/jira/sprints', { method: 'POST',
        body: { name, board_id: j.board.id } });
      toast('SPRINT CREATED', 'ok'); blip(1320, .05);
      j.sprints = await api('/api/jira/boards/' + encodeURIComponent(j.board.id) + '/sprints');
      renderJiraBoardHead();
    } catch (e) { /* toast shown */ }
  };
  const st = $('#b-start');
  if (st) st.onclick = () => sprintState('active');
  const cl = $('#b-close');
  if (cl) cl.onclick = () => sprintState('closed');
}

async function toggleVersions() {
  const j = state.jira;
  j.versionsMode = !j.versionsMode;
  renderJiraBoardHead();
  if (!j.versionsMode) {
    if (j.sprint && j.columns.length) renderBoard();
    return;
  }
  setStatus('FETCHING VERSIONS...');
  try {
    j.versions = await api('/api/jira/project/' + encodeURIComponent(j.boardProject) + '/versions');
  } catch (e) { j.versions = []; }
  renderVersions();
}

async function toggleReport() {
  const j = state.jira;
  j.reportMode = !j.reportMode;
  renderJiraBoardHead();
  if (!j.reportMode) {
    if (j.columns.length) renderBoard();
    return;
  }
  setStatus('FETCHING SPRINT REPORT...');
  try {
    j.report = await api('/api/jira/sprints/' + encodeURIComponent(j.sprint.id) + '/report');
  } catch (e) { j.report = null; }
  renderSprintReport();
}

function renderSprintReport() {
  const j = state.jira, r = j.report;
  const vel = (r && r.velocity) || {};
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <h1>SPRINT REPORT // ${esc(j.sprint ? j.sprint.name : '')}</h1>
      <div class="sub">${r ? esc(r.name || '') + ' · ' + esc(r.state || '') : 'REPORT UNAVAILABLE'} · [ REPORT ] TOGGLES BACK TO THE BOARD</div>
    </div>
    ${r ? `
    <div class="kv">
      <span class="k">PERIOD</span><span class="v">${esc((r.startDate || '').slice(0, 10))} → ${esc((r.endDate || '').slice(0, 10))}</span>
      <span class="k">COMPLETED</span><span class="v">${esc(r.completed ?? '?')}</span>
      <span class="k">NOT COMPLETED</span><span class="v">${esc(r.notCompleted ?? '?')}</span>
      <span class="k">PUNTED</span><span class="v">${esc(r.punted ?? '?')}</span>
      ${vel.avg != null ? `<span class="k">VELOCITY</span><span class="v">AVG ${esc(vel.avg)} · LAST ${esc(vel.complete)} · EST ${esc(vel.estimated)}</span>` : ''}
    </div>` : '<div class="empty">SPRINT REPORT UNAVAILABLE — THE AGILE API MAY NOT SUPPORT IT ON THIS INSTANCE.</div>'}`;
  setStatus('SPRINT REPORT LOADED');
}

function renderVersions() {
  const j = state.jira;
  const vs = j.versions || [];
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <h1>VERSIONS // ${esc(j.boardProject || '')}</h1>
      <div class="sub">${vs.length} RELEASE(S) · [ VERSIONS ] BUTTON TOGGLES BACK TO THE BOARD</div>
    </div>
    ${vs.map(v => `
      <div class="link-row">
        <span class="link-desc">${v.released ? 'RELEASED' : v.archived ? 'ARCHIVED' : 'OPEN'}</span>
        <span class="link-key">${esc(v.name)}</span>
        <span class="link-sum">${v.issues == null ? '?' : v.issues} ISSUE(S)${v.releaseDate ? ' · ' + esc(v.releaseDate) : ''}${v.dueDate ? ' · DUE ' + esc(v.dueDate) : ''}</span>
      </div>`).join('') || '<div class="empty">NO VERSIONS DEFINED FOR THIS PROJECT.</div>'}`;
  setStatus('VERSIONS LOADED');
}

async function sprintState(state_) {
  const j = state.jira;
  if (!j.sprint) return;
  if (state_ === 'closed' &&
      !(await confirmDialog('[ COMPLETE ] SPRINT',
        'COMPLETE ' + j.sprint.name + '? UNFINISHED ISSUES RETURN TO THE BACKLOG.'))) return;
  try {
    await api('/api/jira/sprints/' + encodeURIComponent(j.sprint.id) + '/state',
      { method: 'POST', body: { state: state_ } });
    toast('SPRINT ' + state_.toUpperCase(), 'ok');
    j.sprints = await api('/api/jira/boards/' + encodeURIComponent(j.board.id) + '/sprints');
    j.sprint = j.sprints.find(s => String(s.id) === String(j.sprint.id)) || j.sprint;
    renderJiraBoardHead();
    if (j.sprint) await loadBoard();
  } catch (e) { /* toast shown */ }
}

async function loadBoard() {
  const j = state.jira;
  if (!j.sprint) return;
  setStatus('LOADING SPRINT BOARD...');
  try {
    const cards = await api('/api/jira/sprints/' + encodeURIComponent(j.sprint.id) + '/issues');
    let cfgCols = null;
    if (j.group === 'status') {
      if (!j.boardCfg || String(j.boardCfg.id) !== String(j.board && j.board.id)) {
        try { j.boardCfg = await api('/api/jira/boards/' + encodeURIComponent(j.board.id) + '/configuration'); }
        catch (e) { j.boardCfg = { columns: [] }; }
      }
      cfgCols = j.boardCfg.columns || [];
    }
    j.columns = buildColumns(cards, j.group, cfgCols);
    j.bsel = { s: -1, i: -1 };
    renderBoard();
    setStatus(j.columns.reduce((n, c) => n + c.issues.length, 0) + ' CARD(S) ON BOARD');
    blip(1200, .04);
  } catch (e) { /* toast shown */ }
}

function buildColumns(cards, group, cfgCols) {
  if (group === 'epic') {
    const cols = new Map();
    for (const c of cards) {
      const s = c.epic || 'NO EPIC';
      if (!cols.has(s)) cols.set(s, []);
      cols.get(s).push(c);
    }
    return [...cols.entries()].map(([name, issues]) =>
      ({ name, issues, statusNames: [] }));
  }
  // status grouping uses the board's configured columns when available
  const colOf = card => {
    const sid = String(card.status_id || ''), sname = (card.status || '').toLowerCase();
    for (const col of cfgCols || []) {
      if ((col.statuses || []).some(s => String(s.id) === sid ||
          (s.name || '').toLowerCase() === sname)) return col.name;
    }
    return null;
  };
  const out = [], idx = new Map(), other = [];
  for (const col of cfgCols || []) {
    const name = col.name || 'COLUMN';
    idx.set(name, out.length);
    out.push({ name, issues: [],
      statusNames: (col.statuses || []).map(s => (s.name || '').toLowerCase()) });
  }
  for (const c of cards) {
    const name = colOf(c);
    if (name != null && idx.has(name)) out[idx.get(name)].issues.push(c);
    else other.push(c);
  }
  if (!cfgCols || !cfgCols.length) {
    // no config: distinct statuses, first-seen order
    const cols = new Map();
    for (const c of cards) {
      const s = c.status || 'UNKNOWN';
      if (!cols.has(s)) cols.set(s, []);
      cols.get(s).push(c);
    }
    return [...cols.entries()].map(([name, issues]) =>
      ({ name, issues, statusNames: [name.toLowerCase()] }));
  }
  if (other.length) out.push({ name: 'OTHER', issues: other, statusNames: [] });
  return out;
}

function boardFlat() {
  const out = [];
  state.jira.columns.forEach((c, s) => c.issues.forEach((card, i) => out.push({ s, i, card })));
  return out;
}

function renderBoard() {
  const j = state.jira;
  if (!j.columns.length) {
    $('#detail-body').innerHTML = '<div class="empty">NO BOARD LOADED. PICK PROJECT → BOARD → SPRINT.</div>';
    return;
  }
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <h1>BOARD // ${esc(j.board ? j.board.name : '')} — ${esc(j.sprint ? j.sprint.name : '')}</h1>
      <div class="sub">${esc(j.sprint ? j.sprint.state : '')} · GROUP ${esc(j.group.toUpperCase())} · ${j.columns.reduce((n, c) => n + c.issues.length, 0)} CARD(S) · [ / ] MOVE CARD · J/K NAV · ENTER OPEN</div>
    </div>
    <div class="board">${j.columns.map((c, s) => `
      <div class="board-col">
        <div class="board-col-head">${esc(c.name)} <span class="board-count">${c.issues.length}</span></div>
        ${c.issues.map((card, i) => `
          <div class="bcard${j.bsel.s === s && j.bsel.i === i ? ' sel' : ''}" data-s="${s}" data-i="${i}" draggable="true">
            <div class="bcard-key">${esc(card.key)}</div>
            <div class="bcard-sum">${esc(card.summary)}</div>
            <div class="bcard-meta">${esc(card.assignee || '—')}${card.points ? ' · ' + esc(card.points) + 'pt' : ''}</div>
          </div>`).join('')}
      </div>`).join('')}
    </div>`;
  document.querySelectorAll('.bcard').forEach(el => {
    el.addEventListener('click', () => {
      j.bsel = { s: +el.dataset.s, i: +el.dataset.i };
      openJiraIssue(j.columns[j.bsel.s].issues[j.bsel.i].key);
    });
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain',
        JSON.stringify({ s: +el.dataset.s, i: +el.dataset.i }));
      e.dataTransfer.effectAllowed = 'move';
    });
  });
  document.querySelectorAll('.board-col').forEach((col, ns) => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', async e => {
      e.preventDefault(); col.classList.remove('drop');
      try {
        const { s, i } = JSON.parse(e.dataTransfer.getData('text/plain'));
        await moveCardToColumn(s, i, ns);
      } catch (err) { /* bad payload */ }
    });
  });
}

async function moveCardToColumn(s, i, ns) {
  const j = state.jira;
  if (j.group === 'epic') { toast('EPIC SWIMLANES: MOVE DISABLED', 'info'); return; }
  if (s === ns || !j.columns[s] || !j.columns[ns]) return;
  const card = j.columns[s].issues[i];
  const target = j.columns[ns];
  const names = (target.statusNames && target.statusNames.length
    ? target.statusNames : [target.name.toLowerCase()]);
  try {
    const d = await api('/api/jira/issue/' + encodeURIComponent(card.key));
    const t = (d.transitions || []).find(x =>
      names.includes((x.to || '').toLowerCase()) ||
      names.includes((x.name || '').toLowerCase()));
    if (!t) { toast('NO TRANSITION TO ' + target.name.toUpperCase(), 'err'); return; }
    if (t.fields && Object.keys(t.fields).length) {
      state.jira.detail = d;
      transitionForm(t);
      return;
    }
    await api('/api/jira/issue/' + encodeURIComponent(card.key), {
      method: 'PUT', body: { transition_id: t.id },
    });
    toast(card.key + ' → ' + target.name, 'ok'); blip(1200, .04);
    await loadBoard();
  } catch (e) { /* toast shown */ }
}

async function moveBoardCard(dir) {
  const j = state.jira;
  if (j.group === 'epic') { toast('EPIC SWIMLANES: MOVE DISABLED', 'info'); return; }
  const { s, i } = j.bsel;
  if (s < 0 || i < 0 || !j.columns[s]) return;
  const ns = s + dir;
  if (ns < 0 || ns >= j.columns.length) { toast('EDGE OF BOARD', 'info'); return; }
  await moveCardToColumn(s, i, ns);
}

/* ============ JIRA BACKLOG ============ */
function renderJiraBacklogHead() {
  const j = state.jira;
  const projOpts = (state.projects || []).map(p =>
    `<option value="${esc(p.key)}"${p.key === j.boardProject ? ' selected' : ''}>${esc(p.key)} — ${esc(p.name)}</option>`).join('');
  const boardOpts = j.boards.map(b =>
    `<option value="${b.id}"${String(b.id) === String(j.board && j.board.id) ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  const sprintOpts = j.sprints.filter(s => s.state !== 'closed').map(s =>
    `<option value="${s.id}">${esc(s.name)} [${esc(s.state || '')}]</option>`).join('');
  $('#list-head').innerHTML = `
    <div class="btn-row" style="margin:0">
      <button class="act" data-view="issues">[ ISSUES ]</button>
      <button class="act" data-view="boards">[ BOARDS ]</button>
      <button class="act primary" data-view="backlog">[ BACKLOG ]</button>
    </div>
    <label>PROJECT</label>
    <select id="bl-project"><option value="">— ALL PROJECTS —</option>${projOpts}</select>
    <label>BOARD</label>
    <select id="bl-board"><option value="">— PICK PROJECT FIRST —</option>${boardOpts}</select>
    <label>TARGET SPRINT</label>
    <select id="bl-sprint"><option value="">— BACKLOG —</option>${sprintOpts}</select>
    <div class="btn-row">
      <button id="bl-load" class="act primary">[ LOAD BACKLOG ]</button>
      <button id="bl-tosprint" class="act">[ → SPRINT ]</button>
      <button id="bl-tobacklog" class="act">[ → BACKLOG ]</button>
    </div>
    <div class="btn-row" style="margin:0">
      <span class="sub" id="bl-count">${j.backlog.checked.size} SELECTED</span>
    </div>`;
  document.querySelectorAll('#list-head [data-view]').forEach(b =>
    b.addEventListener('click', () => { state.jira.view = b.dataset.view; routeJiraView(); }));
  $('#bl-project').addEventListener('change', async e => {
    j.boardProject = e.target.value;
    j.board = null; j.sprints = []; j.backlog.sections = [];
    try {
      j.boards = await api('/api/jira/boards?project=' + encodeURIComponent(j.boardProject));
    } catch (err) { j.boards = []; }
    renderJiraBacklogHead();
  });
  $('#bl-board').addEventListener('change', async e => {
    j.board = j.boards.find(b => String(b.id) === e.target.value) || null;
    j.sprints = []; j.backlog.sections = [];
    if (!j.board) { renderJiraBacklogHead(); return; }
    try {
      j.sprints = await api('/api/jira/boards/' + encodeURIComponent(j.board.id) + '/sprints');
      renderJiraBacklogHead();
      await loadBacklog();
    } catch (err) { /* toast shown */ }
  });
  $('#bl-load').addEventListener('click', loadBacklog);
  $('#bl-tosprint').addEventListener('click', () => moveChecked('sprint'));
  $('#bl-tobacklog').addEventListener('click', () => moveChecked('backlog'));
}

async function loadBacklog() {
  const j = state.jira;
  if (!j.board) { toast('PICK A BOARD FIRST', 'err'); return; }
  setStatus('LOADING BACKLOG...');
  try {
    const bid = encodeURIComponent(j.board.id);
    const [backlog, sprints] = await Promise.all([
      api('/api/jira/boards/' + bid + '/backlog'),
      api('/api/jira/boards/' + bid + '/sprints'),
    ]);
    j.sprints = sprints || [];
    const open = j.sprints.filter(s => s.state !== 'closed');
    const sections = await Promise.all(open.map(async s => ({
      kind: 'sprint', id: s.id, name: s.name + ' [' + (s.state || '') + ']',
      issues: await api('/api/jira/sprints/' + encodeURIComponent(s.id) + '/issues'),
    })));
    sections.push({ kind: 'backlog', id: null, name: 'BACKLOG', issues: backlog || [] });
    j.backlog.sections = sections;
    j.backlog.checked.clear();
    renderBacklog();
    renderJiraBacklogHead();
    setStatus('BACKLOG LOADED');
    blip(1200, .04);
  } catch (e) { renderBacklog(); }
}

function renderBacklog() {
  const j = state.jira;
  const secs = j.backlog.sections;
  if (!secs.length) {
    $('#detail-body').innerHTML = '<div class="empty">NO BACKLOG LOADED. PICK PROJECT → BOARD.</div>';
    return;
  }
  $('#detail-body').innerHTML = secs.map((sec, si) => `
    <div class="detail-section bl-sec" data-si="${si}">
      <h2>${esc(sec.name)} <span class="sub">(${sec.issues.length})</span></h2>
      ${sec.issues.map((c, i) => `
        <div class="link-row bl-row" data-si="${si}" data-i="${i}" draggable="true">
          <input type="checkbox" class="ck" data-key="${esc(c.key)}"${j.backlog.checked.has(c.key) ? ' checked' : ''}>
          <a class="link-key" data-key="${esc(c.key)}">${esc(c.key)}</a>
          <span class="link-sum">${esc(c.summary)} · ${esc(c.status || '')}</span>
          ${sec.kind === 'backlog' ? `<button class="act bl-rank" data-dir="-1" data-si="${si}" data-i="${i}">[↑]</button>
          <button class="act bl-rank" data-dir="1" data-si="${si}" data-i="${i}">[↓]</button>` : ''}
        </div>`).join('') || '<div class="sub">EMPTY.</div>'}
    </div>`).join('');
  document.querySelectorAll('.bl-row .link-key').forEach(a =>
    a.addEventListener('click', () => openJiraIssue(a.dataset.key)));
  document.querySelectorAll('.bl-row .ck').forEach(c => c.addEventListener('click', e => {
    e.stopPropagation();
    c.checked ? j.backlog.checked.add(c.dataset.key) : j.backlog.checked.delete(c.dataset.key);
    renderJiraBacklogHead();
  }));
  document.querySelectorAll('.bl-rank').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const si = +b.dataset.si, i = +b.dataset.i, dir = +b.dataset.dir;
    const issues = secs[si].issues;
    const before = dir < 0 ? (issues[i - 1] || {}).key
      : (issues[i + 2] || {}).key;  // skip self + next
    if (!before) { toast(dir < 0 ? 'ALREADY TOP' : 'ALREADY BOTTOM', 'info'); return; }
    try {
      await api('/api/jira/issues/rank', { method: 'POST',
        body: { keys: [issues[i].key], before } });
      toast(issues[i].key + ' RANKED', 'ok');
      await loadBacklog();
    } catch (err) { /* toast shown */ }
  }));
  // drag-position ranking: drop on a row = insert before it; drop on the
  // section body below the last row = rank after the last issue
  document.querySelectorAll('.bl-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain',
        JSON.stringify({ si: +row.dataset.si, i: +row.dataset.i }));
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drop'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); row.classList.remove('drop');
      try {
        const d = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (d.si !== +row.dataset.si) return;  // rank within a section only
        const ti = +row.dataset.i;
        await rankMove(secs[d.si], d.i, ti);
      } catch (err) { /* bad payload */ }
    });
  });
  document.querySelectorAll('.bl-sec').forEach(secEl => {
    const si = +secEl.dataset.si, sec = secs[si];
    secEl.addEventListener('dragover', e => e.preventDefault());
    secEl.addEventListener('drop', async e => {
      if (e.target.closest('.bl-row')) return;  // row handled it
      e.preventDefault();
      try {
        const d = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (d.si !== si || !sec.issues.length) return;
        const dk = sec.issues[d.i].key;
        if (sec.issues[sec.issues.length - 1].key === dk) return;
        await api('/api/jira/issues/rank', { method: 'POST',
          body: { keys: [dk], after: sec.issues[sec.issues.length - 1].key } });
        toast(dk + ' RANKED LAST', 'ok');
        await loadBacklog();
      } catch (err) { /* bad payload */ }
    });
  });
}

async function rankMove(sec, i, ti) {
  const issues = sec.issues;
  const dk = issues[i].key;
  if (dk === issues[ti].key) return;
  // drop on row ti = insert before it; count neighbours excluding self
  const others = issues.filter(x => x.key !== dk);
  const pos = issues.slice(0, ti).filter(x => x.key !== dk).length;
  let body;
  if (!others.length) return;
  else if (pos <= 0) body = { keys: [dk], before: others[0].key };
  else if (pos >= others.length) body = { keys: [dk], after: others[others.length - 1].key };
  else body = { keys: [dk], before: others[pos].key };
  await api('/api/jira/issues/rank', { method: 'POST', body });
  toast(dk + ' RANKED', 'ok');
  await loadBacklog();
}

async function moveChecked(kind) {
  const j = state.jira;
  const keys = [...j.backlog.checked];
  if (!keys.length) { toast('NOTHING SELECTED', 'err'); return; }
  try {
    if (kind === 'sprint') {
      const sid = ($('#bl-sprint') || {}).value;
      if (!sid) { toast('PICK A TARGET SPRINT', 'err'); return; }
      await api('/api/jira/sprints/' + encodeURIComponent(sid) + '/issues',
        { method: 'POST', body: { keys } });
      toast(keys.length + ' ISSUE(S) → SPRINT', 'ok');
    } else {
      await api('/api/jira/backlog/issues', { method: 'POST', body: { keys } });
      toast(keys.length + ' ISSUE(S) → BACKLOG', 'ok');
    }
    blip(1200, .04);
    await loadBacklog();
  } catch (e) { /* toast shown */ }
}

/* ============ CONFLUENCE ============ */
async function loadSpaces() {
  try {
    state.conf.spaces = await api('/api/confluence/spaces');
  } catch (e) { state.conf.spaces = []; }
  renderConfListHead();
}

function confSpaceOpts(f) {
  const f_ = (f || '').toLowerCase();
  return state.conf.spaces
    .filter(s => !f_ || ((s.key || '') + ' ' + (s.name || '')).toLowerCase().includes(f_))
    .map(s => `<option value="${esc(s.key)}"${s.key === state.conf.space ? ' selected' : ''}>${esc(s.key)} — ${esc(s.name)}</option>`).join('');
}

function renderConfListHead() {
  $('#list-head').innerHTML = `
    <label>SPACE</label>
    <input id="csfilter" type="text" placeholder="FILTER SPACES..." spellcheck="false">
    <select id="cspace"><option value="">— ALL / NONE —</option>${confSpaceOpts()}</select>
    <label>SEARCH TITLE</label>
    <input id="cq" type="text" value="${esc(state.conf.q)}" placeholder="TITLE CONTAINS..." spellcheck="false">
    <div class="btn-row" style="margin:0">
      <button id="cadv" class="act${state.conf.adv ? ' primary' : ''}">[ CQL ]</button>
    </div>
    <input id="ccql" type="text" value="${esc(state.conf.cql)}" placeholder='type=page AND space="DOC"' spellcheck="false" ${state.conf.adv ? '' : 'hidden'}>
    <div class="btn-row">
      <button id="crun" class="act primary">[ SEARCH ]</button>
      <button id="cnew" class="act">[ NEW PAGE ]</button>
    </div>`;
  $('#csfilter').addEventListener('input', e => {
    $('#cspace').innerHTML = '<option value="">— ALL / NONE —</option>' + confSpaceOpts(e.target.value);
  });
  $('#cspace').addEventListener('change', e => { state.conf.space = e.target.value; loadConfPages(); });
  $('#cq').addEventListener('keydown', e => { if (e.key === 'Enter') loadConfPages(); });
  $('#ccql').addEventListener('keydown', e => { if (e.key === 'Enter') loadConfPages(); });
  $('#cadv').addEventListener('click', () => {
    state.conf.adv = !state.conf.adv;
    renderConfListHead();
    if (state.conf.adv) $('#ccql').focus();
  });
  $('#crun').addEventListener('click', loadConfPages);
  $('#cnew').addEventListener('click', newConfPage);
}

async function loadConfPages() {
  state.conf.space = $('#cspace') ? $('#cspace').value : state.conf.space;
  state.conf.q = $('#cq') ? $('#cq').value.trim() : state.conf.q;
  state.conf.cql = $('#ccql') ? $('#ccql').value.trim() : state.conf.cql;
  setStatus(state.conf.adv ? 'RUNNING CQL...' : 'SCANNING WIKI...');
  try {
    const path = state.conf.adv && state.conf.cql
      ? '/api/confluence/cql?cql=' + encodeURIComponent(state.conf.cql) + '&limit=200'
      : '/api/confluence/pages?space=' + encodeURIComponent(state.conf.space) +
        '&q=' + encodeURIComponent(state.conf.q) + '&limit=200';
    const d = await api(path);
    state.conf.pages = d.pages || [];
    state.conf.sel = -1; state.conf.mode = 'list';
    renderConfRows();
    setStatus(state.conf.pages.length + ' PAGE(S) FOUND');
    blip(1200, .04);
  } catch (e) { renderConfRows(); }
}

function renderConfRows() {
  const b = box(), items = state.conf.pages;
  if (!items.length) { b.innerHTML = '<div class="empty">NO PAGES. PICK A SPACE OR SEARCH.</div>'; return; }
  vlistRender(b, items, state.conf.sel, (p, i) => `
    <div class="row${i === state.conf.sel ? ' sel' : ''}" data-i="${i}">
      <span class="key">[${esc(p.space)}]</span>
      <span class="title">${esc(p.title)}</span>
      <span class="meta">${esc((p.updated || '').slice(0, 10))}</span>
    </div>`, i => {
    state.conf.sel = i;
    renderConfRows();
    openConfPage(items[i].id);
  });
}

async function openConfPage(id) {
  setStatus('OPENING PAGE ' + id + '...');
  try {
    const p = await api('/api/confluence/page/' + encodeURIComponent(id));
    state.conf.detail = p; state.conf.mode = 'detail';
    renderConfDetail();
    blip(980, .05);
  } catch (e) { /* toast shown */ }
}

function renderConfDetail() {
  const p = state.conf.detail;
  refreshDetail = () => openConfPage(p.id);
  const crumbs = (p.ancestors || []).map(a =>
    `<a class="crumb" data-id="${esc(a.id)}">${esc(a.title)}</a>`).join(' / ');
  const children = (p.children || []).map(c =>
    `<div class="link-row"><a class="link-key" data-id="${esc(c.id)}">${esc(c.title)}</a></div>`).join('');
  const labels = (p.labels || []).map(l =>
    `<span class="chip">${esc(l)}<a class="chip-x" data-label="${esc(l)}">×</a></span>`).join(' ');
  const atts = attRowsHtml(p.attachments);
  const diagrams = (p.diagrams || []).map(d => d.svg
    ? `<div class="diagram"><div class="sub">${esc(d.name)}</div>${d.svg}</div>`
    : d.image
    ? `<div class="diagram"><div class="sub">${esc(d.name)}</div><img src="${esc(d.url)}" loading="lazy"></div>`
    : `<div class="link-row"><span class="link-desc">DIAGRAM</span><a class="link-key" href="${esc(d.url)}">${esc(d.name)}</a></div>`).join('');
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <h1>${esc(p.title)}</h1>
      <div class="sub">SPACE ${esc(p.space)} (${esc(p.space_name || '')}) · VERSION ${esc(p.version)}</div>
      ${crumbs ? `<div class="crumbs">ROOT / ${crumbs} / <b>${esc(p.title)}</b></div>` : ''}
      <div class="chips-row">${labels}<input id="label-add" type="text" placeholder="+ LABEL" class="chip-input"></div>
      <div class="btn-row" style="margin-top:4px">
        <button id="pg-watch" class="act">[ ${p.watching ? 'UNWATCH' : 'WATCH'} ]</button>
        <button id="pg-fav" class="act">[ ${p.favourite ? '★ FAV' : '☆ FAV'} ]</button>
        <button id="pg-move" class="act">[ MOVE ]</button>
        <button id="pg-copy" class="act">[ COPY ]</button>
        <button id="pg-restr" class="act">[ RESTRICTIONS ]</button>
      </div>
      <div id="restr-box"></div>
    </div>
    <div class="detail-section"><h2>CONTENT</h2>
      <div class="detail-body-html">${p.body_html || '<i>(empty)</i>'}</div></div>
    ${diagrams ? `<div class="detail-section"><h2>DIAGRAMS</h2>${diagrams}</div>` : ''}
    ${children ? `<div class="detail-section"><h2>CHILD PAGES</h2>${children}</div>` : ''}
    <div class="detail-section"><h2>ATTACHMENTS</h2>
      ${atts || '<div class="sub">NO ATTACHMENTS.</div>'}
      <div class="btn-row"><button id="att-upload" class="act">[ ATTACH FILE ]</button>
      <button id="hist-btn" class="act">[ HISTORY ]</button></div>
      <div id="hist-box"></div>
    </div>
    <div class="detail-section"><h2>COMMENTS</h2>
      <div id="conf-comments"><div class="sub">LOADING...</div></div>
      <textarea id="pgcmt" class="comment-box" placeholder="WRITE A COMMENT..."></textarea>
      <div class="btn-row"><button id="pgcmt-post" class="act primary">[ POST COMMENT ]</button></div>
    </div>
    <div class="btn-row">
      <button id="d-edit" class="act primary">[ E / EDIT ]</button>
      <button id="d-back" class="act">[ ESC / BACK ]</button>
      <button id="d-del" class="act danger">[ D / DELETE ]</button>
    </div>`;
  $('#d-edit').onclick = editConfPage;
  $('#d-back').onclick = backToList;
  $('#d-del').onclick = deleteConfPage;
  $('#pgcmt-post').onclick = postConfComment;
  $('#pg-watch').onclick = async () => {
    await api('/api/confluence/page/' + encodeURIComponent(p.id) + '/watch',
      { method: p.watching ? 'DELETE' : 'POST', body: {} });
    toast(p.watching ? 'UNWATCHED' : 'WATCHING PAGE', 'ok');
    await openConfPage(p.id);
  };
  $('#pg-fav').onclick = async () => {
    try {
      await api('/api/confluence/page/' + encodeURIComponent(p.id) + '/favourite',
        { method: p.favourite ? 'DELETE' : 'POST', body: {} });
      toast(p.favourite ? 'REMOVED FROM FAVOURITES' : 'ADDED TO FAVOURITES', 'ok');
    } catch (e) { toast('FAVOURITES NOT SUPPORTED HERE', 'err'); }
    await openConfPage(p.id);
  };
  wireMentions($('#detail-body'));
  confReplyTo = null;
  loadConfComments(p.id);
  document.querySelectorAll('.chip-x').forEach(x => x.addEventListener('click', async () => {
    await api('/api/confluence/page/' + encodeURIComponent(p.id) + '/label?name=' +
      encodeURIComponent(x.dataset.label), { method: 'DELETE' });
    toast('LABEL REMOVED', 'ok');
    await openConfPage(p.id);
  }));
  $('#label-add').addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    await api('/api/confluence/page/' + encodeURIComponent(p.id) + '/label',
      { method: 'POST', body: { name: e.target.value.trim() } });
    toast('LABEL ADDED', 'ok');
    await openConfPage(p.id);
  });
  $('#pg-move').onclick = async () => {
    const parent = prompt('NEW PARENT PAGE ID (BLANK = ROOT)', '');
    if (parent === null) return;
    await api('/api/confluence/page/' + encodeURIComponent(p.id) + '/move',
      { method: 'PUT', body: { space: p.space, parent_id: parent || null } });
    toast('PAGE MOVED', 'ok');
    await openConfPage(p.id);
  };
  $('#pg-copy').onclick = async () => {
    const title = prompt('COPY TITLE', p.title + ' (copy)');
    if (title === null) return;
    const d = await api('/api/confluence/page/' + encodeURIComponent(p.id) + '/copy',
      { method: 'POST', body: { title, space: p.space } });
    toast('PAGE COPIED: ' + (d.id || ''), 'ok');
  };
  $('#pg-restr').onclick = async () => {
    const rb = $('#restr-box');
    if (rb.dataset.loaded) { rb.innerHTML = ''; delete rb.dataset.loaded; return; }
    try {
      const r = await api('/api/confluence/page/' + encodeURIComponent(p.id) + '/restrictions');
      rb.innerHTML = r.length
        ? '<div class="chips-row">' + r.map(x =>
            `<span class="chip">${esc(x.type || 'READ')}: ${esc(x.name || '')}</span>`).join('') + '</div>'
        : '<div class="sub">NO READ RESTRICTIONS.</div>';
      rb.dataset.loaded = '1';
    } catch (e) { rb.innerHTML = '<div class="sub">RESTRICTIONS UNAVAILABLE</div>'; }
  };
  wireAttachments('/api/confluence/page/' + encodeURIComponent(p.id) + '/attachment');
  document.querySelectorAll('.crumb, .link-key[data-id]').forEach(a =>
    a.addEventListener('click', () => openConfPage(a.dataset.id)));
  $('#hist-btn').onclick = async () => {
    const hb = $('#hist-box');
    if (hb.dataset.loaded) { hb.innerHTML = ''; delete hb.dataset.loaded; return; }
    try {
      const h = await api('/api/confluence/page/' + encodeURIComponent(p.id) + '/history');
      hb.innerHTML = h.map(v =>
        `<div class="link-row"><span class="link-desc">v${esc(v.number)}</span>
         <span class="link-sum">${esc(v.by || '')} · ${esc((v.when || '').slice(0, 10))}${v.message ? ' · ' + esc(v.message) : ''}</span></div>`).join('');
      hb.dataset.loaded = '1';
    } catch (e) { hb.innerHTML = '<div class="sub">HISTORY UNAVAILABLE</div>'; }
  };
}

let confReplyTo = null;
async function loadConfComments(pid) {
  const box = $('#conf-comments');
  if (!box) return;
  try {
    const cs = await api('/api/confluence/page/' + encodeURIComponent(pid) + '/comments');
    const tops = cs.filter(c => !c.parent);
    const byParent = {};
    cs.forEach(c => { if (c.parent) (byParent[c.parent] = byParent[c.parent] || []).push(c); });
    const row = (c, indent) => `
      <div class="comment"${indent ? ' style="margin-left:28px"' : ''}>
        <div class="who">${esc(c.author)} — ${esc((c.when || '').replace('T', ' ').slice(0, 16))}
          <button class="act cmt-reply" data-cid="${esc(c.id)}" data-author="${esc(c.author || '')}">[R]</button>
          <button class="act danger cmt-del" data-cid="${esc(c.id)}">[X]</button></div>
        <div class="detail-body-html">${c.body_html || ''}</div>
        ${(byParent[c.id] || []).map(r => row(r, true)).join('')}
      </div>`;
    box.innerHTML = tops.map(c => row(c, false)).join('') || '<div class="sub">NO COMMENTS.</div>';
    box.querySelectorAll('.cmt-del').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog('[ DELETE ] COMMENT', 'DELETE THIS COMMENT?');
      if (!ok) return;
      await api('/api/confluence/comment/' + encodeURIComponent(b.dataset.cid), { method: 'DELETE' });
      toast('COMMENT DELETED', 'ok');
      loadConfComments(pid);
    }));
    box.querySelectorAll('.cmt-reply').forEach(b => b.addEventListener('click', () => {
      confReplyTo = b.dataset.cid;
      const ta = $('#pgcmt');
      ta.value = '';
      ta.placeholder = 'REPLY TO ' + (b.dataset.author || 'COMMENT') + '...';
      ta.focus();
    }));
  } catch (e) { box.innerHTML = '<div class="sub">COMMENTS UNAVAILABLE</div>'; }
}

async function postConfComment() {
  const p = state.conf.detail;
  const ta = $('#pgcmt');
  if (!p || !ta) return;
  const text = ta.value.trim();
  if (!text) return;
  const body = { body_html: textToHtml(text) };
  if (confReplyTo) body.parent_id = confReplyTo;
  await api('/api/confluence/page/' + encodeURIComponent(p.id) + '/comment',
    { method: 'POST', body });
  toast('COMMENT POSTED', 'ok'); blip(1200, .04);
  confReplyTo = null;
  ta.value = ''; ta.placeholder = 'WRITE A COMMENT...';
  loadConfComments(p.id);
}

function editConfPage() {
  const p = state.conf.detail;
  if (!p) return;
  openEditor({
    title: true, titleValue: p.title,
    html: p.body_html || '',
    onSave: async ed => {
      setStatus('WRITING TO THE MAINFRAME...');
      await api('/api/confluence/page/' + encodeURIComponent(p.id), {
        method: 'PUT', body: { title: ed.title, body_html: ed.html },
      });
      toast('PAGE SAVED', 'ok');
      await openConfPage(p.id);
    },
  });
}

async function deleteConfPage() {
  const p = state.conf.detail;
  if (!p) return;
  const ok = await confirmDialog('[ DANGER ] DELETE PAGE', 'THIS WILL BURN ' + p.title + ' TO THE GROUND.\nPROCEED?');
  if (!ok) return;
  setStatus('DELETING PAGE...');
  await api('/api/confluence/page/' + encodeURIComponent(p.id), { method: 'DELETE' });
  toast('PAGE DELETED', 'ok'); blip(300, .08);
  backToList();
}

function newConfPage() {
  const opts = state.conf.spaces.map(s =>
    `<option value="${esc(s.key)}"${s.key === state.conf.space ? ' selected' : ''}>${esc(s.key)} — ${esc(s.name)}</option>`).join('');
  openEditor({
    title: true, titleValue: '',
    fieldsHTML: `
      <label>SPACE</label>
      <select id="f-space">${opts || '<option value="">— NONE LOADED —</option>'}</select>
      <label>PARENT PAGE ID (OPTIONAL)</label>
      <input id="f-parent" type="text" placeholder="LEAVE BLANK FOR ROOT">`,
    html: '',
    onSave: async ed => {
      const space = readField('f-space'), parent = readField('f-parent');
      if (!space || !ed.title) { toast('SPACE AND TITLE REQUIRED', 'err'); throw new Error('validation'); }
      setStatus('PUBLISHING PAGE...');
      const body = { space, title: ed.title, body_html: ed.html };
      if (parent) body.parent_id = parent;
      const d = await api('/api/confluence/page', { method: 'POST', body });
      toast('PAGE CREATED: ' + d.id, 'ok'); blip(1320, .06);
      await loadConfPages();
      if (d.id) openConfPage(d.id);
    },
  });
}

/* ============ SETUP ============ */
async function renderSetup() {
  let cfg = { url: '', user: '', cloud: false };
  try { cfg = await api('/api/config'); } catch (e) { /* not configured yet */ }
  $('#detail-body').innerHTML = `
    <div class="detail-head"><h1>SETUP // MAINFRAME LINK</h1>
      <div class="sub">POINT ATLAS-86 AT YOUR JIRA / CONFLUENCE. CREDS LIVE IN ~/.atlas86.env (MODE 0600).</div></div>
    <form class="form" id="setup-form">
      <label>BASE URL</label>
      <input id="s-url" type="url" value="${esc(cfg.url || '')}" placeholder="https://yourco.atlassian.net">
      <label>USERNAME / EMAIL</label>
      <input id="s-user" type="text" value="${esc(cfg.user || '')}" autocomplete="off">
      <label>API TOKEN / PASSWORD ${cfg.has_token ? '<span class="sub">(CURRENTLY SET — LEAVE BLANK TO KEEP)</span>' : ''}</label>
      <input id="s-token" type="password" autocomplete="off" placeholder="${cfg.has_token ? '••••••••' : 'PASTE TOKEN'}">
      <label class="check"><input id="s-cloud" type="checkbox" ${cfg.cloud ? 'checked' : ''}> CLOUD (ATLASSIAN.CLOUD — TRUE) / SERVER-DC (FALSE)</label>
      <div class="btn-row"><button type="submit" class="act primary">[ SAVE CONFIG ]</button></div>
    </form>
    <div class="detail-section"><h2>DIAGNOSTICS</h2>
      <div id="diag" class="sub">—</div>
      <div class="btn-row"><button id="diag-run" class="act">[ RUN HEALTH CHECK ]</button></div>
    </div>`;
  $('#setup-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      url: $('#s-url').value.trim(),
      user: $('#s-user').value.trim(),
      cloud: $('#s-cloud').checked,
    };
    const tok = $('#s-token').value;
    if (tok) body.token = tok;
    setStatus('WRITING CONFIG...');
    try {
      const r = await api('/api/config', { method: 'POST', body });
      toast('CONFIG SAVED', 'ok'); blip(1320, .06);
      if (r.warn) toast('WARN: ' + r.warn.toUpperCase(), 'err');
      const h = await api('/api/health');
      setConn(!!h.configured); state.configured = !!h.configured;
      $('#diag').textContent = h.configured
        ? 'OK — ' + (h.url || '') + ' AS ' + (h.user || '') + (h.cloud ? ' (CLOUD)' : ' (SERVER)')
        : 'SAVED BUT STILL NOT CONFIGURED — CHECK FIELDS.';
      if (state.configured) setTimeout(() => switchTab('jira'), 600);
    } catch (e2) { /* toast shown */ }
  });
  $('#diag-run').addEventListener('click', async () => {
    try {
      const h = await api('/api/health');
      setConn(!!h.configured); state.configured = !!h.configured;
      $('#diag').textContent = JSON.stringify(h);
    } catch (e) { $('#diag').textContent = 'UNREACHABLE'; }
  });
}

/* ============ navigation helpers ============ */
function backToList() {
  const s = cur();
  s.mode = 'list'; s.detail = null;
  if (state.tab === 'jira') {
    if (state.jira.view === 'boards') { renderBoard(); }
    else if (state.jira.view === 'backlog') { renderBacklog(); }
    else { renderJiraDetailEmpty(); loadJiraIssues(); }
  }
  else { renderConfDetailEmpty(); loadConfPages(); }
}
function renderJiraDetailEmpty() {
  $('#detail-body').innerHTML = '<div class="empty">NO SIGNAL. SELECT AN ITEM OR PRESS <b>n</b>.</div>';
}
function renderConfDetailEmpty() { renderJiraDetailEmpty(); }

function currentItem() {
  const s = cur();
  if (s.mode === 'detail' && s.detail) {
    return state.tab === 'jira'
      ? { kind: 'jira', key: s.detail.key }
      : { kind: 'conf', id: s.detail.id };
  }
  const sel = s.sel >= 0 ? s.issuesOrPages() : null;
  return sel;
}
state.jira.issuesOrPages = () => state.jira.issues[state.jira.sel] && { kind: 'jira', key: state.jira.issues[state.jira.sel].key };
state.conf.issuesOrPages = () => state.conf.pages[state.conf.sel] && { kind: 'conf', id: state.conf.pages[state.conf.sel].id };

/* ============ keyboard ============ */
function typingTarget() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}
window.addEventListener('keydown', async e => {
  if (!bootDone || performance.now() - bootDismissedAt < 80) return;

  if (!$('#editor-overlay').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
    return;
  }
  if (!$('#confirm-overlay').hidden) {
    const k = e.key.toLowerCase();
    if (k === 'y') { e.preventDefault(); cfResolve && cfResolve(true); }
    if (k === 'n' || k === 'escape') { e.preventDefault(); cfResolve && cfResolve(false); }
    return;
  }
  if (!$('#help-overlay').hidden) {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); toggleHelp(false); }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!$('#editor-overlay').hidden) $('#ed-save').click();
    return;
  }

  if (e.key === 'Escape') {
    if (typingTarget()) { document.activeElement.blur(); return; }
    if (state.tab === 'setup') switchTab('jira');
    else if (state.tab !== 'home' && cur().mode === 'detail') backToList();
    return;
  }
  if (typingTarget()) return;
  if (state.tab === 'setup') {
    if (/^[0-3]$/.test(e.key)) { e.preventDefault(); switchTab(TABS[+e.key]); }
    else if (e.key === '?') { e.preventDefault(); toggleHelp(true); }
    return;
  }

  // ---- home dashboard owns the keyboard ----
  if (state.tab === 'home') {
    if (/^[0-3]$/.test(e.key)) { e.preventDefault(); switchTab(TABS[+e.key]); }
    else if (e.key === '?') { e.preventDefault(); toggleHelp(true); }
    else if (e.key === 'r') { e.preventDefault(); loadHome(); }
    return;
  }

  const s = cur();

  // ---- board mode owns the keyboard ----
  if (state.tab === 'jira' && state.jira.view === 'boards' && s.mode !== 'detail') {
    const flat = boardFlat();
    switch (e.key) {
      case '0': case '1': case '2': case '3':
        e.preventDefault(); switchTab(TABS[+e.key]); return;
      case '?': e.preventDefault(); toggleHelp(true); return;
      case '/': e.preventDefault(); const bp = $('#b-project'); if (bp) bp.focus(); return;
      case 'j': case 'ArrowDown': boardMove(1); return;
      case 'k': case 'ArrowUp': boardMove(-1); return;
      case ']': case 'l': e.preventDefault(); moveBoardCard(1); return;
      case '[': case 'h': e.preventDefault(); moveBoardCard(-1); return;
      case 'Enter': {
        const f = flat.findIndex(x => x.s === s.bsel.s && x.i === s.bsel.i);
        if (f >= 0) openJiraIssue(flat[f].card.key);
        return;
      }
      case 'r': e.preventDefault(); loadBoard(); return;
      case 'n': newJiraIssue(); return;
    }
    return;
  }

  const list = state.tab === 'jira' ? state.jira.issues : state.conf.pages;

  switch (e.key) {
    case '0': case '1': case '2': case '3':
      e.preventDefault(); switchTab(TABS[+e.key]); break;
    case '?': e.preventDefault(); toggleHelp(true); break;
    case '/': {
      e.preventDefault();
      const inp = $('#jql') || $('#csfilter') || $('#cq') || $('#ccql');
      if (inp && !inp.hidden) inp.focus();
      break;
    }
    case 'j': case 'ArrowDown': moveSel(1); break;
    case 'k': case 'ArrowUp': moveSel(-1); break;
    case 'Enter': {
      if (e.target && e.target.tagName === 'BUTTON') break;
      if (s.mode === 'detail') break; // already viewing it
      if (s.sel >= 0 && list[s.sel]) {
        if (state.tab === 'jira') openJiraIssue(list[s.sel].key);
        else openConfPage(list[s.sel].id);
      }
      break;
    }
    case 'e': {
      const it = currentItem();
      if (!it) break;
      if (it.kind === 'jira') {
        if (s.detail && s.detail.key === it.key) editJiraIssue();
        else { const key = it.key; api('/api/jira/issue/' + encodeURIComponent(key)).then(d => { state.jira.detail = d; state.jira.mode = 'detail'; editJiraIssue(); }); }
      } else {
        if (s.detail && String(s.detail.id) === String(it.id)) editConfPage();
        else { const id = it.id; api('/api/confluence/page/' + encodeURIComponent(id)).then(p => { state.conf.detail = p; state.conf.mode = 'detail'; editConfPage(); }); }
      }
      break;
    }
    case 'n':
      if (state.tab === 'jira') newJiraIssue();
      else if (state.tab === 'conf') newConfPage();
      break;
    case 'd': {
      const it = currentItem();
      if (!it) break;
      if (it.kind === 'jira') {
        const key = it.key;
        confirmDialog('[ DANGER ] DELETE ' + key, 'THIS WILL SEND ' + key + ' TO THE VOID.\nPROCEED?').then(ok => {
          if (!ok) return;
          api('/api/jira/issue/' + encodeURIComponent(key), { method: 'DELETE' })
            .then(() => { toast(key + ' DELETED', 'ok'); blip(300, .08); backToList(); });
        });
      } else {
        const id = it.id;
        confirmDialog('[ DANGER ] DELETE PAGE', 'THIS WILL BURN THE PAGE TO THE GROUND.\nPROCEED?').then(ok => {
          if (!ok) return;
          api('/api/confluence/page/' + encodeURIComponent(id), { method: 'DELETE' })
            .then(() => { toast('PAGE DELETED', 'ok'); blip(300, .08); backToList(); });
        });
      }
      break;
    }
  }
});

function boardMove(dir) {
  const j = state.jira, flat = boardFlat();
  if (!flat.length) return;
  if (j.bsel.s < 0) { j.bsel = { s: flat[0].s, i: flat[0].i }; }
  else {
    const idx = flat.findIndex(x => x.s === j.bsel.s && x.i === j.bsel.i);
    const n = Math.max(0, Math.min(flat.length - 1, idx + dir));
    j.bsel = { s: flat[n].s, i: flat[n].i };
  }
  renderBoard();
  const el = document.querySelector(`.bcard[data-s="${j.bsel.s}"][data-i="${j.bsel.i}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function moveSel(dir) {
  const s = cur();
  const list = state.tab === 'jira' ? state.jira.issues : state.conf.pages;
  if (!list.length) return;
  s.sel = Math.max(0, Math.min(list.length - 1, (s.sel < 0 ? (dir > 0 ? -1 : 0) : s.sel) + dir));
  const b = box();
  vlistEnsureVisible(b, s.sel);
  if (state.tab === 'jira') {
    renderJiraRows();
    // prefetch detail so ENTER feels instant; raw fetch = no error toasts
    const it = list[s.sel];
    if (it) fetch('/api/jira/issue/' + encodeURIComponent(it.key)).catch(() => {});
  } else {
    renderConfRows();
    const p = list[s.sel];
    if (p) fetch('/api/confluence/page/' + encodeURIComponent(p.id)).catch(() => {});
  }
}

/* ============ gutter drag ============ */
const gutter = $('#gutter');
const savedW = localStorage.getItem('a86-listw');
if (savedW) document.documentElement.style.setProperty('--list-w', savedW);
gutter.addEventListener('pointerdown', e => {
  e.preventDefault();
  const main = $('#main');
  const move = ev => {
    const w = Math.min(Math.max(ev.clientX - main.getBoundingClientRect().left, 220), innerWidth * 0.8);
    document.documentElement.style.setProperty('--list-w', w + 'px');
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    localStorage.setItem('a86-listw', getComputedStyle(document.documentElement).getPropertyValue('--list-w'));
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
});
gutter.addEventListener('dblclick', () => {
  document.documentElement.style.removeProperty('--list-w');
  localStorage.removeItem('a86-listw');
});

/* ============ go ============ */
runBoot();
