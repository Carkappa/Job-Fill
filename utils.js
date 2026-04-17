// utils.js — JobFill Pro shared utilities (loaded before contentScript.js)

// ─── Logger (debounced storage writes) ───────────────────────────────────────
const Logger = {
  PREFIX: '[JobFill]',
  _buf:   [],   // pending entries waiting to be flushed
  _flush: null, // debounce timer

  _push(level, args) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const entry = { time: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }), level, msg };
    this._buf.push(entry);
    // Debounce: flush to storage at most once every 800 ms
    clearTimeout(this._flush);
    this._flush = setTimeout(() => {
      const pending = this._buf.splice(0);
      if (!pending.length) return;
      try {
        chrome.storage.local.get('activityLog', ({ activityLog = [] }) => {
          const next = [...pending, ...activityLog].slice(0, 150);
          chrome.storage.local.set({ activityLog: next });
        });
      } catch (_) {}
    }, 800);
  },

  log:     (...a) => { console.log(Logger.PREFIX,        ...a); Logger._push('log',     a); },
  info:    (...a) => { console.info(Logger.PREFIX+' ℹ',  ...a); Logger._push('info',    a); },
  warn:    (...a) => { console.warn(Logger.PREFIX+' ⚠',  ...a); Logger._push('warn',    a); },
  error:   (...a) => { console.error(Logger.PREFIX+' ✖', ...a); Logger._push('error',   a); },
  success: (...a) => { console.log(Logger.PREFIX+' ✔',   ...a); Logger._push('success', a); },
  table:   (d)    => { console.table(d); },
};

