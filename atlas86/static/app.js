'use strict';

/* ============ helpers ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const textToHtml = t => esc(t).replace(/\n/g, '<br>');

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
    setTimeout(() => switchTab(state.configured ? 'jira' : 'setup'), 0);
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
  tab: 'jira',
  jira: { jql: 'assignee = currentUser() ORDER BY updated DESC', issues: [], sel: -1, detail: null, mode: 'list' },
  conf: { spaces: [], space: '', pages: [], sel: -1, detail: null, mode: 'list', q: '' },
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
const TABS = ['jira', 'conf', 'setup'];
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.body.classList.toggle('setup-mode', tab === 'setup');
  $('#list-pane').style.display = tab === 'setup' ? 'none' : '';
  setStatus(tab === 'jira' ? 'JIRA MODULE LOADED' : tab === 'conf' ? 'CONFLUENCE MODULE LOADED' : 'SETUP / CONFIGURATION');
  if (tab === 'jira') { renderJiraListHead(); loadJiraIssues(); loadProjects(); }
  else if (tab === 'conf') { loadSpaces(); renderConfListHead(); }
  else renderSetup();
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

/* ============ JIRA ============ */
function renderJiraListHead() {
  $('#list-head').innerHTML = `
    <label>JQL QUERY</label>
    <input id="jql" type="text" value="${esc(state.jira.jql)}" spellcheck="false">
    <div class="btn-row">
      <button id="jrun" class="act primary">[ RUN QUERY ]</button>
      <button id="jnew" class="act">[ NEW ISSUE ]</button>
    </div>`;
  $('#jql').addEventListener('keydown', e => { if (e.key === 'Enter') loadJiraIssues(); });
  $('#jrun').addEventListener('click', loadJiraIssues);
  $('#jnew').addEventListener('click', newJiraIssue);
}

