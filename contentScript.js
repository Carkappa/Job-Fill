// contentScript.js — JobFill Pro main orchestration
// Requires utils.js globals: Logger, FIELD_PATTERNS, ATS_CONFIGS,
//   FieldMatcher, EventUtils, ResumeUtils, DOMUtils, RetryUtils, Normalizers
/* global Logger, FIELD_PATTERNS, ATS_CONFIGS, FieldMatcher, EventUtils, ResumeUtils, DOMUtils, RetryUtils, Normalizers */

// ─── ATS Detector ────────────────────────────────────────────────────────────
class ATSDetector {
  static detect() {
    for (const [key, cfg] of Object.entries(ATS_CONFIGS)) {
      try { if (cfg.detect()) { Logger.info(`ATS: ${cfg.name}`); return { key, config: cfg }; } } catch (_) {}
    }
    return null;
  }
}

// ─── Resume Uploader ──────────────────────────────────────────────────────────
class ResumeUploader {
  constructor(profile, atsKey) {
    this.profile = profile;
    this.atsKey  = atsKey;
  }

  async upload() {
    const { resumeData, resumeFilename } = this.profile;
    if (!resumeData) {
      Logger.warn('No resume stored');
      showToast('⚠️ No resume stored. Upload one in the extension popup.', 'warn', 6000);
      return 0;
    }

    let n = 0;

    // Pass 0: click any visible "Upload Resume" / "Attach" button to reveal hidden inputs
    await this._clickUploadTrigger();

    // Pass 1: ATS-specific selector
    const sel = ATS_CONFIGS[this.atsKey]?.selectors?.resumeUpload;
    if (sel) {
      for (const inp of document.querySelectorAll(sel)) {
        if (!inp._jfResume && await EventUtils.setFile(inp, resumeData, resumeFilename)) {
          inp._jfResume = true; n++;
          Logger.success(`Resume via ATS selector: ${inp.name || inp.id}`);
        }
      }
    }
    if (n) return this._done(n);

    // Pass 2: Heuristic scan (visible + hidden)
    for (const inp of ResumeUtils.getAllFileInputs()) {
      if (!inp._jfResume && ResumeUtils.isResumeInput(inp)) {
        if (await EventUtils.setFile(inp, resumeData, resumeFilename)) {
          inp._jfResume = true; n++;
          Logger.success(`Resume (heuristic): ${inp.name || inp.id || '(unnamed)'}`);
          await DOMUtils.sleep(400);
        }
      }
    }
    if (n) return this._done(n);

    // Pass 3: Platform fallbacks
    if (this.atsKey === 'workday')  n += await this._workday();
    if (this.atsKey === 'linkedin') n += await this._linkedin();

    // Pass 4: First available input
    if (n === 0) {
      const inp = ResumeUtils.getAllFileInputs().find(i => !i._jfResume);
      if (inp && await EventUtils.setFile(inp, resumeData, resumeFilename)) {
        inp._jfResume = true; n++;
        Logger.info('Resume attached (fallback to first input)');
      }
    }

    return this._done(n);
  }

  async _clickUploadTrigger() {
    // Look for visible buttons that trigger resume upload file dialogs
    const allClickable = document.querySelectorAll(
      'button, [role="button"], label[for], a[class*="upload"], a[class*="resume"]'
    );
    for (const el of allClickable) {
      const t = (el.textContent || el.getAttribute('aria-label') || el.title || '').toLowerCase().trim();
      if (/(?:upload|attach|choose|browse|select)\s*(?:resume|cv|file|document)/i.test(t) ||
          /(?:resume|cv)\s*(?:upload|attach|choose|browse)/i.test(t)) {
        Logger.info(`Clicking upload trigger: "${t.slice(0, 40)}"`);
        EventUtils.simulateClick(el);
        await DOMUtils.sleep(600);
        break;
      }
    }
  }

  _done(n) {
    if (n > 0) showToast(`📄 Resume "${this.profile.resumeFilename}" attached ✓`, 'success', 3000);
    else Logger.warn('No resume input found on this step');
    return n;
  }

  async _workday() {
    const ctrs = document.querySelectorAll(
      '[data-automation-id*="resume"],[data-automation-id*="Resume"],' +
      '[data-automation-id*="cv"],[data-automation-id*="document"],' +
      '[data-automation-id*="attachment"],[data-automation-id*="file-upload"]'
    );
    for (const ctr of ctrs) {
      for (const inp of [ctr.querySelector('input[type="file"]'), ctr.parentElement?.querySelector('input[type="file"]')]) {
        if (inp && !inp._jfResume && await EventUtils.setFile(inp, this.profile.resumeData, this.profile.resumeFilename)) {
          inp._jfResume = true; return 1;
        }
      }
    }
    return 0;
  }