// ─── Field Pattern Definitions ────────────────────────────────────────────────
const FIELD_PATTERNS = {
  firstName:      { keywords: ['first name','first_name','firstname','fname','given name','given-name','forename','legal first','preferred first'], autocomplete: ['given-name'], profileKey: 'firstName' },
  lastName:       { keywords: ['last name','last_name','lastname','lname','surname','family name','family-name','legal last','preferred last'],   autocomplete: ['family-name'], profileKey: 'lastName' },
  fullName:       { keywords: ['full name','full_name','fullname','legal name','your name','candidate name','applicant name'],                    autocomplete: ['name'],        profileKey: 'fullName' },
  email:          { keywords: ['email','e-mail','email address','email_address','work email','personal email','contact email'],                   autocomplete: ['email'],       profileKey: 'email' },
  loginPassword:  { keywords: ['password','confirm password','create password','new password','account password'],                                autocomplete: ['current-password','new-password'], profileKey: 'loginPassword' },
  phone:          { keywords: ['phone','telephone','mobile','cell','cell phone','phone number','contact number','tel','mobile number','primary phone','daytime phone'], autocomplete: ['tel','tel-national'], profileKey: 'phone' },
  phoneExt:       { keywords: ['extension','ext','phone ext'],           autocomplete: ['tel-extension'], profileKey: 'phoneExt' },
  address:        { keywords: ['address','street address','address line 1','address1','mailing address','home address','street'],                 autocomplete: ['street-address','address-line1'], profileKey: 'address' },
  address2:       { keywords: ['address line 2','address2','apt','suite','unit','apartment'],                                                     autocomplete: ['address-line2'], profileKey: 'address2' },
  city:           { keywords: ['city','town','locality','municipality'],                                                                          autocomplete: ['address-level2'], profileKey: 'city' },
  state:          { keywords: ['state','province','region','state/province','state or province','territory'],                                     autocomplete: ['address-level1'], profileKey: 'state' },
  zip:            { keywords: ['zip','zipcode','zip code','postal code','postcode','postal','pin code'],                                          autocomplete: ['postal-code'], profileKey: 'zip' },
  country:        { keywords: ['country','nation','country of residence'],                                                                        autocomplete: ['country','country-name'], profileKey: 'country' },
  linkedin:       { keywords: ['linkedin','linkedin url','linkedin profile','linkedin_url'],                                                      profileKey: 'linkedinUrl' },
  website:        { keywords: ['website','portfolio','personal website','personal site','homepage','web site','portfolio url'],                   autocomplete: ['url'], profileKey: 'websiteUrl' },
  github:         { keywords: ['github','github url','github profile'],                                                                           profileKey: 'githubUrl' },
  currentTitle: {
    keywords: [
      // Field label keywords
      'current title','job title','current position','current role','position title',
      'your title','designation','position applying for','position of interest',
      'desired title','desired position','applying for position',
      // Common job families (helps match dropdowns/free text)
      'software engineer','senior engineer','junior engineer','full stack','frontend','backend',
      'data scientist','data analyst','data engineer','machine learning','ml engineer',
      'product manager','program manager','project manager','engineering manager',
      'devops engineer','cloud engineer','site reliability','platform engineer',
      'ui/ux designer','graphic designer','ux researcher','web designer',
      'marketing manager','digital marketing','content strategist','seo specialist',
      'sales manager','account executive','business development','sales representative',
      'financial analyst','accountant','controller','finance manager','investment analyst',
      'hr manager','recruiter','talent acquisition','human resources','people operations',
      'customer success','customer support','account manager','client services',
      'operations manager','supply chain','logistics','procurement manager',
      'nurse','registered nurse','physical therapist','physician','pharmacist',
      'teacher','professor','instructor','curriculum developer','training specialist',
      'attorney','paralegal','legal counsel','compliance officer',
      'civil engineer','mechanical engineer','electrical engineer','structural engineer',
      'architect','interior designer','construction manager','project engineer',
      'executive assistant','administrative assistant','office manager','coordinator',
      'ceo','cto','cfo','vp engineering','director of','head of','vice president',
    ],
    autocomplete: ['organization-title'],
    profileKey: 'currentTitle',
  },
  currentCompany: { keywords: ['current company','current employer','employer','company','organization','current organization','company name','employer name'], autocomplete: ['organization'], profileKey: 'currentCompany' },
  yearsExperience:{ keywords: ['years of experience','years experience','total experience','how many years','professional experience','years in field','experience level'], profileKey: 'yearsExperience' },
  school:         { keywords: ['school','university','college','institution','alma mater','school name','university name'],                                      profileKey: 'school' },
  degree:         { keywords: ['degree','education level','highest degree','highest education','qualification','level of education','educational background'],   profileKey: 'degree' },
  major:          { keywords: ['major','field of study','concentration','discipline','area of study','course of study'],                                         profileKey: 'major' },
  gpa:            { keywords: ['gpa','grade point average','cgpa'],                                                                                              profileKey: 'gpa' },
  graduationYear: { keywords: ['graduation year','year of graduation','year graduated','grad year','completion year','expected graduation'],                     profileKey: 'graduationYear' },
  workAuth: {
    keywords: [
      'work authorization','authorized to work','eligible to work','legally authorized',
      'work permit','right to work','authorized in the us','us work authorization',
      'authorization to work','employment authorization','work eligibility',
      'legally eligible','legally permitted','lawfully authorized',
    ],
    profileKey: 'workAuthorization',
  },
  sponsorship: {
    // Separate pattern for "require sponsorship" questions (inverse of workAuth)
    keywords: [
      'require sponsorship','require visa sponsorship','need sponsorship','require work sponsorship',
      'visa sponsorship required','need work visa','will you require','employer sponsorship',
      'sponsorship for employment','immigration sponsorship','do you need',
    ],
    profileKey: '_sponsorshipReverse', // handled specially in FormFiller
  },
  salary:         { keywords: ['salary','expected salary','desired salary','target salary','compensation','expected compensation','salary expectation','annual salary','salary requirement','pay expectation'], profileKey: 'expectedSalary' },
  startDate:      { keywords: ['start date','available to start','availability','earliest start','when can you start','notice period','available from','date available'], profileKey: 'startDate' },
  coverLetter:    { keywords: ['cover letter','covering letter','motivation letter','letter of intent','additional information','message to hiring','message to recruiter','why do you want','personal statement','why are you interested'], profileKey: 'coverLetter' },
  summary:        { keywords: ['summary','about yourself','about you','bio','introduction','tell us about','professional summary','describe yourself','professional profile'], profileKey: 'summary' },
  skills:         { keywords: ['skills','key skills','technical skills','competencies','areas of expertise','core skills','skill set'], profileKey: 'skills' },
  languages:      { keywords: ['languages','language skills','spoken languages','language proficiency','languages spoken'], profileKey: 'languages' },
  certifications: { keywords: ['certifications','certificates','credentials','professional certifications','licenses'], profileKey: 'certifications' },
  referral: {
    keywords: [
      'how did you hear','how did you find','referral source','where did you hear',
      'how did you learn','heard about us','source of hire','how did you discover',
      'how were you referred','recruitment source','how did you come across',
    ],
    profileKey: 'referralSource',
  },
  agreeToTerms: {
    // Detected checkbox-only — always auto-checked, no profileKey needed
    keywords: [
      'i agree','i accept','agree to the terms','accept the terms','terms of service',
      'terms and conditions','privacy policy','i have read','acknowledge','certify that',
      'consent to','by checking','i confirm','legal agreement','user agreement',
    ],
    profileKey: '_autoCheck',
  },
  gender:         { keywords: ['gender','sex','gender identity'],                                                                                profileKey: 'gender' },
  ethnicity:      { keywords: ['ethnicity','race','racial','ethnic background','racial/ethnic'],                                                 profileKey: 'ethnicity' },
  veteran:        { keywords: ['veteran','military','military service','protected veteran','veteran status','military veteran'],                  profileKey: 'veteranStatus' },
  disability:     { keywords: ['disability','disabled','accommodation','disability status','physical disability'],                               profileKey: 'disabilityStatus' },
};

