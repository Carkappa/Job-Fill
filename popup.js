// popup.js — JobFill Pro popup controller v1.2

// ─── Helpers (defined early so they're available to all functions) ─────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function flash(id, text, ms = 3000) {
  const el = document.getElementById(id); if (!el) return;
  el.textContent = text; el.style.display = 'block';
  clearTimeout(el._t); el._t = setTimeout(() => { el.style.display = 'none'; }, ms);
}

function _fmt(ms) {
  if (ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

function _fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const TEXT_FIELDS = [
  'firstName','lastName','email','phone','phoneExt',
  'loginPassword',
  'address','address2','city','state','zip','country',
  'linkedinUrl','githubUrl','websiteUrl',
  // positions[] replaces currentTitle / currentCompany / yearsExperience
  'school','degree','major','gpa','graduationYear',
  'workAuthorization','startDate',
  'skills','languages','certifications',
  'referralSource',
  'gender','ethnicity','veteranStatus','disabilityStatus',
];
const TOGGLE_FIELDS = ['enabled','autoNavigate','requireConfirmation'];

const JOB_SITES = [
  { re: /linkedin\.com/,        name: 'LinkedIn Easy Apply' },
  { re: /myworkdayjobs\.com/,   name: 'Workday' },
  { re: /workday\.com/,         name: 'Workday' },
  { re: /greenhouse\.io/,       name: 'Greenhouse' },
  { re: /lever\.co/,            name: 'Lever' },
  { re: /taleo\.net/,           name: 'Oracle Taleo' },
  { re: /icims\.com/,           name: 'iCIMS' },
  { re: /indeed\.com/,          name: 'Indeed' },
  { re: /apply\.indeed\.com/,   name: 'Indeed' },
  { re: /jobvite\.com/,         name: 'Jobvite' },
  { re: /smartrecruiters\.com/, name: 'SmartRecruiters' },
  { re: /oraclecloud\.com/,     name: 'Oracle Cloud HCM' },
  { re: /apply\.oracle\.com/,   name: 'Oracle Cloud HCM' },
];

const LOG_ICONS    = { success:'✅', error:'❌', warn:'⚠️', info:'ℹ️', log:'·' };
const STATUS_ICONS = { pending:'🕐', processing:'⚡', completed:'✅', failed:'❌' };

let profile = {};

// ─── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${id}`));
    if (id === 'log')     loadLog();
    if (id === 'queue')   loadQueue();
    if (id === 'history') loadHistory();
  });
});

// ─── Storage helpers ───────────────────────────────────────────────────────────
const store = {
  get:  (...keys) => new Promise(r => chrome.storage.local.get(keys, r)),
  set:  (data)    => new Promise(r => chrome.storage.local.set(data, r)),
  clear:()        => new Promise(r => chrome.storage.local.clear(r)),
};
const msg = (data) => new Promise((r) => {
  chrome.runtime.sendMessage(data, res => {
    if (chrome.runtime.lastError) r(null);
    else r(res);
  });
});

// ─── Phone auto-format ─────────────────────────────────────────────────────────
function formatPhone(raw) {
  if (!raw) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10)
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1')
    return `+1 (${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  return raw;
}

const phoneInput = document.getElementById('phone');
if (phoneInput) {
  phoneInput.addEventListener('blur', () => {
    const formatted = formatPhone(phoneInput.value.trim());
    if (formatted) phoneInput.value = formatted;
  });
}

// ─── Positions (Work tab) ──────────────────────────────────────────────────────
function renderPositions(positions) {
  const container = document.getElementById('positionsContainer');
  if (!container) return;
  container.innerHTML = '';

  const list = Array.isArray(positions) && positions.length > 0
    ? positions
    : [{ title: '', company: '', startDate: '', endDate: '' }];

  list.forEach((pos, i) => {
    const card = document.createElement('div');
    card.className = 'pos-card';
    card.dataset.idx = i;
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:11px;font-weight:700;color:#0a66c2;text-transform:uppercase;letter-spacing:.5px">Position ${i + 1}</span>
        <button type="button" class="pos-remove-btn" data-idx="${i}" style="font-size:11px;color:#dc2626;background:#fee2e2;border:1px solid #fecaca;border-radius:6px;padding:2px 8px;cursor:pointer">✕ Remove</button>
      </div>
      <div class="fg"><label>Job Title</label><input type="text" class="pos-title" value="${esc(pos.title)}" placeholder="Software Engineer"></div>
      <div class="fg"><label>Company</label><input type="text" class="pos-company" value="${esc(pos.company)}" placeholder="Acme Corp"></div>
      <div class="row">
        <div class="fg"><label>Start Date</label><input type="text" class="pos-start" value="${esc(pos.startDate)}" placeholder="Jan 2020"></div>
        <div class="fg"><label>End Date</label><input type="text" class="pos-end" value="${esc(pos.endDate)}" placeholder="Present or Mar 2022"></div>
      </div>
      <div class="fg"><label>Experience / Description</label><textarea class="pos-desc" placeholder="Key responsibilities, achievements, technologies used…" style="min-height:72px;resize:vertical">${esc(pos.description || '')}</textarea></div>`;

    card.querySelector('.pos-remove-btn').addEventListener('click', () => {
      const current = getPositionsFromUI();
      if (current.length > 1) {
        current.splice(i, 1);
        profile.positions = current;
      } else {
        profile.positions = [{ title: '', company: '', startDate: '', endDate: '' }];
      }
      renderPositions(profile.positions);
    });

    container.appendChild(card);
  });
}