  async _linkedin() {
    for (const sel of [
      '.jobs-document-upload input[type="file"]',
      '.jobs-resume-picker__upload-input',
      '.jobs-document-upload-redesign-card input[type="file"]',
      'input[id*="resume"]','input[name*="resume"]',
    ]) {
      const inp = document.querySelector(sel);
      if (inp && !inp._jfResume && await EventUtils.setFile(inp, this.profile.resumeData, this.profile.resumeFilename)) {
        inp._jfResume = true; return 1;
      }
    }
    return 0;
  }
}

// ─── Form Filler ─────────────────────────────────────────────────────────────
class FormFiller {
  constructor(profile, jobInfo = {}) {
    this.profile      = profile;
    this.jobInfo      = jobInfo;
    this.filledCount  = 0;
    this.skippedCount = 0;
    this.log          = [];
  }

  async fillAllFields(root = document) {
    const fields = DOMUtils.getInteractableFields(root);
    Logger.info(`Scanning ${fields.length} fields`);

    for (const f of fields) {
      if (f._jfDone) continue;
      const match = FieldMatcher.matchElement(f);
      if (!match) { this.skippedCount++; continue; }

      const { fieldType } = match;
      const pat = FIELD_PATTERNS[fieldType];
      if (!pat) continue;

      // ── Auto-agree to terms checkboxes ────────────────────────────────────
      if (fieldType === 'agreeToTerms') {
        const type = (f.getAttribute('type') || '').toLowerCase();
        if (type === 'checkbox' && !f.checked) {
          f.checked = true;
          f.dispatchEvent(new Event('change', { bubbles: true }));
          f._jfDone = true;
          this.filledCount++;
          Logger.success('[agreeToTerms] auto-checked');
        }
        continue;
      }

      // ── Visa sponsorship (reverse of workAuthorization) ───────────────────
      if (fieldType === 'sponsorship') {
        // "Do you require sponsorship?" → Yes authorized = No sponsorship needed
        const sponsorValue = (this.profile.workAuthorization === 'Yes' || this.profile.workAuthorization === 'true') ? 'No' : 'Yes';
        const ok = await this._fill(f, 'workAuth', sponsorValue);
        if (ok) { f._jfDone = true; f.classList?.add('jobfill-filled'); this.filledCount++; }
        await RetryUtils.sleep(this.profile.fillDelay ?? 80);
        continue;
      }

      let value = this.profile[pat.profileKey];
      if (fieldType === 'fullName' && !value)
        value = [this.profile.firstName, this.profile.lastName].filter(Boolean).join(' ');
      if (fieldType === 'phone' && value) value = Normalizers.phone(value);
      if (fieldType === 'coverLetter' && value) value = Normalizers.coverLetter(value, this.jobInfo?.title, this.jobInfo?.company);

      // ── EEO fields: fall back to "prefer not to say" if profile is empty ─
      if ((fieldType === 'veteran' || fieldType === 'disability' || fieldType === 'gender' || fieldType === 'ethnicity') && !value) {
        value = 'Prefer not to say';
      }

      // ── Referral source: try multiple fallbacks ───────────────────────────
      if (fieldType === 'referral' && !value) value = 'LinkedIn';

      if (value === undefined || value === null || value === '') { this.skippedCount++; continue; }

      const ok = await this._fill(f, fieldType, String(value));
      if (ok) {
        f._jfDone = true;
        f.classList?.add('jobfill-filled');
        this.filledCount++;
        this.log.push({ fieldType, value: String(value).slice(0, 60) });
        Logger.success(`[${fieldType}] "${String(value).slice(0, 50)}"`);
        setTimeout(() => f.classList?.replace('jobfill-filled', 'jobfill-filled-done'), 4000);
      }
      await RetryUtils.sleep(this.profile.fillDelay ?? 80);
    }
  }

