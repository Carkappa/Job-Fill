// background.js — JobFill Pro MV3 Service Worker
// Handles interactive autofill relay AND the background batch-apply queue.

// ─── Default profile ──────────────────────────────────────────────────────────
const DEFAULT_PROFILE = {
  firstName: '', lastName: '', email: '', phone: '', phoneExt: '',
  loginPassword: '',
  address: '', address2: '', city: '', state: '', zip: '', country: 'United States',
  linkedinUrl: '', websiteUrl: '', githubUrl: '',
  currentTitle: '', currentCompany: '', yearsExperience: '',
  school: '', degree: '', major: '', gpa: '', graduationYear: '',
  workAuthorization: 'Yes', expectedSalary: '', startDate: 'Immediately',
  coverLetter: '', summary: '', skills: '', languages: 'English',
  certifications: '', referralSource: 'LinkedIn',
  gender: 'Prefer not to say', ethnicity: 'Prefer not to say',
  veteranStatus: 'I am not a veteran', disabilityStatus: 'No, I do not have a disability',
  resumeData: null, resumeFilename: 'resume.pdf',
  enabled: true, autoNavigate: true, requireConfirmation: true, fillDelay: 80,
};

const JOB_PATTERNS = [
  /linkedin\.com\/jobs/, /myworkdayjobs\.com/, /workday\.com/,
  /greenhouse\.io/, /lever\.co/, /taleo\.net/, /icims\.com/,
  /indeed\.com\/(viewjob|apply)/, /apply\.indeed\.com/,
  /jobvite\.com/, /smartrecruiters\.com/,
  /oraclecloud\.com/, /apply\.oracle\.com/,
];

// Notification ID → job URL map (in-memory; lost on SW restart but that's acceptable)
const _notifUrls = {};

// ─── Queue Processor ──────────────────────────────────────────────────────────
// Processes batchQueue one job at a time in a background tab.
const QueueProcessor = {
  _currentTabId: null,
  _currentJobId: null,
  _timeoutId:    null,
  _paused:       false,

  // Add a job to the queue (deduplicates by id).
  async add(job) {
    const { batchQueue = [] } = await chrome.storage.local.get('batchQueue');
    if (batchQueue.some(j => j.id === job.id)) return { added: false, reason: 'Already queued' };
    batchQueue.push({ ...job, status: 'pending', addedAt: Date.now() });
    await chrome.storage.local.set({ batchQueue });
    this._refreshBadge(batchQueue);
    return { added: true };
  },

  // Remove a single job by id.
  async remove(jobId) {
    const { batchQueue = [] } = await chrome.storage.local.get('batchQueue');
    const next = batchQueue.filter(j => j.id !== jobId);
    await chrome.storage.local.set({ batchQueue: next });
    this._refreshBadge(next);
  },

  // Clear completed and failed entries.
  async clearFinished() {
    const { batchQueue = [] } = await chrome.storage.local.get('batchQueue');
    const next = batchQueue.filter(j => j.status === 'pending' || j.status === 'processing');
    await chrome.storage.local.set({ batchQueue: next });
    this._refreshBadge(next);
  },

  // Retry a failed job.
  async retry(jobId) {
    const { batchQueue = [] } = await chrome.storage.local.get('batchQueue');
    const job = batchQueue.find(j => j.id === jobId);
    if (job) {
      job.status = 'pending';
      delete job.completedAt;
      delete job.resultMessage;
      await chrome.storage.local.set({ batchQueue });
    }
  },

  // Start processing pending jobs (no-op if already running or paused).
  async start() {
    this._paused = false;
    await this._next();
  },

  pause() {
    this._paused = true;
    _appendLog({ time: _stamp(), level: 'info', msg: 'Queue paused by user' });
  },

  // Pick the next pending job and open it in a background tab.
  async _next() {
    if (this._paused) return;

    const { batchQueue = [] } = await chrome.storage.local.get('batchQueue');
    const job = batchQueue.find(j => j.status === 'pending');
    if (!job) {
      _log('info', 'Queue finished — no more pending jobs');
      this._refreshBadge(batchQueue);
      return;
    }

    // Mark processing
    job.status    = 'processing';
    job.startedAt = Date.now();
    await chrome.storage.local.set({ batchQueue });
    this._refreshBadge(batchQueue);
    _log('info', `Processing: "${job.title}" at ${job.company}`);

    // Open in background tab
    const tab = await chrome.tabs.create({ url: job.applyUrl, active: false });
    this._currentTabId = tab.id;
    this._currentJobId = job.id;

    // Store context so the content script can pick it up
    await chrome.storage.local.set({
      batchContext: { tabId: tab.id, jobId: job.id, autoSubmit: true },
    });

    // Safety timeout: 4 minutes per job
    clearTimeout(this._timeoutId);
    this._timeoutId = setTimeout(
      () => this._handleResult(job.id, false, 'Timed out — application took too long (4 min limit)'),
      4 * 60 * 1000
    );
  },

  // Called by content script (via JOB_RESULT message) or by timeout.
  async _handleResult(jobId, success, message = '') {
    clearTimeout(this._timeoutId);

    const { batchQueue = [] } = await chrome.storage.local.get('batchQueue');
    const job = batchQueue.find(j => j.id === jobId);

    if (job) {
      job.status        = success ? 'completed' : 'failed';
      job.completedAt   = Date.now();
      job.resultMessage = message;
    }

    // Clear batch context
    await chrome.storage.local.set({ batchQueue, batchContext: null });

    // Close background tab
    if (this._currentTabId) {
      chrome.tabs.remove(this._currentTabId).catch(() => {});
      this._currentTabId = null;
      this._currentJobId = null;
    }

    // Notification
    const title   = job?.title   || 'Job Application';
    const company = job?.company ? ` at ${job.company}` : '';

    if (success) {
      const nid = `jf-ok-${Date.now()}`;
      if (job?.applyUrl) _notifUrls[nid] = job.applyUrl;
      chrome.notifications.create(nid, {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: '✅ Application Submitted!',
        message: `${title}${company}\n${message || 'Successfully applied!'}`,
      });
      _log('success', `Applied: ${title}${company}`);
    } else {
      const nid = `jf-err-${Date.now()}`;
      if (job?.applyUrl) _notifUrls[nid] = job.applyUrl;
      chrome.notifications.create(nid, {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: '❌ Application Failed',
        message: `${title}${company}\n${message || 'Unknown error'}`,
        priority: 2,
      });
      _log('error', `Failed: ${title}${company} — ${message}`);
    }

    // Store in submission history
    if (job) {
      chrome.storage.local.get('submissions', ({ submissions = [] }) => {
        submissions.unshift({
          title: job.title, company: job.company, url: job.applyUrl,
          success, message, timestamp: Date.now(),
        });
        chrome.storage.local.set({ submissions: submissions.slice(0, 100) });
      });
    }

    this._refreshBadge(batchQueue);

    // Process next after a short cooldown
    setTimeout(() => this._next(), 3000);
  },

  _refreshBadge(queue) {
    const pending    = queue.filter(j => j.status === 'pending').length;
    const processing = queue.filter(j => j.status === 'processing').length;
    const total      = pending + processing;

    if (total > 0) {
      chrome.action.setBadgeText({ text: String(total) });
      chrome.action.setBadgeBackgroundColor({ color: processing ? '#f59e0b' : '#0a66c2' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  },
};

// ─── Install handler ──────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    const { userProfile } = await chrome.storage.local.get('userProfile');
    if (!userProfile) await chrome.storage.local.set({ userProfile: DEFAULT_PROFILE });
    console.log('[JobFill BG] Installed');
  }

  // Alarm to re-start queue processing after service worker restarts
  chrome.alarms.create('queue-heartbeat', { periodInMinutes: 1 });
});