function getPositionsFromUI() {
  return Array.from(document.querySelectorAll('#positionsContainer .pos-card')).map(card => ({
    title:       card.querySelector('.pos-title')?.value.trim()   || '',
    company:     card.querySelector('.pos-company')?.value.trim() || '',
    startDate:   card.querySelector('.pos-start')?.value.trim()   || '',
    endDate:     card.querySelector('.pos-end')?.value.trim()     || '',
    description: card.querySelector('.pos-desc')?.value.trim()    || '',
  }));
}

const addPositionBtn = document.getElementById('addPositionBtn');
if (addPositionBtn) {
  addPositionBtn.addEventListener('click', () => {
    const current = getPositionsFromUI();
    current.push({ title: '', company: '', startDate: '', endDate: '' });
    profile.positions = current;
    renderPositions(profile.positions);
    // Scroll new card into view
    const cards = document.querySelectorAll('#positionsContainer .pos-card');
    cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ─── Profile load / save / populate ───────────────────────────────────────────
async function loadProfile() {
  const { userProfile = {} } = await store.get('userProfile');
  return userProfile;
}

async function saveProfile() {
  const p = { ...profile };

  TEXT_FIELDS.forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    if (k === 'loginPassword') {
      const v = el.value;
      if (v && v !== '••••••••') p[k] = v;
      return;
    }
    if (k === 'phone') {
      p[k] = formatPhone(el.value.trim()) || el.value.trim();
      return;
    }
    p[k] = el.value.trim();
  });

  TOGGLE_FIELDS.forEach(k => { const el = document.getElementById(k); if (el) p[k] = el.checked; });
  const d = document.getElementById('fillDelay'); if (d) p.fillDelay = parseInt(d.value, 10) || 80;

  // Save positions
  p.positions = getPositionsFromUI();

  await store.set({ userProfile: p });
  profile = p;
  return p;
}

function populateForm(p) {
  TEXT_FIELDS.forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    if (k === 'loginPassword') { el.value = p[k] ? '••••••••' : ''; return; }
    if (p[k] != null) el.value = p[k];
  });
  TOGGLE_FIELDS.forEach(k => { const el = document.getElementById(k); if (el && p[k] != null) el.checked = !!p[k]; });
  const d = document.getElementById('fillDelay'); if (d && p.fillDelay != null) d.value = p.fillDelay;

  // Render positions
  renderPositions(p.positions);
}

// ─── Footer buttons ────────────────────────────────────────────────────────────
document.getElementById('btnSave').addEventListener('click', async () => {
  await saveProfile(); flash('alertOk', '✓ Profile saved!');
});

document.getElementById('btnFill').addEventListener('click', async () => {
  await saveProfile();
  flash('alertOk', 'Starting autofill…');
  try {
    const res = await msg({ type: 'TRIGGER_AUTOFILL' });
    if (!res || res.success === false) {
      flash('alertErr', 'Autofill failed: ' + (res?.error || 'No response from content script'), 6000);
    } else {
      flash('alertOk', 'Autofill started', 3000);
    }
  } catch (e) { flash('alertErr', 'Autofill error'); }
});