  async _fill(el, fieldType, value) {
    try {
      const tag  = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || 'text').toLowerCase();

      if (tag === 'select') {
        // For referral fields, try multiple common values if first doesn't match
        if (fieldType === 'referral') return this._fillReferral(el);
        return EventUtils.selectOption(el, value);
      }
      if (type === 'radio') return EventUtils.selectRadio(el.name, value);
      if (type === 'file')  return false;
      if (type === 'checkbox') {
        const should = ['yes','true','1','checked'].includes(value.toLowerCase());
        if (el.checked !== should) { el.checked = should; el.dispatchEvent(new Event('change', { bubbles: true })); }
        return true;
      }
      if (type === 'date') return EventUtils.setDate(el, value);
      if (type === 'password') {
        // Fill password without clearing first to avoid triggering validation
        return EventUtils.setValue(el, value);
      }
      if (tag === 'input' || tag === 'textarea') {
        EventUtils.setValue(el, ''); await RetryUtils.sleep(25); return EventUtils.setValue(el, value);
      }
      if (el.isContentEditable) {
        el.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, value); return true;
      }
    } catch (e) { Logger.error(`_fill[${fieldType}]`, e); }
    return false;
  }

  // Try a prioritised list of referral source values against the select options
  _fillReferral(sel) {
    const candidates = [
      this.profile.referralSource,
      'LinkedIn','Job Board','Job board','Social Media','Social media',
      'Online Job Board','Indeed','ZipRecruiter','Glassdoor','Monster',
      'Career Website','Career website','Company Website','Internet','Online','Other',
    ].filter(Boolean);
    for (const c of candidates) {
      if (EventUtils.selectOption(sel, c)) return true;
    }
    return false;
  }
}

// ─── Workday Custom Dropdowns ─────────────────────────────────────────────────
class WorkdayDropdowns {
  static async fill(profile) {
    const ctrs = document.querySelectorAll(
      '[data-automation-id*="select"]:not([data-jf-dd]):not(input):not(option),' +
      '[data-automation-id*="dropdown"]:not([data-jf-dd])'
    );
    for (const ctr of ctrs) {
      const match = FieldMatcher.matchElement(ctr);
      if (!match) continue;
      const value = profile[FIELD_PATTERNS[match.fieldType]?.profileKey];
      if (!value) continue;
      ctr.setAttribute('data-jf-dd', '1');
      EventUtils.simulateClick(ctr);
      await RetryUtils.sleep(500);
      const options = document.querySelectorAll('[role="option"],[data-automation-id*="option"]');
      const norm = String(value).toLowerCase().trim();
      for (const opt of options) {
        const t = opt.textContent.toLowerCase().trim();
        if (t === norm || t.includes(norm) || norm.includes(t)) { EventUtils.simulateClick(opt); break; }
      }
      await RetryUtils.sleep(200);
    }
  }
}

// ─── Step Navigator ───────────────────────────────────────────────────────────
class StepNavigator {
  constructor(atsConfig) { this.config = atsConfig; this.step = 0; }

  async clickNext() {
    const btn = this._btn('next'); if (!btn) return false;
    Logger.info(`Next → "${(btn.textContent || btn.value || '').trim()}"`);
    const prevLen = document.body.innerHTML.length, prevUrl = location.href;
    EventUtils.simulateClick(btn);
    await this._await(prevUrl, prevLen);
    this.step++; return true;
  }

  isAtFinalStep() { return !!(this._btn('submit') || this._isReview()); }
  _isReview() {
    const t = document.body.textContent.toLowerCase();
    return t.includes('review your application') || t.includes('review and submit') ||
           !!document.querySelector('[class*="review"][class*="step"]');
  }
  findSubmitBtn() { return this._btn('submit'); }

  _btn(type) {
    const kwMap = {
      next:   ['next','continue','save and continue','save & continue','proceed','next step'],
      submit: ['submit application','submit','apply now','complete application','finish'],
    };
    const cfgSel = this.config?.selectors?.[`${type}Btn`];
    if (cfgSel) { const el = document.querySelector(cfgSel); if (el && !el.disabled) return el; }
    return DOMUtils.findNavButton(kwMap[type] || []);
  }

  async _await(prevUrl, prevLen, ms = 7000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await RetryUtils.sleep(350);
      if (location.href !== prevUrl || Math.abs(document.body.innerHTML.length - prevLen) > 400) return;
    }
  }
}

