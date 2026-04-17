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

  // ── Resolve the value to fill for a given fieldType / pattern ──────────────
  _resolveValue(fieldType, pat) {
    let value = this.profile[pat.profileKey];

    if (!value && this.profile.positions?.length) {
      const latest = this.profile.positions[0];
      if (fieldType === 'currentTitle')   value = latest.title;
      if (fieldType === 'currentCompany') value = latest.company;
      if (fieldType === 'workHistory') {
        value = this.profile.positions.map(p => {
          const range = [p.startDate, p.endDate].filter(Boolean).join(' – ');
          const lines = [`${p.title} at ${p.company}${range ? ` (${range})` : ''}`];
          if (p.description) lines.push(p.description);
          return lines.join('\n');
        }).join('\n\n');
      }
    }

    if (fieldType === 'fullName' && !value)
      value = [this.profile.firstName, this.profile.lastName].filter(Boolean).join(' ');
    if (fieldType === 'phone'       && value) value = Normalizers.phone(value);
    if (fieldType === 'coverLetter' && value)
      value = Normalizers.coverLetter(value, this.jobInfo?.title, this.jobInfo?.company);
    if (['veteran','disability','gender','ethnicity'].includes(fieldType) && !value)
      value = 'Prefer not to say';
    if (fieldType === 'referral' && !value) value = 'LinkedIn';

    return value ?? null;
  }

  // ── Fill a single specific field (used when fixing error-highlighted fields) ─
  async fillField(f) {
    f._jfDone = false; // allow re-fill even if already processed

    const r = f.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;

    // agreeToTerms checkbox
    const type = (f.getAttribute('type') || '').toLowerCase();
    if (type === 'checkbox') {
      const lbl = FieldMatcher.getLabelText(f).toLowerCase();
      if (/agree|accept|terms|condition|privacy|consent|certify/.test(lbl) && !f.checked) {
        f.checked = true;
        f.dispatchEvent(new Event('change', { bubbles: true }));
        this.filledCount++;
      }
      return true;
    }

    const match = FieldMatcher.matchElement(f);
    if (!match) {
      Logger.warn(`[fix] no match for: ${f.name || f.id || FieldMatcher.getLabelText(f)}`);
      return false;
    }

    const { fieldType } = match;
    const pat = FIELD_PATTERNS[fieldType];
    if (!pat) return false;

    if (fieldType === 'agreeToTerms') {
      if (!f.checked) { f.checked = true; f.dispatchEvent(new Event('change', { bubbles: true })); }
      f._jfDone = true; this.filledCount++; return true;
    }

    if (fieldType === 'sponsorship') {
      const v = (this.profile.workAuthorization === 'Yes') ? 'No' : 'Yes';
      const ok = await this._fill(f, 'workAuth', v);
      if (ok) { f._jfDone = true; f.classList?.add('jobfill-filled'); this.filledCount++; }
      return ok;
    }

    const value = this._resolveValue(fieldType, pat);
    if (!value) {
      Logger.warn(`[fix] no value for fieldType=${fieldType}`);
      return false;
    }

    const ok = await this._fill(f, fieldType, String(value));
    if (ok) {
      f._jfDone = true;
      f.classList?.add('jobfill-filled');
      this.filledCount++;
      Logger.success(`[fix][${fieldType}] "${String(value).slice(0, 50)}"`);
      setTimeout(() => f.classList?.replace('jobfill-filled', 'jobfill-filled-done'), 4000);
    }
    return ok;
  }

  // ── Fill all visible fields top-to-bottom (used for create-account forms) ───
  async fillAllFields(root = document) {
    await RetryUtils.sleep(400);

    const fields = DOMUtils.getInteractableFields(root).sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const rowDiff = Math.round(ra.top) - Math.round(rb.top);
      return rowDiff !== 0 ? rowDiff : ra.left - rb.left;
    });

    Logger.info(`Scanning ${fields.length} fields (top→bottom)`);
    let filled = 0;

    for (const f of fields) {
      if (f._jfDone) continue;
      const r = f.getBoundingClientRect(), s = window.getComputedStyle(f);
      if (r.width === 0 || r.height === 0 || s.display === 'none' ||
          s.visibility === 'hidden' || s.opacity === '0') { this.skippedCount++; continue; }

      const match = FieldMatcher.matchElement(f);
      if (!match) { this.skippedCount++; continue; }
      const { fieldType } = match;
      const pat = FIELD_PATTERNS[fieldType];
      if (!pat) continue;

      if (fieldType === 'agreeToTerms') {
        if ((f.getAttribute('type') || '') === 'checkbox' && !f.checked) {
          f.checked = true; f.dispatchEvent(new Event('change', { bubbles: true }));
          f._jfDone = true; this.filledCount++;
        }
        continue;
      }

      if (fieldType === 'sponsorship') {
        const v = (this.profile.workAuthorization === 'Yes') ? 'No' : 'Yes';
        const ok = await this._fill(f, 'workAuth', v);
        if (ok) { f._jfDone = true; f.classList?.add('jobfill-filled'); this.filledCount++; filled++; }
        await RetryUtils.sleep(this._delay(filled)); continue;
      }

      const value = this._resolveValue(fieldType, pat);
      if (!value) { this.skippedCount++; continue; }

      const ok = await this._fill(f, fieldType, String(value));
      if (ok) {
        f._jfDone = true; f.classList?.add('jobfill-filled');
        this.filledCount++; filled++;
        this.log.push({ fieldType, value: String(value).slice(0, 60) });
        Logger.success(`[${fieldType}] "${String(value).slice(0, 50)}"`);
        setTimeout(() => f.classList?.replace('jobfill-filled', 'jobfill-filled-done'), 4000);
      }
      await RetryUtils.sleep(this._delay(filled));
    }
  }

  _delay(n) {
    const base = this.profile.fillDelay ?? 80;
    if (n < 2)  return Math.max(base, 500);
    if (n < 5)  return Math.max(base, 250);
    if (n < 10) return Math.max(base, 120);
    return base;
  }

  async _fill(el, fieldType, value) {
    try {
      const tag  = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (tag === 'select') {
        if (fieldType === 'referral') return this._fillReferral(el);
        return EventUtils.selectOption(el, value);
      }
      if (type === 'radio')    return EventUtils.selectRadio(el.name, value);
      if (type === 'file')     return false;
      if (type === 'checkbox') {
        const should = ['yes','true','1','checked'].includes(value.toLowerCase());
        if (el.checked !== should) { el.checked = should; el.dispatchEvent(new Event('change', { bubbles: true })); }
        return true;
      }
      if (type === 'date')     return EventUtils.setDate(el, value);
      if (tag === 'input' || tag === 'textarea' || type === 'password')
        return EventUtils.setValue(el, value);
      if (el.isContentEditable) {
        el.focus(); document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value); return true;
      }
    } catch (e) { Logger.error(`_fill[${fieldType}]`, e); }
    return false;
  }

  _fillReferral(sel) {
    const candidates = [
      this.profile.referralSource,
      'LinkedIn','Job Board','Job board','Social Media','Social media',
      'Online Job Board','Indeed','ZipRecruiter','Glassdoor','Monster',
      'Career Website','Career website','Company Website','Internet','Online','Other',
    ].filter(Boolean);
    for (const c of candidates) { if (EventUtils.selectOption(sel, c)) return true; }
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

// ─── Oracle Cloud JET Custom Dropdowns ───────────────────────────────────────
class OracleCloudDropdowns {
  static async fill(profile) {
    // Oracle JET uses [data-oj-component="ojSelect"] or [role="combobox"] wrappers
    const ctrs = document.querySelectorAll(
      '[data-oj-component="ojSelect"]:not([data-jf-dd]),' +
      '[data-oj-component="ojCombobox"]:not([data-jf-dd]),' +
      '[class*="oj-select"]:not([data-jf-dd]):not(option)'
    );
    for (const ctr of ctrs) {
      const match = FieldMatcher.matchElement(ctr);
      if (!match) continue;
      const pat = FIELD_PATTERNS[match.fieldType];
      if (!pat) continue;

      // Resolve state variants (TX ↔ Texas)
      let value = profile[pat.profileKey];
      if (match.fieldType === 'state' && value) value = Normalizers.stateVariants(value)[0] || value;
      if (!value) continue;

      ctr.setAttribute('data-jf-dd', '1');
      // Click to open the OJet dropdown
      const input = ctr.querySelector('input[role="combobox"],input[type="text"]');
      if (input) {
        EventUtils.setValue(input, value);
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
        await RetryUtils.sleep(400);
      } else {
        EventUtils.simulateClick(ctr);
        await RetryUtils.sleep(400);
      }

      // Pick matching option from the popup list
      const options = document.querySelectorAll(
        '[data-oj-item],[role="option"],[class*="oj-listbox-result"]'
      );
      const norm = String(value).toLowerCase().trim();
      const stateVars = Normalizers.stateVariants(value);
      for (const opt of options) {
        const t = opt.textContent.toLowerCase().trim();
        if (t === norm || stateVars.some(v => t === v || t.includes(v))) {
          EventUtils.simulateClick(opt);
          break;
        }
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
  constructor() { this._injected = new Set(); this._obs = null; }

  start() {
    this._scan();
    // Debounced re-scan when LinkedIn lazy-loads more job cards
    let _t;
    this._obs = new MutationObserver(() => { clearTimeout(_t); _t = setTimeout(() => this._scan(), 400); });
    this._obs.observe(document.body, { childList: true, subtree: true });
  }

  _scan() {
    // Multiple selector variants — LinkedIn changes these regularly
    const easyApplyBtns = document.querySelectorAll([
      'button[aria-label*="Easy Apply" i]:not([data-jf-qi])',
      '.jobs-apply-button--top-card:not([data-jf-qi])',
      '.jobs-s-apply button:not([data-jf-qi])',
      '[class*="easy-apply"]:not([data-jf-qi]) button',
      'button[data-job-id]:not([data-jf-qi])',
      'button[class*="jobs-apply"]:not([data-jf-qi])',
    ].join(', '));
    for (const btn of easyApplyBtns) this._inject(btn);
  }

  _inject(eaBtn) {
    const jobId = this._jobId(eaBtn);
    if (!jobId || this._injected.has(jobId)) return;

    // Verify it's actually an Easy Apply button (not a "View" or "Save" button)
    const btnText = (eaBtn.textContent || eaBtn.getAttribute('aria-label') || '').toLowerCase();
    if (!/easy apply|apply|quick apply/.test(btnText) && !eaBtn.querySelector('[class*="easy-apply"]')) {
      // Check if there's a sibling Easy Apply button nearby instead of skipping
      const parent = eaBtn.parentElement;
      if (parent) {
        const sibling = parent.querySelector('button[aria-label*="Easy Apply" i]');
        if (sibling && sibling !== eaBtn) { this._inject(sibling); return; }
      }
      return;
    }

    this._injected.add(jobId);
    eaBtn.setAttribute('data-jf-qi', '1');

    const card    = eaBtn.closest('[data-job-id],[data-occludable-job-id],.job-card-container,.jobs-unified-top-card,.job-details-jobs-unified-top-card');
    const title   = this._text(card,
      'h1,.job-card-list__title,.jobs-unified-top-card__job-title,[class*="jobTitle"],[class*="job-title"],h2[class*="title"]'
    ) || document.querySelector('h1')?.textContent?.trim() || 'Position';
    const company = this._text(card,
      '.job-card-container__company-name,.jobs-unified-top-card__company-name,[class*="companyName"],[class*="company-name"],a[class*="company"]'
    ) || '';
    const applyUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;

    const qBtn = document.createElement('button');
    qBtn.textContent = '⚡ Queue Apply';
    qBtn.title = `Add to JobFill queue: ${title}`;
    qBtn.setAttribute('data-jf-qbtn', jobId);
    qBtn.style.cssText = [
      'margin-left:8px','padding:6px 14px','background:#00875a','color:#fff',
      'border:none','border-radius:20px','font-size:13px','cursor:pointer',
      'font-weight:700','font-family:inherit','transition:background .15s',
      'vertical-align:middle','white-space:nowrap','line-height:1.4',
      'flex-shrink:0',
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
        else showToast(`"${title}" already queued — click ✕ to remove`, 'info', 3000);
      }
    });

    eaBtn.insertAdjacentElement('afterend', qBtn);
  }

  _jobId(btn) {
    // 1. data attribute on button itself
    const direct = btn.getAttribute('data-job-id') || btn.getAttribute('data-occludable-job-id');
    if (direct) return direct;

    // 2. data attribute on ancestor card
    const card = btn.closest('[data-job-id],[data-occludable-job-id],[data-entity-urn]');
    if (card) {
      const fromAttr = card.getAttribute('data-job-id') || card.getAttribute('data-occludable-job-id');
      if (fromAttr) return fromAttr;
      // Extract from entity URN: "urn:li:jobPosting:1234567890"
      const urn = card.getAttribute('data-entity-urn') || '';
      const urnMatch = urn.match(/:(\d{6,})/);
      if (urnMatch) return urnMatch[1];
    }

    // 3. Current page URL
    const urlMatch = location.pathname.match(/\/jobs\/view\/(\d+)/);
    if (urlMatch) return urlMatch[1];

    // 4. Search param
    const sp = new URLSearchParams(location.search).get('currentJobId');
    if (sp) return sp;

    return null;
  }

  _text(root, sel) {
    if (!root) return null;
    for (const s of sel.split(',')) {
      const el = root.querySelector(s.trim());
      const t  = el?.textContent?.trim();
      if (t) return t;
    }
    return null;
  }
}

// ─── Login / Account Creation Filler ─────────────────────────────────────────
class LoginFiller {
  static isPresent() {
    const hasPwd = !!document.querySelector('input[type="password"]');
    if (!hasPwd) return false;
    const pageText = document.body.textContent.toLowerCase();
    return /sign in|log in|login|create account|sign up|register|new account|join us/.test(pageText);
  }

  static isCreateAccount() {
    const t = document.body.textContent.toLowerCase();
    return /create account|sign up|register|new account|join us|create profile/.test(t) &&
           !/^sign in|^log in/.test(t.trim().slice(0, 60));
  }

  static async fill(profile) {
    if (!profile.email) return false;
    const pwdInput = document.querySelector('input[type="password"]');
    if (!pwdInput) return false;

    const form = pwdInput.closest('form') || document.body;

    // On create-account forms: fill ALL profile fields first (first name, last name, phone, etc.)
    // This fixes "create account didn't work" because required fields were left empty.
    if (LoginFiller.isCreateAccount()) {
      Logger.info('[createAccount] Filling all profile fields on create-account form…');
      const filler = new FormFiller(profile, {});
      await filler.fillAllFields(form);
      await RetryUtils.sleep(300);
    }

    // Explicitly fill email and password (may have already been filled above, but ensure it)
    const emailInput =
      form.querySelector('input[type="email"]') ||
      form.querySelector('input[autocomplete*="email"]') ||
      form.querySelector('input[name*="email" i], input[id*="email" i]') ||
      form.querySelector('input[name*="user" i], input[id*="user" i]') ||
      form.querySelector('input[type="text"]:not([type="password"])');

    if (emailInput && emailInput !== pwdInput) {
      EventUtils.setValue(emailInput, profile.email);
      await RetryUtils.sleep(150);
    }

    // Fill both password fields (password + confirm password)
    const allPwdInputs = form.querySelectorAll('input[type="password"]');
    for (const pi of allPwdInputs) {
      if (profile.loginPassword) {
        EventUtils.setValue(pi, profile.loginPassword);
        await RetryUtils.sleep(100);
      }
    }
    Logger.success('[login] credentials filled');

    // Auto-check terms/privacy checkboxes
    for (const cb of form.querySelectorAll('input[type="checkbox"]')) {
      const lbl = FieldMatcher.getLabelText(cb).toLowerCase();
      if (/agree|accept|terms|condition|privacy|consent|certify|acknowledge/.test(lbl) &&
          !/marketing|newsletter|promo/.test(lbl)) {
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          Logger.success(`[login] auto-checked: "${lbl.slice(0, 60)}"`);
        }
      }
    }

    // Click Create Account / Sign Up / Continue
    const submitBtn = DOMUtils.findNavButton([
      'create account','sign up','register','create my account',
      'join','get started','continue','next','create',
    ]);
    if (submitBtn) {
      Logger.info(`[login] clicking: "${(submitBtn.textContent || '').trim()}"`);
      await RetryUtils.sleep(500);
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

    // Check if already applied
    const alreadyAppliedSel = ATS_CONFIGS[this.ats?.key]?.selectors?.alreadyApplied;
    if (alreadyAppliedSel && document.querySelector(alreadyAppliedSel)) {
      this._reportResult(config.jobId, false, 'Already applied to this position');
      return;
    }

    // Click the Apply / Easy Apply button appropriate for this ATS
    const opened = await this._openApplyModal();
    if (!opened) {
      this._reportResult(config.jobId, false, 'Could not find or open Apply button');
      return;
    }

    await this.run({ batchMode: true, jobId: config.jobId });
  }

  // Generic "click Apply and wait for form" — works for any ATS
  async _openApplyModal() {
    const atsKey = this.ats?.key || '';
    Logger.info(`Opening apply modal for ATS: ${atsKey || 'unknown'}`);

    // ATS-specific apply button selectors (tried first)
    const atsSel = ATS_CONFIGS[atsKey]?.selectors?.applyBtn;

    // Generic apply button selectors
    const genericSelectors = [
      // LinkedIn Easy Apply
      'button[aria-label*="Easy Apply" i]',
      '.jobs-apply-button--top-card',
      '.jobs-s-apply button',
      // Generic "Apply" buttons used by most ATSes
      'button[id*="apply" i]:not([id*="already" i]):not([id*="quick" i])',
      'a[id*="apply" i]:not([id*="already" i])',
      '[data-automation-id*="apply" i]',
      '[class*="applyButton" i]',
      '[class*="apply-button" i]',
      // Oracle Cloud
      '[id*="Apply" i][class*="oj"]',
      // Workday
      '[data-automation-id="applyNowButton"]',
      // Greenhouse
      '#btn-apply, .btn-apply, [class*="btn"][class*="apply"]',
      // Lever
      '.template-btn-submit, .postings-btn',
    ].filter(Boolean);

    const allSelectors = atsSel ? [atsSel, ...genericSelectors] : genericSelectors;

    // Try each selector
    let applyBtn = null;
    for (const sel of allSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && !el.disabled) { applyBtn = el; break; }
      } catch (_) {}
    }

    // Fallback: scan all buttons/links for "apply" text
    if (!applyBtn) {
      const candidates = Array.from(document.querySelectorAll(
        'button:not([disabled]), a[href], [role="button"]:not([aria-disabled="true"])'
      ));
      applyBtn = candidates.find(el => {
        const t = (el.textContent || el.getAttribute('aria-label') || el.title || '').toLowerCase().trim();
        return /^apply now$|^apply$|^easy apply$|^apply for this job$|^apply for position$/.test(t);
      });
    }

    if (!applyBtn) {
      // If no apply button at all, the form may already be open — check if fields exist
      const hasForm = DOMUtils.getInteractableFields().length > 2;
      if (hasForm) { Logger.info('No apply button but form is already open'); return true; }
      Logger.warn('No apply button found');
      return false;
    }

    Logger.info(`Clicking apply button: "${(applyBtn.textContent || applyBtn.getAttribute('aria-label') || '').trim().slice(0, 50)}"`);
    EventUtils.simulateClick(applyBtn);

    // LinkedIn: wait for the Easy Apply modal specifically
    if (atsKey === 'linkedin' || location.hostname.includes('linkedin.com')) {
      const modal = await DOMUtils.waitForElement(
        '.jobs-easy-apply-modal, .jobs-easy-apply-content, [data-test-modal]',
        7000
      ).catch(() => null);
      if (!modal) { Logger.warn('LinkedIn modal did not open'); return false; }
      Logger.success('LinkedIn Easy Apply modal opened');
      await RetryUtils.sleep(800);
      return true;
    }

    // For other ATSes: wait for any new form fields to appear
    await RetryUtils.sleep(1500);
    const fields = DOMUtils.getInteractableFields();
    if (fields.length > 0) { Logger.success(`Form ready — ${fields.length} fields`); return true; }

    // Last chance: wait a bit more
    await RetryUtils.sleep(2000);
    return DOMUtils.getInteractableFields().length > 0;
  }

  // ── Interactive run (called by popup button or START_AUTOFILL message) ────
  // Navigate-first: click Next until red errors appear, then fix only those fields.
  async run({ batchMode = false, jobId = null } = {}) {
    if (this.isRunning) { showToast('Already running…', 'warn'); return; }

    this.profile = await this._load();
    if (!this.profile) {
      this._reportResult(jobId, false, 'Profile not configured');
      return;
    }

    this.ats       = ATSDetector.detect();
    this.isRunning = true;

    if (!batchMode) showToast('JobFill started…', 'info', 2000);
    Logger.info(`══ Run Started (${batchMode ? 'batch' : 'interactive'}, navigate-first) ══`);

    const filler  = new FormFiller(this.profile, this._jobInfo());
    const nav     = new StepNavigator(this.ats?.config);
    const confirm = new ConfirmationUI();

    try {
      // Upload resume + agree terms on the initial page before any Next clicks
      await new ResumeUploader(this.profile, this.ats?.key).upload();
      if (this.ats?.key === 'workday')     await WorkdayDropdowns.fill(this.profile);
      if (this.ats?.key === 'oraclecloud') await OracleCloudDropdowns.fill(this.profile);
      this._autoAgreeTerms();

      for (let step = 0; step < 25; step++) {
        Logger.info(`── Step ${step + 1} ──`);

        // Fix any red error fields on the current step (from the previous Next click)
        const errorFields = this._findErrorFields();
        if (errorFields.length > 0) {
          Logger.info(`Fixing ${errorFields.length} error field(s)…`);
          showToast(`⚠️ Fixing ${errorFields.length} required field(s)…`, 'warn', 3000);
          for (const f of errorFields) {
            await filler.fillField(f);
            await RetryUtils.sleep(filler._delay(filler.filledCount));
          }
          // Re-upload resume and re-agree terms in case a new step revealed those
          await new ResumeUploader(this.profile, this.ats?.key).upload();
          this._autoAgreeTerms();
          await RetryUtils.sleep(400);
        }

        if (nav.isAtFinalStep()) {
          Logger.info('Final step — handling submit');

          if (!batchMode) {
            showToast(`✅ ${filler.filledCount} fields filled — confirming…`, 'success', 3000);
            await RetryUtils.sleep(800);
          }

          let confirmed = true;
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

        // Click Next (without pre-filling — let the form tell us what it needs)
        const advanced = await nav.clickNext();
        if (!advanced) {
          const msg = `No next step found (${filler.filledCount} fields filled)`;
          if (batchMode) {
            const sub = DOMUtils.findSubmitButton();
            if (sub) {
              EventUtils.simulateClick(sub);
              await RetryUtils.sleep(2000);
              this._reportResult(jobId, true, `Applied via fallback submit: ${filler.filledCount} fields`);
            } else {
              this._reportResult(jobId, false, 'Could not find next step or submit button');
            }
          } else {
            showToast(`Form complete. ${msg}.`, 'success');
          }
          break;
        }

        // Wait for the new step to render before checking for errors
        await RetryUtils.sleep(2000);

        // Upload resume + agree terms on each new step
        await new ResumeUploader(this.profile, this.ats?.key).upload();
        if (this.ats?.key === 'workday')     await WorkdayDropdowns.fill(this.profile);
        if (this.ats?.key === 'oraclecloud') await OracleCloudDropdowns.fill(this.profile);
        this._autoAgreeTerms();
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

  // Find all form fields currently marked as invalid / showing a red error
  _findErrorFields() {
    const fields = [];
    const seen   = new Set();

    const add = (el) => {
      if (!el || seen.has(el)) return;
      const tag = el.tagName?.toLowerCase();
      if (!['input','select','textarea'].includes(tag)) return;
      if (el.type === 'hidden' || el.disabled) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      seen.add(el);
      fields.push(el);
    };

    // 1. aria-invalid="true" directly on the input
    for (const el of document.querySelectorAll('[aria-invalid="true"]')) add(el);

    // 2. Error message containers → find the associated input
    const errorContainerSels = [
      '.artdeco-inline-feedback--error',
      '[class*="error-message"]',
      '[class*="field-error"]',
      '[class*="validation-error"]',
      '[class*="validationError"]',
      '[class*="input-error"]',
      '[data-automation-id*="error"]',
      '[role="alert"]',
      '.form-error',
      '.has-error',
    ];
    for (const sel of errorContainerSels) {
      for (const errEl of document.querySelectorAll(sel)) {
        if (!errEl.textContent.trim()) continue;
        // Walk up to find a form-field container, then look for inputs within it
        const container = errEl.closest(
          '[class*="field"],[class*="form-group"],[class*="input-group"],fieldset,[data-automation-id]'
        ) || errEl.parentElement;
        if (container) {
          for (const inp of container.querySelectorAll(
            'input:not([type="hidden"]):not([disabled]),select:not([disabled]),textarea:not([disabled])'
          )) add(inp);
        }
        // Also check the immediately preceding sibling element for an input
        let prev = errEl.previousElementSibling;
        while (prev) {
          if (['INPUT','SELECT','TEXTAREA'].includes(prev.tagName)) { add(prev); break; }
          const inp = prev.querySelector('input:not([type="hidden"]),select,textarea');
          if (inp) { add(inp); break; }
          prev = prev.previousElementSibling;
        }
      }
    }

    // 3. Red border via computed style (catches custom ATS error states)
    for (const el of document.querySelectorAll(
      'input:not([type="hidden"]):not([disabled]),select:not([disabled]),textarea:not([disabled])'
    )) {
      if (seen.has(el)) continue;
      if (this._isRedBorder(window.getComputedStyle(el))) add(el);
    }

    return fields;
  }

  // Returns true if the computed border color is red-ish
  _isRedBorder(style) {
    const color = style.borderColor || style.borderTopColor || '';
    const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) {
      const [r, g, b] = [+m[1], +m[2], +m[3]];
      return r > 150 && r > g * 2 && r > b * 2;
    }
    return false;
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