async function loadJiraIssues() {
  state.jira.jql = $('#jql') ? $('#jql').value.trim() : state.jira.jql;
  setStatus('FETCHING TICKETS...');
  try {
    const d = await api('/api/jira/issues?jql=' + encodeURIComponent(state.jira.jql) + '&limit=50');
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
  const box = $('#list-body');
  if (!state.jira.issues.length) {
    box.innerHTML = '<div class="empty">NO TICKETS. TRY ANOTHER JQL.</div>';
    return;
  }
  box.innerHTML = state.jira.issues.map((it, i) => `
    <div class="row${i === state.jira.sel ? ' sel' : ''}" data-i="${i}">
      <span class="key">${esc(it.key)}</span>
      <span class="title">${esc(it.summary)}</span>
      <span class="meta">${esc(it.status)} · ${esc(it.issuetype)} · ${esc(it.assignee || '—')} · ${esc((it.updated || '').slice(0, 10))}</span>
    </div>`).join('');
  box.querySelectorAll('.row').forEach(r => r.addEventListener('click', () => {
    state.jira.sel = +r.dataset.i;
    renderJiraRows();
    openJiraIssue(state.jira.issues[state.jira.sel].key);
  }));
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

function renderJiraDetail() {
  const it = state.jira.detail;
  const comments = (it.comments || []).map(c => `
    <div class="comment">
      <div class="who">${esc(c.author)} — ${esc((c.created || '').replace('T', ' ').slice(0, 16))}</div>
      <div class="detail-body-html">${c.body_html || ''}</div>
    </div>`).join('');
  const trans = (it.transitions || []).map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <h1>${esc(it.key)} — ${esc(it.summary)}</h1>
      <div class="sub">${esc(it.status)} · ${esc(it.issuetype)} · UPDATED ${esc(it.updated || '')}</div>
    </div>
    <div class="kv">
      <span class="k">ASSIGNEE</span><span class="v">${esc(it.assignee || '—')}</span>
      <span class="k">REPORTER</span><span class="v">${esc(it.reporter || '—')}</span>
    </div>
    <div class="detail-section"><h2>DESCRIPTION</h2>
      <div class="detail-body-html">${it.description_html || '<i>(empty)</i>'}</div></div>
    <div class="detail-section"><h2>COMMENTS</h2>${comments || '<div class="sub">NO COMMENTS YET.</div>'}
      <textarea id="cmt" class="comment-box" placeholder="WRITE A COMMENT..."></textarea>
      <div class="btn-row"><button id="cmt-post" class="act primary">[ POST COMMENT ]</button></div>
    </div>
    <div class="detail-section"><h2>TRANSITION STATUS</h2>
      <div class="btn-row">
        <select id="trans" ${trans ? '' : 'disabled'}><option value="">— SELECT —</option>${trans}</select>
        <button id="trans-go" class="act" ${trans ? '' : 'disabled'}>[ APPLY ]</button>
      </div>
    </div>
    <div class="btn-row">
      <button id="d-edit" class="act primary">[ E / EDIT ]</button>
      <button id="d-back" class="act">[ ESC / BACK ]</button>
      <button id="d-del" class="act danger">[ D / DELETE ]</button>
    </div>`;
  $('#d-edit').onclick = editJiraIssue;
  $('#d-back').onclick = backToList;
  $('#d-del').onclick = deleteJiraIssue;
  $('#cmt-post').onclick = postComment;
  $('#trans-go').onclick = applyTransition;
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

async function applyTransition() {
  const it = state.jira.detail, sel = $('#trans');
  if (!sel || !sel.value) return;
  await api('/api/jira/issue/' + encodeURIComponent(it.key), {
    method: 'PUT', body: { transition_id: sel.value },
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
}

/* ============ CONFLUENCE ============ */
async function loadSpaces() {
  try {
    state.conf.spaces = await api('/api/confluence/spaces');
  } catch (e) { state.conf.spaces = []; }
  renderConfListHead();
}

function renderConfListHead() {
  const opts = state.conf.spaces.map(s =>
    `<option value="${esc(s.key)}"${s.key === state.conf.space ? ' selected' : ''}>${esc(s.key)} — ${esc(s.name)}</option>`).join('');
  $('#list-head').innerHTML = `
    <label>SPACE</label>
    <select id="cspace"><option value="">— ALL / NONE —</option>${opts}</select>
    <label>SEARCH TITLE</label>
    <input id="cq" type="text" value="${esc(state.conf.q)}" placeholder="TITLE CONTAINS..." spellcheck="false">
    <div class="btn-row">
      <button id="crun" class="act primary">[ SEARCH ]</button>
      <button id="cnew" class="act">[ NEW PAGE ]</button>
    </div>`;
  $('#cspace').addEventListener('change', e => { state.conf.space = e.target.value; loadConfPages(); });
  $('#cq').addEventListener('keydown', e => { if (e.key === 'Enter') loadConfPages(); });
  $('#crun').addEventListener('click', loadConfPages);
  $('#cnew').addEventListener('click', newConfPage);
}

async function loadConfPages() {
  state.conf.space = $('#cspace') ? $('#cspace').value : state.conf.space;
  state.conf.q = $('#cq') ? $('#cq').value.trim() : state.conf.q;
  setStatus('SCANNING WIKI...');
  try {
    const d = await api('/api/confluence/pages?space=' + encodeURIComponent(state.conf.space) +
      '&q=' + encodeURIComponent(state.conf.q) + '&limit=50');
    state.conf.pages = d.pages || [];
    state.conf.sel = -1; state.conf.mode = 'list';
    renderConfRows();
    setStatus(state.conf.pages.length + ' PAGE(S) FOUND');
    blip(1200, .04);
  } catch (e) { renderConfRows(); }
}

function renderConfRows() {
  const box = $('#list-body');
  if (!state.conf.pages.length) {
    box.innerHTML = '<div class="empty">NO PAGES. PICK A SPACE OR SEARCH.</div>';
    return;
  }
  box.innerHTML = state.conf.pages.map((p, i) => `
    <div class="row${i === state.conf.sel ? ' sel' : ''}" data-i="${i}">
      <span class="key">[${esc(p.space)}]</span>
      <span class="title">${esc(p.title)}</span>
      <span class="meta">${esc((p.updated || '').slice(0, 10))}</span>
    </div>`).join('');
  box.querySelectorAll('.row').forEach(r => r.addEventListener('click', () => {
    state.conf.sel = +r.dataset.i;
    renderConfRows();
    openConfPage(state.conf.pages[state.conf.sel].id);
  }));
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
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <h1>${esc(p.title)}</h1>
      <div class="sub">SPACE ${esc(p.space)} (${esc(p.space_name || '')}) · VERSION ${esc(p.version)}</div>
    </div>
    <div class="detail-section"><h2>CONTENT</h2>
      <div class="detail-body-html">${p.body_html || '<i>(empty)</i>'}</div></div>
    <div class="btn-row">
      <button id="d-edit" class="act primary">[ E / EDIT ]</button>
      <button id="d-back" class="act">[ ESC / BACK ]</button>
      <button id="d-del" class="act danger">[ D / DELETE ]</button>
    </div>`;
  $('#d-edit').onclick = editConfPage;
  $('#d-back').onclick = backToList;
  $('#d-del').onclick = deleteConfPage;
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
      await api('/api/config', { method: 'POST', body });
      toast('CONFIG SAVED', 'ok'); blip(1320, .06);
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
  if (state.tab === 'jira') { renderJiraDetailEmpty(); loadJiraIssues(); }
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
// small adapter so currentItem reads the right list
state.jira.issuesOrPages = () => state.jira.issues[state.jira.sel] && { kind: 'jira', key: state.jira.issues[state.jira.sel].key };
state.conf.issuesOrPages = () => state.conf.pages[state.conf.sel] && { kind: 'conf', id: state.conf.pages[state.conf.sel].id };

/* ============ keyboard ============ */
function typingTarget() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}
window.addEventListener('keydown', async e => {
  if (!bootDone || performance.now() - bootDismissedAt < 80) return;

  // editor overlay owns the keyboard
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

  // escape: unfocus inputs first, then back out of detail / setup
  if (e.key === 'Escape') {
    if (typingTarget()) { document.activeElement.blur(); return; }
    if (state.tab === 'setup') switchTab('jira');
    else if (cur().mode === 'detail') backToList();
    return;
  }
  if (typingTarget()) return;
  if (state.tab === 'setup') {
    if (e.key === '1' || e.key === '2' || e.key === '3') { e.preventDefault(); switchTab(TABS[+e.key - 1]); }
    else if (e.key === '?') { e.preventDefault(); toggleHelp(true); }
    return;
  }

  const s = cur();
  const list = state.tab === 'jira' ? state.jira.issues : state.conf.pages;

  switch (e.key) {
    case '1': case '2': case '3':
      e.preventDefault(); switchTab(TABS[+e.key - 1]); break;
    case '?': e.preventDefault(); toggleHelp(true); break;
    case '/': {
      e.preventDefault();
      const inp = $('#jql') || $('#cq');
      if (inp) inp.focus();
      break;
    }
    case 'j': case 'ArrowDown': moveSel(1); break;
    case 'k': case 'ArrowUp': moveSel(-1); break;
    case 'Enter': {
      if (e.target && e.target.tagName === 'BUTTON') break; // let the button's own click fire
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

function moveSel(dir) {
  const s = cur();
  const list = state.tab === 'jira' ? state.jira.issues : state.conf.pages;
  if (!list.length) return;
  s.sel = Math.max(0, Math.min(list.length - 1, (s.sel < 0 ? (dir > 0 ? -1 : 0) : s.sel) + dir));
  if (state.tab === 'jira') renderJiraRows(); else renderConfRows();
  const el = $('#list-body .row.sel');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

/* ============ go ============ */
runBoot();