// ─── Confirmation Dialog (shadow DOM) ────────────────────────────────────────
class ConfirmationUI {
  show({ jobInfo = {}, stats = {} } = {}) {
    return new Promise(resolve => {
      const host = document.createElement('div');
      host.style.cssText = 'all:unset;position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;';
      document.body.appendChild(host);
      const sh = host.attachShadow({ mode: 'open' });
      sh.innerHTML = `
        <style>
          *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
          .ov{position:fixed;inset:0;background:rgba(0,0,0,.68);display:flex;align-items:center;justify-content:center;animation:fi .2s ease}
          @keyframes fi{from{opacity:0}to{opacity:1}}
          .card{background:#fff;border-radius:18px;padding:30px 32px;max-width:460px;width:92%;box-shadow:0 28px 80px rgba(0,0,0,.38);animation:ri .22s ease}
          @keyframes ri{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}
          .ico{text-align:center;font-size:44px;margin-bottom:12px}
          h2{text-align:center;font-size:20px;font-weight:800;color:#111;margin-bottom:6px}
          .sub{text-align:center;color:#666;font-size:13px;margin-bottom:16px;line-height:1.6}
          .job{background:#eff6ff;border-radius:10px;padding:11px 15px;margin-bottom:13px}
          .jt{font-weight:700;font-size:15px;color:#1d4ed8}.jc{font-size:12px;color:#555;margin-top:3px}
          .stats{background:#f0fdf4;border-radius:8px;padding:8px 14px;margin-bottom:13px;font-size:13px;color:#166534}
          .k{background:#16a34a;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700}
          .k2{background:#d97706}
          .warn{background:#fffbeb;border-left:3px solid #f59e0b;padding:10px 14px;border-radius:6px;font-size:12px;color:#78350f;margin-bottom:20px;line-height:1.5}
          .btns{display:flex;gap:12px}
          .cancel{flex:1;padding:12px;background:#f3f4f6;color:#374151;border:1.5px solid #d1d5db;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;transition:.15s}
          .cancel:hover{background:#e5e7eb}
          .go{flex:2;padding:12px;background:linear-gradient(135deg,#0a66c2,#0041a8);color:#fff;border:none;border-radius:10px;cursor:pointer;font-size:14px;font-weight:700;transition:.15s;box-shadow:0 4px 16px rgba(10,102,194,.4)}
          .go:hover{background:linear-gradient(135deg,#004182,#003068)}
        </style>
        <div class="ov" id="bd">
          <div class="card">
            <div class="ico">📋</div><h2>Ready to Submit?</h2>
            <p class="sub">JobFill Pro has filled your application.<br>Review all answers carefully before submitting.</p>
            ${jobInfo.title ? `<div class="job"><div class="jt">${jobInfo.title}</div>${jobInfo.company ? `<div class="jc">at ${jobInfo.company}</div>` : ''}</div>` : ''}
            ${stats.filled !== undefined ? `<div class="stats"><span class="k">${stats.filled}</span> fields filled &nbsp;<span class="k k2">${stats.skipped}</span> skipped</div>` : ''}
            <div class="warn">⚠️ Submission is permanent. Scroll through the form and verify every answer is correct.</div>
            <div class="btns">
              <button class="cancel" id="c">← Review First</button>
              <button class="go" id="s">Submit Application ✓</button>
            </div>
          </div>
        </div>`;
      const rm = () => host.remove();
      sh.getElementById('s').onclick = () => { rm(); resolve(true); };
      sh.getElementById('c').onclick = () => { rm(); resolve(false); };
      sh.getElementById('bd').onclick = e => { if (e.target.id === 'bd') { rm(); resolve(false); } };
    });
  }
}

// ─── Toast Notifications ──────────────────────────────────────────────────────
function showToast(msg, type = 'info', ms = 4000) {
  document.querySelector('.jf-toast')?.remove();
  const pal = { success: '#16a34a', error: '#dc2626', info: '#2563eb', warn: '#d97706' };
  const el  = document.createElement('div');
  el.className = 'jf-toast';
  el.style.cssText = `all:unset;position:fixed;bottom:26px;right:26px;background:#1e2130;color:#fff;padding:12px 18px;border-radius:12px;font-size:13px;font-family:-apple-system,sans-serif;line-height:1.45;box-shadow:0 8px 30px rgba(0,0,0,.35);z-index:2147483646;border-left:4px solid ${pal[type]||pal.info};max-width:340px;`;
  el.textContent = msg;
  if (!document.getElementById('jf-style')) {
    const s = document.createElement('style'); s.id = 'jf-style';
    s.textContent = '@keyframes jfIn{from{transform:translateX(115px);opacity:0}to{transform:none;opacity:1}}';
    document.head.appendChild(s);
  }
  el.style.animation = 'jfIn .3s ease';
  document.body.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, ms);
}

// ─── LinkedIn Job Queue Injector ──────────────────────────────────────────────
// Injects "⚡ Queue Apply" buttons next to Easy Apply buttons on LinkedIn listings.
class LinkedInQueueInjector {
  constructor() { this._injected = new Set(); }