// ─── Queue Tab ─────────────────────────────────────────────────────────────────
async function loadQueue() {
  const res = await msg({ type: 'GET_QUEUE' });
  const queue = res?.queue || [];
  renderQueue(queue);
  updateQueueBadge(queue);
}

function renderQueue(queue) {
  const body = document.getElementById('queueBody');
  const pending    = queue.filter(j => j.status === 'pending').length;
  const processing = queue.filter(j => j.status === 'processing').length;
  const done       = queue.filter(j => j.status === 'completed').length;
  const failed     = queue.filter(j => j.status === 'failed').length;

  const show = (id, count, label) => {
    const el = document.getElementById(id);
    if (count > 0) { el.textContent = `${count} ${label}`; el.style.display = ''; }
    else el.style.display = 'none';
  };
  show('statPending',    pending,    'pending');
  show('statProcessing', processing, 'running');
  show('statDone',       done,       'done');
  show('statFailed',     failed,     'failed');

  if (queue.length === 0) {
    body.innerHTML = `
      <div class="queue-empty">
        <div class="q-ico">⚡</div>
        <div class="q-tip">
          Go to <strong>LinkedIn Jobs</strong> and click the green<br>
          <strong>⚡ Queue Apply</strong> button next to any Easy Apply job.<br><br>
          Jobs will appear here and be processed automatically in background tabs.
        </div>
      </div>`;
    return;
  }

  body.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'job-list';

  const ordered = [
    ...queue.filter(j => j.status === 'processing'),
    ...queue.filter(j => j.status === 'pending'),
    ...queue.filter(j => j.status === 'completed'),
    ...queue.filter(j => j.status === 'failed'),
  ];

  for (const job of ordered) {
    const card = document.createElement('div');
    card.className = `job-card ${job.status}`;

    const elapsed = job.status === 'completed' && job.completedAt
      ? _fmt(job.completedAt - job.addedAt)
      : job.status === 'processing' && job.startedAt
      ? _fmt(Date.now() - job.startedAt) + ' …'
      : job.status === 'pending' && job.addedAt
      ? 'added ' + _fmtAgo(job.addedAt)
      : '';

    const spinIcon = job.status === 'processing' ? '<span class="spin">⚡</span>' : STATUS_ICONS[job.status] || '';

    card.innerHTML = `
      <div class="jc-row">
        <div class="jc-info">
          <div class="jc-title">${esc(job.title || 'Untitled Position')}</div>
          <div class="jc-company">${esc(job.company || '')}${elapsed ? ` · ${elapsed}` : ''}</div>
        </div>
        <div class="jc-status ${job.status}">${spinIcon} ${job.status}</div>
      </div>
      ${job.resultMessage ? `<div class="jc-msg ${job.status === 'failed' ? 'error' : ''}">${esc(job.resultMessage)}</div>` : ''}
      <div class="jc-actions">
        ${job.status === 'failed' ? `<button class="jc-btn retry"  data-id="${job.id}">↻ Retry</button>` : ''}
        ${(job.status === 'pending' || job.status === 'failed' || job.status === 'completed')
          ? `<button class="jc-btn remove" data-id="${job.id}">✕ Remove</button>` : ''}
        <a class="jc-btn" href="${job.applyUrl}" target="_blank" style="text-decoration:none">↗ View Job</a>
      </div>`;

    list.appendChild(card);
  }

  body.appendChild(list);

  body.querySelectorAll('.jc-btn.retry').forEach(btn => {
    btn.addEventListener('click', async () => {
      await msg({ type: 'RETRY_JOB', jobId: btn.dataset.id });
      loadQueue();
    });
  });
  body.querySelectorAll('.jc-btn.remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await msg({ type: 'REMOVE_FROM_QUEUE', jobId: btn.dataset.id });
      loadQueue();
    });
  });
}

function updateQueueBadge(queue) {
  const active = queue.filter(j => j.status === 'pending' || j.status === 'processing').length;
  const badge  = document.getElementById('queueBadge');
  if (active > 0) { badge.textContent = active; badge.style.display = 'inline'; }
  else badge.style.display = 'none';
}