// ─── ATS Platform Configurations ─────────────────────────────────────────────
const ATS_CONFIGS = {
  linkedin: {
    name: 'LinkedIn Easy Apply',
    detect: () => window.location.hostname.includes('linkedin.com') &&
      !!(document.querySelector('.jobs-easy-apply-modal,.jobs-easy-apply-content,[data-test-modal-id="easy-apply-modal"]')),
    selectors: {
      modal:        '.jobs-easy-apply-modal, .jobs-easy-apply-content',
      nextBtn:      'button[aria-label*="Continue" i], button[aria-label*="Next" i], button[aria-label*="next step" i]',
      reviewBtn:    'button[aria-label*="Review" i]',
      submitBtn:    'button[aria-label*="Submit application" i], button[aria-label*="submit" i]',
      resumeUpload: '.jobs-document-upload input[type="file"], .jobs-resume-picker__upload-input, .jobs-document-upload-redesign-card input[type="file"], input[id*="resume"]',
      alreadyApplied: '.jobs-details-top-card__apply-information--applied, [class*="applied-state"], .jobs-apply-button--applied',
      errorMsg:     '.artdeco-inline-feedback--error',
      successToast: '.jobs-easy-apply-toast, [data-test-job-applied-toast], .artdeco-toast-item--success',
    },
  },
  workday: {
    name: 'Workday',
    detect: () => window.location.hostname.includes('myworkdayjobs.com') || window.location.hostname.includes('workday.com') || !!document.querySelector('[data-automation-id="applicationForm"]'),
    selectors: {
      form:         '[data-automation-id="applicationForm"], form',
      nextBtn:      '[data-automation-id="bottom-navigation-next-button"]',
      submitBtn:    '[data-automation-id="bottom-navigation-footer-button"]',
      resumeUpload: '[data-automation-id*="resume"] input[type="file"], [data-automation-id*="Resume"] input[type="file"], [data-automation-id*="cv"] input[type="file"], input[data-automation-id*="fileInput"]',
      fileSection:  '[data-automation-id*="resume"],[data-automation-id*="cv"],[data-automation-id*="document"],[data-automation-id*="attachment"],[data-automation-id*="file-upload"]',
    },
  },
  greenhouse: {
    name: 'Greenhouse',
    detect: () => window.location.hostname.includes('greenhouse.io') || !!document.querySelector('#application_form, .application-form'),
    selectors: {
      form:         '#application_form, .application-form, form.js-application-form',
      submitBtn:    '#submit_app, input[type="submit"], button[type="submit"]',
      resumeUpload: '#resume, input[id*="resume"], input[name*="resume"], .resume-upload input[type="file"]',
      errorMsg:     '.field_with_errors, .error',
    },
  },
  lever: {
    name: 'Lever',
    detect: () => window.location.hostname.includes('lever.co') || !!document.querySelector('.application-form'),
    selectors: {
      form:         '.application-form, form[class*="application"]',
      submitBtn:    '.template-btn-submit, button[type="submit"]',
      resumeUpload: 'input[name="resume"], input[id*="resume"], .resume-upload-section input[type="file"]',
    },
  },
  taleo: {
    name: 'Oracle Taleo',
    detect: () => window.location.hostname.includes('taleo.net') || !!document.querySelector('[id*="TaleoForm"],[class*="taleo"]'),
    selectors: {
      form:         'form, [id*="Form"]',
      nextBtn:      'input[value*="Next" i], button[id*="Next" i], a[id*="Next" i]',
      submitBtn:    'input[value*="Submit" i], button[id*="Submit" i]',
      resumeUpload: 'input[type="file"][id*="resume" i], input[type="file"][name*="resume" i]',
    },
  },
  icims: {
    name: 'iCIMS',
    detect: () => window.location.hostname.includes('icims.com'),
    selectors: {
      form:         'form',
      nextBtn:      '.iCIMS_Button_Next, input[value*="Next" i]',
      submitBtn:    '.iCIMS_Button_Submit, input[type="submit"]',
      resumeUpload: 'input[type="file"]',
    },
  },
  indeed: {
    name: 'Indeed',
    detect: () => window.location.hostname.includes('indeed.com') || window.location.hostname.includes('apply.indeed.com'),
    selectors: {
      form:         'form, .ia-BasePage-content',
      nextBtn:      '.ia-continueButton, button[data-testid*="next" i], button[id*="next" i]',
      submitBtn:    '.ia-submitButton, button[data-testid*="submit" i], button[id*="submit" i]',
      resumeUpload: 'input[type="file"][id*="resume" i], input[type="file"][name*="resume" i], .ia-Resume input[type="file"]',
    },
  },
  jobvite: {
    name: 'Jobvite',
    detect: () => window.location.hostname.includes('jobvite.com'),
    selectors: {
      form:         '#jv-apply-form, form.apply-form',
      nextBtn:      '.next-btn, .jv-button-next',
      submitBtn:    'button[type="submit"], input[type="submit"]',
      resumeUpload: 'input[type="file"][id*="resume" i], input[type="file"][name*="resume" i]',
    },
  },
  smartrecruiters: {
    name: 'SmartRecruiters',
    detect: () => window.location.hostname.includes('smartrecruiters.com'),
    selectors: {
      form:         'form',
      nextBtn:      '[data-test-id*="next" i], .next-button',
      submitBtn:    '[data-test-id*="submit" i], button[type="submit"]',
      resumeUpload: 'input[type="file"]',
    },
  },
};