  start() {
    this._scan();
    // Re-scan when LinkedIn lazy-loads more job cards
    new MutationObserver(() => this._scan())
      .observe(document.body, { childList: true, subtree: true });
  }

  _scan() {
    const easyApplyBtns = document.querySelectorAll(
      'button[aria-label*="Easy Apply" i]:not([data-jf-qi]), ' +
      '.jobs-apply-button--top-card:not([data-jf-qi])'
    );
    for (const btn of easyApplyBtns) this._inject(btn);
  }

  _inject(eaBtn) {
    const jobId = this._jobId(eaBtn);
    if (!jobId || this._injected.has(jobId)) return;
    this._injected.add(jobId);
    eaBtn.setAttribute('data-jf-qi', '1');

    const card    = eaBtn.closest('[data-job-id],[data-occludable-job-id],.job-card-container,.jobs-unified-top-card');
    const title   = this._text(card, '.job-card-list__title,.jobs-unified-top-card__job-title,[class*="jobTitle"],[class*="job-title"]') || 'Position';
    const company = this._text(card, '.job-card-container__company-name,.jobs-unified-top-card__company-name,[class*="companyName"],[class*="company-name"]') || '';
    const applyUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;

    const qBtn = document.createElement('button');
    qBtn.textContent = '⚡ Queue Apply';
    qBtn.title = `Add to JobFill queue: ${title}`;
    qBtn.style.cssText = [
      'margin-left:8px', 'padding:6px 14px', 'background:#00875a', 'color:#fff',
      'border:none', 'border-radius:20px', 'font-size:13px', 'cursor:pointer',
      'font-weight:700', 'font-family:inherit', 'transition:background .15s',
      'vertical-align:middle', 'white-space:nowrap',
    ].join(';');

    qBtn.addEventListener('mouseenter', () => {
      qBtn.style.background = qBtn._queued ? '#b91c1c' : '#006644';
    });
    qBtn.addEventListener('mouseleave', () => {
      qBtn.style.background = qBtn._queued ? '#dc2626' : '#00875a';
    });

    qBtn.addEventListener('click', async e => {
      e.stopPropagation(); e.preventDefault();

      if (qBtn._queued) {
        // Toggle off — remove from queue
        await chrome.runtime.sendMessage({ type: 'REMOVE_FROM_QUEUE', jobId });
        qBtn._queued = false;
        qBtn.textContent = '⚡ Queue Apply';
        qBtn.style.background = '#00875a';
        qBtn.title = `Add to JobFill queue: ${title}`;
        showToast(`"${title}" removed from queue`, 'info', 2000);
        return;
      }

      const job = { id: jobId, title, company, applyUrl, isEasyApply: true };
      const res = await chrome.runtime.sendMessage({ type: 'ADD_TO_QUEUE', job });

      if (res?.added || res?.reason === 'Already queued') {
        qBtn._queued = true;
        qBtn.textContent  = res?.added ? '✅ Queued · ✕' : '✕ Remove';
        qBtn.style.background = res?.added ? '#15803d' : '#dc2626';
        qBtn.title = 'Click to remove from queue';
        if (res?.added) showToast(`"${title}" added to queue`, 'success', 2500);
        else showToast(`"${title}" is already queued — click ✕ to remove`, 'info', 3000);
      }
    });

    // Insert right after the Easy Apply button
    eaBtn.insertAdjacentElement('afterend', qBtn);
  }

  _jobId(btn) {
    const card = btn.closest('[data-job-id],[data-occludable-job-id]');
    if (card) return card.getAttribute('data-job-id') || card.getAttribute('data-occludable-job-id');
    const m = location.pathname.match(/\/jobs\/view\/(\d+)/);
    return m?.[1] || null;
  }

  _text(root, sel) {
    return root?.querySelector(sel)?.textContent?.trim() || null;
  }
}

// ─── Login / Account Creation Filler ─────────────────────────────────────────
class LoginFiller {
  // Returns true if the page appears to be a login or sign-up form
  static isPresent() {
    const hasPwd = !!document.querySelector('input[type="password"]');
    if (!hasPwd) return false;
    const pageText = document.body.textContent.toLowerCase();
    return /sign in|log in|login|create account|sign up|register|new account|join us/.test(pageText);
  }