document.getElementById('qStart').addEventListener('click', async () => {
  await msg({ type: 'START_QUEUE' });
  setTimeout(loadQueue, 500);
});
document.getElementById('qPause').addEventListener('click', async () => {
  await msg({ type: 'PAUSE_QUEUE' });
  flash('alertOk', '⏸ Queue paused.');
});
document.getElementById('qClear').addEventListener('click', async () => {
  await msg({ type: 'CLEAR_FINISHED' });
  loadQueue();
});

setInterval(() => {
  if (!document.hidden && document.getElementById('tab-queue').classList.contains('active')) loadQueue();
}, 3000);

// ─── History Tab ───────────────────────────────────────────────────────────────
async function loadHistory() {
  const res = await msg({ type: 'GET_SUBMISSIONS' });
  const submissions = res?.submissions || [];
  renderHistory(submissions);
}

function renderHistory(submissions) {
  const body = document.getElementById('historyBody');
  if (!body) return;

  if (submissions.length === 0) {
    body.innerHTML = `<div class="log-empty" style="padding:40px 0">
      <div style="font-size:32px;margin-bottom:10px">📋</div>
      <div>No applications recorded yet.</div>
      <div style="font-size:11px;margin-top:6px;color:#94a3b8">Applications will appear here after you apply.</div>
    </div>`;
    return;
  }

  body.innerHTML = `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:11.5px">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:6px 8px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0">Company</th>
            <th style="padding:6px 8px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0">Job Title</th>
            <th style="padding:6px 8px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0">Status</th>
            <th style="padding:6px 8px;font-weight:700;color:#64748b;border-bottom:1px solid #e2e8f0">Date</th>
          </tr>
        </thead>
        <tbody id="historyTableBody"></tbody>
      </table>
    </div>`;

  const tbody = document.getElementById('historyTableBody');
  submissions.forEach(s => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #f1f5f9';
    const date = s.timestamp ? new Date(s.timestamp).toLocaleDateString() : '—';
    const status = s.success
      ? '<span style="color:#166534;font-weight:700">✅ Applied</span>'
      : '<span style="color:#991b1b;font-weight:700">❌ Failed</span>';
    tr.innerHTML = `
      <td style="padding:6px 8px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.company || '—')}</td>
      <td style="padding:6px 8px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${s.url ? `<a href="${esc(s.url)}" target="_blank" style="color:#0a66c2;text-decoration:none">${esc(s.title || '—')}</a>` : esc(s.title || '—')}
      </td>
      <td style="padding:6px 8px">${status}</td>
      <td style="padding:6px 8px;white-space:nowrap">${date}</td>`;
    tbody.appendChild(tr);
  });
}