// Heartbeat: resume queue if service worker restarted mid-processing
chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== 'queue-heartbeat') return;
  const { batchQueue = [], batchContext } = await chrome.storage.local.get(['batchQueue', 'batchContext']);

  if (batchContext?.tabId) {
    // Re-register context in case service worker restarted and lost in-memory state
    QueueProcessor._currentTabId = batchContext.tabId;
    QueueProcessor._currentJobId = batchContext.jobId;

    // Check if the tab still exists
    const tabExists = await new Promise(resolve => {
      chrome.tabs.get(batchContext.tabId, tab => {
        resolve(!chrome.runtime.lastError && !!tab);
      });
    });

    if (!tabExists) {
      // Tab gone — fail and proceed to next
      await QueueProcessor._handleResult(batchContext.jobId, false, 'Tab was closed unexpectedly');
    } else if (!QueueProcessor._timeoutId) {
      // Tab alive but SW restarted without a timeout — reinstall safety timeout
      QueueProcessor._timeoutId = setTimeout(
        () => QueueProcessor._handleResult(batchContext.jobId, false, 'Timed out after service worker restart'),
        2 * 60 * 1000
      );
    }
    return; // Don't start a new job while one is in flight
  }

  // No active batch context — restart if pending jobs are waiting
  const processing = batchQueue.filter(j => j.status === 'processing');
  const pending    = batchQueue.filter(j => j.status === 'pending');
  if (pending.length > 0 && processing.length === 0) {
    QueueProcessor.start();
  }
});

// Open the job URL when a notification is clicked
chrome.notifications.onClicked.addListener(notifId => {
  const url = _notifUrls[notifId];
  if (url) {
    chrome.tabs.create({ url, active: true });
    delete _notifUrls[notifId];
  }
  chrome.notifications.clear(notifId);
});