  static async fill(profile) {
    if (!profile.email) return false;
    const pwdInput = document.querySelector('input[type="password"]');
    if (!pwdInput) return false;

    // Find email / username field (near the password input)
    const form = pwdInput.closest('form') || document.body;
    const emailInput =
      form.querySelector('input[type="email"]') ||
      form.querySelector('input[autocomplete*="email"]') ||
      form.querySelector('input[name*="email" i], input[id*="email" i]') ||
      form.querySelector('input[name*="user" i], input[id*="user" i]') ||
      form.querySelector('input[type="text"]');

    if (emailInput && emailInput !== pwdInput) {
      EventUtils.setValue(emailInput, profile.email);
      await RetryUtils.sleep(200);
      Logger.success(`[login] email filled: ${profile.email}`);
    }

    if (profile.loginPassword) {
      EventUtils.setValue(pwdInput, profile.loginPassword);
      await RetryUtils.sleep(200);
      Logger.success('[login] password filled');
    }

    // Auto-check "I agree to terms" checkboxes on the same form
    const checkboxes = form.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const lbl = FieldMatcher.getLabelText(cb).toLowerCase();
      if (/agree|accept|terms|condition|privacy|consent|certify|acknowledge/.test(lbl)) {
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          Logger.success(`[login] auto-checked: "${lbl.slice(0, 60)}"`);
        }
      }
    }

    // Auto-click Create Account / Sign Up submit button if present
    const submitBtn = DOMUtils.findNavButton([
      'create account','sign up','register','create my account',
      'join','get started','continue','next',
    ]);
    if (submitBtn) {
      Logger.info(`[login] clicking: "${(submitBtn.textContent || '').trim()}"`);
      await RetryUtils.sleep(400);
      EventUtils.simulateClick(submitBtn);
    }

    return true;
  }
}

// ─── Main Autofill Controller ─────────────────────────────────────────────────
class AutofillController {
  constructor() {
    this.profile   = null;
    this.ats       = null;
    this.isRunning = false;
    this._lastUrl  = location.href;
  }

  async init() {
    // Always ensure message listener is registered so the popup can trigger autofill even if
    // the profile appears incomplete. _setupMessages is idempotent (guarded) to avoid duplicate listeners.
    this._setupMessages();

    this.profile = await this._load();
    if (this.profile?.enabled === false) return;
    if (!this.profile?.firstName) { Logger.warn('Profile empty — open popup to configure'); /* still continue so START_AUTOFILL can run */ }

    this.ats = ATSDetector.detect();

    // Always inject queue buttons on LinkedIn listings (even without a full ATS match)
    if (location.hostname.includes('linkedin.com')) {
      new LinkedInQueueInjector().start();
    }

    // Check if this tab is being processed by the batch queue
    const batchRes = await chrome.runtime.sendMessage({ type: 'CHECK_BATCH_TAB' }).catch(() => null);
    if (batchRes?.isBatch) {
      Logger.info(`Batch mode active for job: ${batchRes.config.jobId}`);
      setTimeout(() => this._batchRun(batchRes.config), 2000);
      return;
    }

    // Interactive mode
    this._setupObservers();
    // this._setupMessages(); // already called at top
    
    // Auto-fill login/create-account forms when credentials are available
    if (LoginFiller.isPresent() && this.profile.loginPassword) {
      Logger.info('Login form detected — filling credentials');
      await LoginFiller.fill(this.profile);
    }

    if (this.ats) {
      showToast(`JobFill Pro ready on ${this.ats.config.name} — click the icon to fill`, 'info', 6000);
      chrome.runtime.sendMessage({ type: 'ATS_DETECTED', ats: this.ats.config.name, url: location.href }).catch(() => {});
    }
  }

  // ── Batch auto-run (no user interaction, auto-submit) ─────────────────────
  async _batchRun(config) {
    Logger.info('Batch run starting…');

    // Check if already applied before attempting to open the modal
    const alreadyAppliedSel = ATS_CONFIGS[this.ats?.key]?.alreadyApplied;
    if (alreadyAppliedSel && document.querySelector(alreadyAppliedSel)) {
      this._reportResult(config.jobId, false, 'Already applied to this position');
      return;
    }

    // For LinkedIn, we must click Easy Apply first to open the modal
    if (this.ats?.key === 'linkedin' || location.hostname.includes('linkedin.com')) {
      const opened = await this._openLinkedInModal();
      if (!opened) {
        this._reportResult(config.jobId, false, 'Could not find or open Easy Apply button');
        return;
      }
    }

    await this.run({ batchMode: true, jobId: config.jobId });
  }