// ─── Field Matcher ────────────────────────────────────────────────────────────
const FieldMatcher = {
  getLabelText(element) {
    if (element.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const lbId = element.getAttribute('aria-labelledby');
    if (lbId) {
      const text = lbId.split(/\s+/).map(id => document.getElementById(id)?.textContent).filter(Boolean).join(' ');
      if (text) return text.trim();
    }
    const al = element.getAttribute('aria-label');
    if (al) return al.trim();
    const wl = element.closest('label');
    if (wl) return wl.textContent.trim();
    const pl = element.parentElement?.querySelector('label');
    if (pl) return pl.textContent.trim();
    const parent = element.parentElement;
    if (parent) {
      const nodes = Array.from(parent.childNodes);
      for (let i = nodes.indexOf(element) - 1; i >= 0; i--) {
        const t = nodes[i].textContent?.trim();
        if (t) return t;
      }
    }
    return element.getAttribute('placeholder') || '';
  },

  matchElement(element) {
    const signals = [
      element.getAttribute('name')               || '',
      element.getAttribute('id')                 || '',
      element.getAttribute('placeholder')        || '',
      element.getAttribute('aria-label')         || '',
      element.getAttribute('autocomplete')       || '',
      element.getAttribute('data-automation-id') || '',
      element.getAttribute('data-field-id')      || '',
      element.getAttribute('data-qa')            || '',
      this.getLabelText(element),
    ].join(' ').toLowerCase().replace(/[-_]/g, ' ');

    let bestType = null, bestScore = 0;
    for (const [fieldType, pat] of Object.entries(FIELD_PATTERNS)) {
      let score = 0;
      if (pat.autocomplete) {
        for (const ac of pat.autocomplete) {
          if (signals.includes(ac.toLowerCase())) score = Math.max(score, 3.0);
        }
      }
      for (const kw of pat.keywords) {
        if (signals.includes(kw)) {
          const re = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`);
          score = Math.max(score, re.test(signals) ? 2.5 : 1.5);
        }
      }
      if (score > bestScore) { bestScore = score; bestType = fieldType; }
    }
    if (bestScore >= 1.5) {
      Logger.log(`Field match [score=${bestScore.toFixed(1)}]: "${signals.slice(0, 60)}" → ${bestType}`);
      return { fieldType: bestType, score: bestScore };
    }
    return null;
  },
};

// ─── Event Utilities ──────────────────────────────────────────────────────────
const EventUtils = {
  // Works with React/Vue/Angular controlled inputs.
  // Retries once if the value didn't take (common with React strict mode).
  setValue(el, value) {
    if (!el) return false;
    try {
      const proto  = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input',    { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change',   { bubbles: true, cancelable: true }));
      el.dispatchEvent(new FocusEvent('blur',{ bubbles: true }));
      // Verify value was actually set (React controlled inputs can revert)
      if (value !== '' && el.value === '' && el.type !== 'password') {
        Logger.warn(`setValue: value did not stick on ${el.id || el.name}, retrying`);
        el.focus();
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    } catch (e) { Logger.error('setValue', e); return false; }
  },

  selectOption(sel, value) {
    if (!sel || sel.tagName !== 'SELECT') return false;
    const norm = value.toLowerCase().trim();

    // Build synonym sets for common boolean/EEO values
    const YES_SYNONYMS = ['yes','yeah','yep','true','1','i am','authorized','eligible','i do','affirmative'];
    const NO_SYNONYMS  = ['no','nope','false','0','not required','i am not','not authorized','i do not','no, i'];
    const DECLINE_SYNONYMS = [
      'prefer not','decline','not wish to','do not wish','choose not',
      'i prefer not','no response','no answer','opt out','n/a','unknown',
    ];

    const isYes     = YES_SYNONYMS.some(s => norm === s || norm.startsWith(s));
    const isNo      = NO_SYNONYMS.some(s => norm === s || norm.startsWith(s));
    const isDecline = DECLINE_SYNONYMS.some(s => norm.includes(s));

    const _set = (opt) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(sel, opt.value); else sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    // Pass 1: exact match on text or value
    for (const opt of sel.options) {
      if (!opt.value && !opt.text.trim()) continue;
      const t = opt.text.toLowerCase().trim();
      const v = opt.value.toLowerCase().trim();
      if (t === norm || v === norm) return _set(opt);
    }

    // Pass 2: contains match
    for (const opt of sel.options) {
      if (!opt.value) continue;
      const t = opt.text.toLowerCase().trim();
      const v = opt.value.toLowerCase().trim();
      if (t.includes(norm) || norm.includes(t) || v.includes(norm) || norm.includes(v)) return _set(opt);
    }

    // Pass 3: synonym-based match (yes/no/decline)
    if (isYes || isNo || isDecline) {
      const synonyms = isDecline ? DECLINE_SYNONYMS : isYes ? YES_SYNONYMS : NO_SYNONYMS;
      for (const opt of sel.options) {
        if (!opt.value) continue;
        const t = opt.text.toLowerCase().trim();
        if (synonyms.some(s => t.includes(s))) return _set(opt);
      }
    }

    return false;
  },

  selectRadio(name, value, root = document) {
    const radios = root.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
    if (!radios.length) return false;
    const norm = value.toLowerCase().trim();

    const YES_SYNS = ['yes','yeah','true','authorized','eligible','i am','i do','affirmative','1'];
    const NO_SYNS  = ['no','false','not required','i am not','i do not','0'];
    const DECLINE  = ['prefer not','decline','not wish','choose not','no response','n/a'];

    const isYes = YES_SYNS.some(s => norm === s || norm.startsWith(s));
    const isNo  = NO_SYNS.some(s => norm === s || norm.startsWith(s));

    const _pick = (r) => {
      r.checked = true;
      r.dispatchEvent(new MouseEvent('click',  { bubbles: true }));
      r.dispatchEvent(new Event('change',      { bubbles: true }));
      return true;
    };

    // Pass 1: direct match on label or value
    for (const r of radios) {
      const lbl = FieldMatcher.getLabelText(r).toLowerCase();
      const val = r.value.toLowerCase();
      if (lbl === norm || val === norm || lbl.includes(norm) || norm.includes(lbl)) return _pick(r);
    }

    // Pass 2: yes/no synonym match
    if (isYes || isNo) {
      const syns = isYes ? YES_SYNS : NO_SYNS;
      for (const r of radios) {
        const lbl = FieldMatcher.getLabelText(r).toLowerCase();
        const val = r.value.toLowerCase();
        if (syns.some(s => lbl.includes(s) || val === s)) return _pick(r);
      }
    }

    // Pass 3: for decline/prefer-not-to-say
    if (DECLINE.some(s => norm.includes(s))) {
      for (const r of radios) {
        const lbl = FieldMatcher.getLabelText(r).toLowerCase();
        if (DECLINE.some(s => lbl.includes(s))) return _pick(r);
      }
    }

    return false;
  },

  // Fill a <input type="date"> from a text value like "2024-06-15" or "immediately"
  setDate(el, value) {
    const resolved = Normalizers.toDateInput(value);
    if (resolved) return this.setValue(el, resolved);
    return this.setValue(el, value);
  },

  simulateClick(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
    el.click();
  },

  // Attach a File to a file input using DataTransfer.
  // Returns true only if files.length > 0 after assignment (actual verification).
  async setFile(fileInput, base64Data, filename, mime) {
    if (!fileInput || !base64Data) return false;
    try {
      const resolvedMime = mime || ResumeUtils.getMimeType(filename);
      const clean = base64Data.replace(/^data:[^;]+;base64,/, '');
      const raw   = atob(clean);
      const buf   = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

      const file = new File([buf], filename || 'resume.pdf', { type: resolvedMime });
      const dt   = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;

      // Hard verification: did the browser actually accept the file?
      if (fileInput.files.length === 0) {
        Logger.warn(`setFile: DataTransfer rejected by ${fileInput.id || fileInput.name}`);
        return false;
      }

      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input',  { bubbles: true }));
      fileInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    } catch (e) { Logger.error('setFile', e); return false; }
  },
};

// ─── Resume Utilities ─────────────────────────────────────────────────────────
const ResumeUtils = {
  getMimeType(filename = '') {
    const ext = filename.split('.').pop().toLowerCase();
    return { pdf: 'application/pdf', doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[ext] || 'application/pdf';
  },
  getAllFileInputs(root = document) {
    return Array.from(root.querySelectorAll('input[type="file"]'));
  },
  isResumeInput(inp) {
    const ctx = [
      FieldMatcher.getLabelText(inp), inp.name || '', inp.id || '',
      inp.accept || '', inp.getAttribute('data-automation-id') || '',
      inp.closest('[class]')?.className || '', inp.closest('[id]')?.id || '',
    ].join(' ').toLowerCase();
    return (
      ctx.includes('resume') || ctx.includes(' cv ') || ctx.startsWith('cv') ||
      ctx.includes('_cv') || ctx.includes('-cv') || ctx.includes('cv_') ||
      ctx.includes('curriculum') ||
      !!(inp.accept || '').match(/\.(pdf|doc|docx)/)
    );
  },
  // Check DOM for signs the upload was acknowledged (filename label appeared)
  uploadConfirmed(inp) {
    if (inp.files.length === 0) return false;
    const parent = inp.closest('[class],[data-automation-id]') || inp.parentElement;
    if (!parent) return false;
    const text = parent.textContent.toLowerCase();
    return text.includes('.pdf') || text.includes('.doc') || text.includes('uploaded') || text.includes('selected') || text.includes(inp.files[0]?.name?.toLowerCase() || '__never__');
  },
};

// ─── DOM Utilities ────────────────────────────────────────────────────────────
const DOMUtils = {
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),

  waitForElement(selector, timeout = 5000, root = document) {
    return new Promise((resolve, reject) => {
      const el = root.querySelector(selector);
      if (el) return resolve(el);
      const t = setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
      const obs = new MutationObserver(() => {
        const found = root.querySelector(selector);
        if (found) { clearTimeout(t); obs.disconnect(); resolve(found); }
      });
      obs.observe(root, { childList: true, subtree: true });
    });
  },

  getInteractableFields(root = document) {
    const sel = [
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([disabled]):not([readonly])',
      'select:not([disabled])',
      'textarea:not([disabled]):not([readonly])',
    ].join(',');
    return Array.from(root.querySelectorAll(sel)).filter(el => {
      const r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    });
  },

  findNavButton(keywords) {
    const pool = Array.from(document.querySelectorAll(
      'button:not([disabled]), input[type="button"]:not([disabled]), input[type="submit"]:not([disabled]), [role="button"]:not([aria-disabled="true"])'
    ));
    for (const kw of keywords) {
      const m = pool.find(b => {
        const t = (b.textContent || b.value || b.getAttribute('aria-label') || '').toLowerCase().trim();
        return t === kw || t.includes(kw);
      });
      if (m) return m;
    }
    return null;
  },

  findSubmitButton() {
    return DOMUtils.findNavButton(['submit application','submit','apply now','send application','complete application','finish','review and submit']);
  },

  // Search inside document iframes (e.g. Taleo embeds forms in iframes)
  queryAcrossFrames(selector) {
    const results = Array.from(document.querySelectorAll(selector));
    try {
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          const doc = frame.contentDocument;
          if (doc) results.push(...doc.querySelectorAll(selector));
        } catch (_) {}
      }
    } catch (_) {}
    return results;
  },
};

// ─── Retry Utilities ──────────────────────────────────────────────────────────
const RetryUtils = {
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  async withRetry(fn, attempts = 3, delay = 500) {
    for (let i = 1; i <= attempts; i++) {
      try {
        const r = await fn();
        if (r !== null && r !== undefined && r !== false) return r;
      } catch (e) {
        if (i === attempts) throw e;
        Logger.warn(`Retry ${i}/${attempts} in ${delay * i}ms`);
      }
      await this.sleep(delay * i);
    }
    return null;
  },
};

// ─── Value Normalizers ────────────────────────────────────────────────────────
const Normalizers = {
  phone(raw) {
    if (!raw) return raw;
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits[0] === '1') return `+1 (${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
    return raw;
  },

  // Convert human dates/phrases into YYYY-MM-DD for <input type="date">
  toDateInput(value) {
    if (!value) return null;
    const v = value.toLowerCase().trim();

    // Already in YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

    // "immediately" / "asap" → today
    if (/immediately|asap|now|right away|flexible/.test(v)) {
      return new Date().toISOString().slice(0, 10);
    }

    // "2 weeks" / "2 weeks notice" → today + 14 days
    const weeksMatch = v.match(/(\d+)\s*week/);
    if (weeksMatch) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(weeksMatch[1]) * 7);
      return d.toISOString().slice(0, 10);
    }

    // "1 month" → today + 30 days
    const monthMatch = v.match(/(\d+)\s*month/);
    if (monthMatch) {
      const d = new Date();
      d.setMonth(d.getMonth() + parseInt(monthMatch[1]));
      return d.toISOString().slice(0, 10);
    }

    // "30 days" → today + 30
    const daysMatch = v.match(/(\d+)\s*day/);
    if (daysMatch) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(daysMatch[1]));
      return d.toISOString().slice(0, 10);
    }

    // Try JS date parsing as last resort
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

    return null;
  },

  // Personalise cover letter: replace {company} and {title} placeholders
  coverLetter(template, jobTitle, company) {
    if (!template) return template;
    return template
      .replace(/\{company\}/gi,   company   || 'your company')
      .replace(/\{title\}/gi,     jobTitle  || 'this position')
      .replace(/\{job_title\}/gi, jobTitle  || 'this position');
  },
};