// ─── Tab badge management ─────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  const on = JOB_PATTERNS.some(p => p.test(tab.url));
  if (on) {
    chrome.action.setBadgeText({ text: 'ON', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#0a66c2', tabId });
  }
  // Re-check queue badge after tab updates
  chrome.storage.local.get('batchQueue', ({ batchQueue = [] }) =>
    QueueProcessor._refreshBadge(batchQueue)
  );
});

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const senderTabId = sender.tab?.id;

  switch (msg.type) {

    // ── Profile CRUD ───────────────────────────────────────────────────────
    case 'GET_PROFILE':
      chrome.storage.local.get('userProfile', d =>
        respond({ profile: d.userProfile || DEFAULT_PROFILE })
      );
      return true;

    case 'SAVE_PROFILE':
      chrome.storage.local.set({ userProfile: msg.profile }, () =>
        respond({ success: !chrome.runtime.lastError })
      );
      return true;

    // ── Interactive autofill relay (popup → active tab) ───────────────────
    case 'TRIGGER_AUTOFILL':
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (!tabs[0]?.id) return respond({ success: false, error: 'No active tab found.' });
        chrome.tabs.sendMessage(tabs[0].id, { type: 'START_AUTOFILL' }, res => {
          if (chrome.runtime.lastError)
            respond({ success: false, error: 'Content script not responding. Refresh the page and try again.' });
          else respond(res || { success: true });
        });
      });
      return true;

    // ── Batch queue management ────────────────────────────────────────────
    case 'ADD_TO_QUEUE':
      QueueProcessor.add(msg.job).then(respond);
      return true;

    case 'REMOVE_FROM_QUEUE':
      QueueProcessor.remove(msg.jobId).then(() => respond({ success: true }));
      return true;

    case 'CLEAR_FINISHED':
      QueueProcessor.clearFinished().then(() => respond({ success: true }));
      return true;

    case 'RETRY_JOB':
      QueueProcessor.retry(msg.jobId).then(() => respond({ success: true }));
      return true;

    case 'START_QUEUE':
      QueueProcessor.start().then(() => respond({ success: true }));
      return true;

    case 'PAUSE_QUEUE':
      QueueProcessor.pause();
      respond({ success: true });
      break;

    case 'GET_QUEUE':
      chrome.storage.local.get('batchQueue', ({ batchQueue = [] }) =>
        respond({ queue: batchQueue })
      );
      return true;

    // ── Batch context: content script asks "am I in batch mode?" ─────────
    case 'CHECK_BATCH_TAB':
      chrome.storage.local.get('batchContext', ({ batchContext }) => {
        if (batchContext?.tabId === senderTabId)
          respond({ isBatch: true,  config: batchContext });
        else
          respond({ isBatch: false });
      });
      return true;

    // ── Content script reports job result ─────────────────────────────────
    case 'JOB_RESULT':
      if (msg.jobId === QueueProcessor._currentJobId) {
        QueueProcessor._handleResult(msg.jobId, msg.success, msg.message);
      }
      respond({ received: true });
      break;

    // ── Logging ───────────────────────────────────────────────────────────
    case 'LOG':
      _appendLog({ time: _stamp(), level: msg.level || 'log', msg: msg.msg || '' });
      break;

    case 'GET_LOG':
      chrome.storage.local.get('activityLog', ({ activityLog = [] }) =>
        respond({ log: activityLog })
      );
      return true;

    case 'CLEAR_LOG':
      chrome.storage.local.set({ activityLog: [] }, () => respond({ success: true }));
      return true;

    // ── ATS detected badge ────────────────────────────────────────────────
    case 'ATS_DETECTED':
      if (senderTabId) {
        chrome.action.setBadgeText({ text: '●', tabId: senderTabId });
        chrome.action.setBadgeBackgroundColor({ color: '#16a34a', tabId: senderTabId });
      }
      break;

    // ── Application submitted (interactive mode) ──────────────────────────
    case 'APPLICATION_SUBMITTED': {
      const { jobInfo = {}, stats = {} } = msg;
      chrome.notifications.create(`jf-manual-${Date.now()}`, {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: '🎉 Application Submitted!',
        message: `${jobInfo.title || 'Job'}${jobInfo.company ? ` at ${jobInfo.company}` : ''} — ${stats.filled || 0} fields filled`,
      });
      chrome.storage.local.get('submissions', ({ submissions = [] }) => {
        submissions.unshift({ ...jobInfo, stats, timestamp: Date.now() });
        chrome.storage.local.set({ submissions: submissions.slice(0, 100) });
      });
      _appendLog({ time: _stamp(), level: 'success', msg: `Submitted (manual): ${jobInfo.title}` });
      break;
    }

    case 'GET_SUBMISSIONS':
      chrome.storage.local.get('submissions', ({ submissions = [] }) =>
        respond({ submissions })
      );
      return true;

    case 'GET_ACTIVE_TAB':
      chrome.tabs.query({ active: true, currentWindow: true }, tabs =>
        respond({ tab: tabs[0] || null })
      );
      return true;

    default: break;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _stamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function _log(level, msg) {
  _appendLog({ time: _stamp(), level, msg });
}

function _appendLog(entry) {
  chrome.storage.local.get('activityLog', ({ activityLog = [] }) => {
    activityLog.unshift(entry);
    chrome.storage.local.set({ activityLog: activityLog.slice(0, 150) });
  });
}