  async _openLinkedInModal() {
    Logger.info('Looking for Easy Apply button…');
    const btn = await DOMUtils.waitForElement(
      'button[aria-label*="Easy Apply" i], .jobs-apply-button--top-card, .jobs-s-apply button',
      8000
    ).catch(() => null);

    if (!btn) {
      Logger.warn('Easy Apply button not found');
      return false;
    }

    EventUtils.simulateClick(btn);
    Logger.info('Clicked Easy Apply — waiting for modal…');

    const modal = await DOMUtils.waitForElement(
      '.jobs-easy-apply-modal, .jobs-easy-apply-content, [data-test-modal]',
      6000
    ).catch(() => null);

    if (!modal) { Logger.warn('Modal did not open'); return false; }
    Logger.success('Modal opened');
    await RetryUtils.sleep(800);
    return true;
  }

  // ── Interactive run (called by popup button or START_AUTOFILL message) ────
  async run({ batchMode = false, jobId = null } = {}) {
    if (this.isRunning) { showToast('Already running…', 'warn'); return; }

    this.profile   = await this._load();
    if (!this.profile) {
      this._reportResult(jobId, false, 'Profile not configured');
      return;
    }

    this.ats       = ATSDetector.detect();
    this.isRunning = true;

    if (!batchMode) showToast('JobFill started…', 'info', 2000);
    Logger.info(`══ Run Started (${batchMode ? 'batch' : 'interactive'}) ══`);

    const filler  = new FormFiller(this.profile, this._jobInfo());
    const nav     = new StepNavigator(this.ats?.config);
    const confirm = new ConfirmationUI();

    try {
      for (let step = 0; step < 20; step++) {
        Logger.info(`── Step ${step + 1} ──`);
        await filler.fillAllFields();
        await new ResumeUploader(this.profile, this.ats?.key).upload();
        if (this.ats?.key === 'workday') await WorkdayDropdowns.fill(this.profile);
        this._autoAgreeTerms(); // sweep for any unchecked agree/accept checkboxes
        await RetryUtils.sleep(600);

        if (nav.isAtFinalStep()) {
          Logger.info('Final step');

          if (!batchMode) {
            showToast(`✅ ${filler.filledCount} fields filled — confirming…`, 'success', 3000);
            await RetryUtils.sleep(800);
          }

          let confirmed = true;

          // Batch mode: always auto-submit (no dialog)
          // Interactive mode: show dialog if requireConfirmation is on
          if (!batchMode && this.profile.requireConfirmation !== false) {
            confirmed = await confirm.show({
              jobInfo: this._jobInfo(),
              stats: { filled: filler.filledCount, skipped: filler.skippedCount },
            });
          }

          if (confirmed) {
            const btn = nav.findSubmitBtn();
            if (btn) {
              EventUtils.simulateClick(btn);
              Logger.success('Submitted');

              if (batchMode) {
                // Wait briefly for submission to be processed
                await RetryUtils.sleep(3000);
                const err = this._detectErrors();
                if (err) this._reportResult(jobId, false, `Submit error: ${err}`);
                else     this._reportResult(jobId, true, `Applied: ${filler.filledCount} fields filled`);
              } else {
                showToast('🎉 Application submitted! Good luck!', 'success', 7000);
                chrome.runtime.sendMessage({
                  type: 'APPLICATION_SUBMITTED', jobInfo: this._jobInfo(),
                  stats: { filled: filler.filledCount, skipped: filler.skippedCount },
                }).catch(() => {});
              }
            } else {
              const msg = 'Submit button not found';
              if (batchMode) this._reportResult(jobId, false, msg);
              else showToast(`⚠️ ${msg} — please submit manually.`, 'warn', 8000);
            }
          } else {
            if (batchMode) this._reportResult(jobId, false, 'Submission cancelled by system');
            else showToast('Submission cancelled — review and submit when ready.', 'info', 5000);
          }
          break;
        }

        const advanced = await nav.clickNext();
        if (!advanced) {
          const msg = `No more steps found (${filler.filledCount} fields filled)`;
          if (batchMode) {
            // Check if there's a submit button we might have missed
            const sub = DOMUtils.findSubmitButton();
            if (sub) {
              EventUtils.simulateClick(sub);
              await RetryUtils.sleep(2000);
              this._reportResult(jobId, true, `Applied via fallback submit: ${filler.filledCount} fields`);
            } else {
              this._reportResult(jobId, false, 'Could not find next step or submit button');
            }
          } else {
            showToast(`Form filled. ${msg}.`, 'success');
          }
          break;
        }

        await RetryUtils.sleep(2000);
      }
    } catch (e) {
      Logger.error('Run error:', e);
      if (batchMode) this._reportResult(jobId, false, `Runtime error: ${e.message}`);
      else showToast('An error occurred. Open DevTools console for details.', 'error');
    } finally {
      this.isRunning = false;
      Logger.info(`══ Done — filled:${filler.filledCount} skipped:${filler.skippedCount} ══`);
    }
  }