function exportHistoryCSV(submissions) {
  if (!submissions || submissions.length === 0) {
    flash('alertErr', 'No application history to export.'); return;
  }
  const headers = ['Company', 'Job Title', 'Status', 'Date Applied', 'URL', 'Notes'];
  const rows = submissions.map(s => [
    s.company    || '',
    s.title      || '',
    s.success    ? 'Applied' : 'Failed',
    s.timestamp  ? new Date(s.timestamp).toLocaleDateString() : '',
    s.url        || '',
    s.message    || '',
  ]);

  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `job-applications-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('exportCsvBtn')?.addEventListener('click', async () => {
  const res = await msg({ type: 'GET_SUBMISSIONS' });
  exportHistoryCSV(res?.submissions || []);
});

// ─── Settings: Import / Export / Clear ────────────────────────────────────────
document.getElementById('importFile').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = evt => {
    try {
      const imp = JSON.parse(evt.target.result);
      profile = { ...profile, ...imp };
      store.set({ userProfile: profile }).then(() => {
        populateForm(profile); flash('alertOk', `✓ Imported "${file.name}"`);
      });
    } catch (_) { flash('alertErr', 'Invalid JSON.'); }
  };
  r.readAsText(file); e.target.value = '';
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  await saveProfile();
  const exp = { ...profile }; delete exp.resumeData;
  const blob = new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'jobfill-profile.json'; a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('clearDataBtn').addEventListener('click', async () => {
  if (!confirm('Clear ALL data including profile, resume, queue, and logs?')) return;
  await store.clear(); profile = {}; populateForm({});
  document.querySelectorAll('input,textarea,select').forEach(el => {
    if (el.type === 'checkbox') el.checked = true;
    else if (el.tagName === 'SELECT') el.selectedIndex = 0;
    else el.value = '';
  });
  flash('alertOk', '✓ All data cleared.');
  loadQueue(); loadLog();
});

// ─── Log Tab ───────────────────────────────────────────────────────────────────
async function loadLog() {
  const res = await msg({ type: 'GET_LOG' });
  const log = res?.log || [];
  const list = document.getElementById('logList');
  list.innerHTML = '';
  if (log.length === 0) {
    list.innerHTML = '<div class="log-empty">No activity yet.</div>'; return;
  }
  log.slice(0, 60).forEach(e => {
    const row = document.createElement('div');
    row.className = `log-entry ${e.level}`;
    row.innerHTML = `<span class="log-icon">${LOG_ICONS[e.level]||'·'}</span><span class="log-time">${e.time}</span><span class="log-msg">${esc(e.msg)}</span>`;
    list.appendChild(row);
  });
}

document.getElementById('logClearBtn').addEventListener('click', async () => {
  await msg({ type: 'CLEAR_LOG' }); loadLog();
});

// ─── Current tab detection ─────────────────────────────────────────────────────
async function checkTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  const dot = document.getElementById('statusDot'), txt = document.getElementById('statusText');
  const btn = document.getElementById('btnFill'), box = document.getElementById('siteBox');
  if (!tab?.url) return;
  const site = JOB_SITES.find(s => s.re.test(tab.url));
  if (site) {
    dot.classList.add('on'); txt.textContent = site.name; btn.disabled = false;
    box.style.display = 'block';
    document.getElementById('siteName').textContent = site.name;
    document.getElementById('siteUrl').textContent  = tab.url;
  } else {
    dot.classList.remove('on'); txt.textContent = 'Not a job site'; btn.disabled = true; box.style.display = 'none';
  }
}

// ─── Resume upload handlers ────────────────────────────────────────────────────
async function handleResumeFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const rd = new FileReader();
  rd.onload = async (ev) => {
    try {
      const dataUrl = ev.target.result;
      profile.resumeData = dataUrl;
      profile.resumeFilename = file.name;
      await store.set({ userProfile: profile });
      showResumeInfo();
      if (typeof ResumeParser !== 'undefined' && ResumeParser.parse) {
        const parsed = await ResumeParser.parse(file);
        profile = { ...profile, ...parsed };
        await store.set({ userProfile: profile });
        populateForm(profile);
        flash('alertOk', `Parsed resume and updated profile.`);
      }
    } catch (err) {
      console.warn('Resume load error', err);
      flash('alertErr', 'Failed to read resume file');
    }
  };
  rd.readAsDataURL(file);
  e.target.value = '';
}

function showResumeInfo() {
  const info = document.getElementById('resumeInfo');
  const name = document.getElementById('resumeName');
  const meta = document.getElementById('resumeMeta');
  if (profile.resumeFilename) {
    name.textContent = profile.resumeFilename;
    meta.textContent = profile.resumeData ? 'Stored locally' : '';
    info.style.display = '';
  } else {
    info.style.display = 'none';
  }
}

async function clearResume() {
  delete profile.resumeData;
  delete profile.resumeFilename;
  await store.set({ userProfile: profile });
  showResumeInfo();
  flash('alertOk', 'Resume removed');
}

const resumeEl = document.getElementById('resumeFile');
if (resumeEl) resumeEl.addEventListener('change', handleResumeFileChange);
const drop = document.getElementById('resumeDrop');
if (drop) {
  drop.addEventListener('click', () => document.getElementById('resumeFile').click());
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => { drop.classList.remove('over'); });
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault(); drop.classList.remove('over');
    const f = ev.dataTransfer.files?.[0];
    if (f) handleResumeFileChange({ target: { files: ev.dataTransfer.files } });
  });
}
const resumeClear = document.getElementById('resumeClear');
if (resumeClear) resumeClear.addEventListener('click', clearResume);

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'ATS_DETECTED') {
    document.getElementById('statusDot')?.classList.add('on');
    const el = document.getElementById('statusText'); if (el) el.textContent = msg.ats;
  }
});

// ─── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  profile = await loadProfile();
  populateForm(profile);
  showResumeInfo();
  await checkTab();
  const res = await msg({ type: 'GET_QUEUE' });
  if (res?.queue) updateQueueBadge(res.queue);
})();