  // Detect inline validation errors that indicate submission failed
  _detectErrors() {
    const errorSels = [
      '.artdeco-inline-feedback--error',
      '.jobs-easy-apply-form__error',
      '[class*="error-message"]',
      '[role="alert"]',
      '.form-error',
      '[class*="validationError"]',
    ];
    for (const sel of errorSels) {
      const el = document.querySelector(sel);
      if (el) { const t = el.textContent.trim(); if (t.length > 2) return t.slice(0, 120); }
    }
    return null;
  }

  // Scan the page for unchecked "I agree / accept terms" checkboxes and check them
  _autoAgreeTerms() {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]:not([disabled]):not([data-jf-agreed])');
    for (const cb of checkboxes) {
      const lbl = FieldMatcher.getLabelText(cb).toLowerCase();
      const isTerms = /i agree|i accept|agree to the|accept the|terms of service|terms and conditions|privacy policy|certify that|by checking|i confirm|i have read|acknowledge/.test(lbl);
      const isMarketing = /marketing|promotional|newsletter|updates|offers|notify me/.test(lbl);
      if (isTerms && !isMarketing && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.setAttribute('data-jf-agreed', '1');
        Logger.success(`[autoAgree] checked: "${lbl.slice(0, 70)}"`);
      }
    }
  }

  _reportResult(jobId, success, message) {
    if (!jobId) return;
    Logger.info(`Reporting result: ${success ? 'SUCCESS' : 'FAIL'} — ${message}`);
    chrome.runtime.sendMessage({ type: 'JOB_RESULT', jobId, success, message }).catch(() => {});
  }

  _load() {
    return new Promise(r => chrome.storage.local.get('userProfile', d => r(d.userProfile || null)));
  }

  _setupObservers() {
    // Disconnect existing observers to prevent accumulation on SPA re-init
    this._spaObserver?.disconnect();
    this._fieldObserver?.disconnect();

    this._spaObserver = new MutationObserver(() => {
      if (location.href !== this._lastUrl) {
        this._lastUrl = location.href;
        clearTimeout(this._navT);
        this._navT = setTimeout(() => this.init(), 1300);
      }
    });
    this._spaObserver.observe(document, { subtree: true, childList: true });

    this._fieldObserver = new MutationObserver(muts => {
      if (!this.isRunning) return;
      const added = muts.some(m =>
        [...m.addedNodes].some(n => n.nodeType === 1 &&
          (n.matches?.('input,select,textarea') || n.querySelector?.('input,select,textarea')))
      );
      if (added) {
        clearTimeout(this._mutT);
        this._mutT = setTimeout(async () => {
          await new FormFiller(this.profile, this._jobInfo()).fillAllFields();
          await new ResumeUploader(this.profile, this.ats?.key).upload();
        }, 750);
      }
    });
    this._fieldObserver.observe(document.body, { childList: true, subtree: true });
  }

  _setupMessages() {
    if (this._messagesSetup) return; // idempotent
    this._messagesSetup = true;
    chrome.runtime.onMessage.addListener((msg, _, respond) => {
      if (msg.type === 'START_AUTOFILL') {
        // Ensure latest profile is loaded before running
        this._load().then(profile => {
          this.profile = profile || this.profile;
          this.run().then(() => respond({ success: true })).catch(e => respond({ success: false, error: e.message }));
        }).catch(e => {
          Logger.error('Failed to load profile before START_AUTOFILL', e);
          respond({ success: false, error: e.message });
        });
        return true;
      }
      if (msg.type === 'GET_STATUS') {
        respond({ ats: this.ats?.config.name, running: this.isRunning }); return true;
      }
    });
  }

  _jobInfo() {
    const t = document.querySelector('h1,.jobs-unified-top-card__job-title,[class*="jobTitle"],[data-testid*="job-title"]');
    const c = document.querySelector('.jobs-unified-top-card__company-name,[class*="company-name"],[class*="companyName"]');
    return { title: t?.textContent?.trim(), company: c?.textContent?.trim(), url: location.href };
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const _jfc = new AutofillController();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => _jfc.init());
else _jfc.init();
