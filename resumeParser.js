// resumeParser.js — Extract profile fields from uploaded resume (PDF / DOCX / DOC)
// Exposed as a single global: ResumeParser.parse(file) → Promise<partialProfile>

const ResumeParser = (() => {

  // ── Public entry point ─────────────────────────────────────────────────────
  async function parse(file) {
    let text = '';
    try {
      if (/\.pdf$/i.test(file.name))  text = await _pdfText(file);
      else if (/\.docx$/i.test(file.name)) text = await _docxText(file);
      else text = await _rawText(file);
    } catch (e) {
      console.warn('[ResumeParser] extraction error:', e);
    }
    if (!text.trim()) return {};

    // If the uploaded file looks like LaTeX source, strip commands to plain text for parsing
    if (/\\documentclass|\\begin\{document\}|\\section|\\resumeSubheading|\\href|\\textbf|\\resumeItem|\\\\/.test(text)) {
      try { text = _stripLatex(text); } catch (e) { /* ignore */ }
    }

    return _parseFields(text);
  }

  // ── PDF text extraction ────────────────────────────────────────────────────
  async function _pdfText(file) {
    // Prefer using pdf.js when available for robust text extraction from PDFs
    if (typeof window !== 'undefined' && window.pdfjsLib) {
      try {
        const buf = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: buf });
        const pdf = await loadingTask.promise;
        const parts = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          try {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const strs = content.items.map(it => (it.str || '')).filter(Boolean);
            parts.push(strs.join(' '));
          } catch (e) { /* skip page on error */ }
        }
        if (parts.length) return parts.join('\n');
      } catch (e) {
        console.warn('[ResumeParser] pdf.js extraction failed:', e);
      }
    }

    // Original fallback method (best-effort scanning of PDF content streams)
    const buf   = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // Build latin-1 string in safe chunks
    let str = '';
    const CHUNK = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      str += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }

    const parts = [];

    // Primary: scan BT…ET blocks for Tj / TJ operators
    const btEt = /BT([\s\S]*?)ET/g;
    let block;
    while ((block = btEt.exec(str)) !== null) {
      const content = block[1];

      // (string) Tj  or  (string) '  or  (string) "
      const tjRe = /\(((?:[^()\\]|\\[\s\S])*?)\)\s*(?:Tj|'|")/g;
      let m;
      while ((m = tjRe.exec(content)) !== null) parts.push(_decodePdf(m[1]));

      // [(string) num …] TJ
      const tjArr = /\[([\s\S]*?)\]\s*TJ/g;
      while ((m = tjArr.exec(content)) !== null) {
        const inner = /\(((?:[^()\\]|\\[\s\S])*?)\)/g;
        let item;
        while ((item = inner.exec(m[1])) !== null) parts.push(_decodePdf(item[1]));
      }
    }

    if (parts.length > 0) return parts.join(' ');

    // Fallback: readable ASCII run extraction (works for some non-standard PDFs)
    return str.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s{4,}/g, '\n');
  }

  function _decodePdf(s) {
    return s
      .replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\t/g, ' ')
      .replace(/\\\\/g, '\\').replace(/\\(.)/g, '$1');
  }

  // ── DOCX text extraction ──────────────────────────────────────────────────
  async function _docxText(file) {
    const buf   = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const xml   = await _zipEntry(bytes, 'word/document.xml');
    if (!xml) return '';

    return xml
      .replace(/<w:br[^>]*\/?>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Minimal ZIP local-file-entry parser
  async function _zipEntry(bytes, targetName) {
    let i = 0;
    while (i < bytes.length - 30) {
      // Local file header signature PK\x03\x04
      if (bytes[i] !== 0x50 || bytes[i+1] !== 0x4B || bytes[i+2] !== 0x03 || bytes[i+3] !== 0x04) {
        i++; continue;
      }
      const compression = bytes[i+8]  | (bytes[i+9]  << 8);
      const compSize    = bytes[i+18] | (bytes[i+19] << 8) | (bytes[i+20] << 16) | (bytes[i+21] << 24);
      const nameLen     = bytes[i+26] | (bytes[i+27] << 8);
      const extraLen    = bytes[i+28] | (bytes[i+29] << 8);
      const name        = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLen));
      const dataStart   = i + 30 + nameLen + extraLen;

      if (name === targetName) {
        const data = bytes.subarray(dataStart, dataStart + compSize);
        if (compression === 0) return new TextDecoder().decode(data); // stored
        if (compression === 8 && typeof DecompressionStream !== 'undefined') {
          return _inflate(data);
        }
        return null;
      }
      i = dataStart + compSize;
    }
    return null;
  }

  async function _inflate(data) {
    const ds     = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(data);
    writer.close();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return new TextDecoder().decode(out);
  }

  async function _rawText(file) {
    return new Promise(resolve => {
      const r = new FileReader();
      r.onload  = e => resolve(e.target.result || '');
      r.onerror = () => resolve('');
      r.readAsText(file);
    });
  }

  // Strip LaTeX commands to plain text when users upload .tex sources or paste LaTeX
  function _stripLatex(src) {
    let s = String(src || '');
    // Replace common LaTeX commands with their visible content
    // \href{url}{text} -> url or text
    s = s.replace(/\\href\{([^}]+)\}\{([^}]+)\}/g, '$2');
    s = s.replace(/\\url\{([^}]+)\}/g, '$1');
    // Remove LaTeX commands like \textbf{...}, \emph{...}, keep contents
    s = s.replace(/\\(?:textbf|textit|emph|small|Huge|huge|scshape)\{([^}]*)\}/g, '$1');
    // Remove custom resume commands e.g., \resumeSubheading{A}{B}{C}{D}
    s = s.replace(/\\(?:resumeSubheading|resumeProjectHeading)\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}/g, '$1\n$3\n$2\n$4');
    // Remove other macros (\command or \command[...]{...})
    s = s.replace(/\\[a-zA-Z@]+(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, '');
    // Replace LaTeX itemize / tabular markers with newlines
    s = s.replace(/\\item/g, '\n- ');
    s = s.replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/g, '\n');
    // Remove % comments
    s = s.replace(/%.*$/gm, '');
    // Remove braces leftover
    s = s.replace(/[{}]/g, '');
    // Normalize tildes and ~ used for spacing
    s = s.replace(/~+/g, ' ');
    // Collapse multiple blank lines
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  // ── Field extraction ───────────────────────────────────────────────────────
  function _parseFields(text) {
    const f = {};
    const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);

    // ── Contact ──────────────────────────────────────────────────────────────
    const emailM = text.match(/[\w.+'-]+@[\w.-]+\.[a-z]{2,}/i);
    if (emailM) f.email = emailM[0].toLowerCase();

    const phoneM = text.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
    if (phoneM) f.phone = phoneM[0].replace(/[^\d+]/g, match => match === '+' ? '+' : match);

    const liM = text.match(/linkedin\.com\/in\/([\w%-]+)/i);
    if (liM) f.linkedinUrl = `https://www.linkedin.com/in/${liM[1]}`;

    const ghM = text.match(/github\.com\/([\w-]+)/i);
    if (ghM) f.githubUrl = `https://github.com/${ghM[1]}`;

    // Website (not linkedin/github)
    const webM = text.match(/https?:\/\/(?!(?:www\.)?(?:linkedin|github))[\w.-]+\.[a-z]{2,}(?:\/[\w./-]*)?/i);
    if (webM) f.websiteUrl = webM[0].replace(/\.$/, '');

    // ── Name ─────────────────────────────────────────────────────────────────
    // Look in first 8 lines for "Firstname Lastname" (2-4 title-cased words, no numbers/URLs)
    for (const line of lines.slice(0, 8)) {
      if (/\d|@|http|\.com/i.test(line)) continue;
      const words = line.split(/\s+/);
      if (words.length >= 2 && words.length <= 4 &&
          words.every(w => /^[A-Z][a-záàäâéèëêíìïîóòöôúùüûñç'-]+$/i.test(w) && /[A-Z]/.test(w[0]))) {
        f.firstName = words[0];
        f.lastName  = words.slice(1).join(' ');
        break;
      }
    }

    // ── Location ─────────────────────────────────────────────────────────────
    const locM = text.match(/([A-Z][a-zA-Z\s]{2,20}),\s+([A-Z]{2})(?:\s+(\d{5}))?/);
    if (locM) {
      f.city  = locM[1].trim();
      f.state = locM[2];
      if (locM[3]) f.zip = locM[3];
    }

    // ── Education ────────────────────────────────────────────────────────────
    const degreePatterns = [
      [/ph\.?d\.?/i,                         'Ph.D.'],
      [/doctor(?:ate|al)/i,                  'Ph.D.'],
      [/master['s]?\s+of\s+\w+|m\.[sa]\./i,  "Master's"],
      [/m\.?eng\.?/i,                         'M.Eng.'],
      [/bachelor['s]?\s+of\s+\w+|b\.[sa]\./i,"Bachelor's"],
      [/b\.?eng\.?/i,                         'B.Eng.'],
      [/associate['s]?/i,                     "Associate's"],
    ];
    for (const [re, label] of degreePatterns) {
      if (re.test(text)) { f.degree = label; break; }
    }

    // School name
    const schoolM = text.match(
      /([A-Z][a-zA-Z\s&'-]{2,40}(?:University|College|Institute|School|Academy|Polytechnic))|(?:University|College|Institute)\s+of\s+[A-Z][a-zA-Z\s&'-]{2,30}/
    );
    if (schoolM) f.school = schoolM[0].trim();

    // Major — after "in" near degree keywords or standalone
    const majorM = text.match(/(?:in|of)\s+(Computer\s+Science|Software\s+Engineering|Electrical\s+Engineering|Mechanical\s+Engineering|Information\s+Technology|Data\s+Science|Mathematics|Physics|Business|Finance|Economics|Chemistry|Biology|Psychology|Communication|Marketing|Accounting)/i);
    if (majorM) f.major = majorM[1];

    // Graduation / most recent year
    const years = [...text.matchAll(/\b(199[0-9]|20[012][0-9])\b/g)].map(m => parseInt(m[1]));
    if (years.length) f.graduationYear = String(Math.max(...years));

    // ── Work ─────────────────────────────────────────────────────────────────
    const titleRe = /(?:senior|junior|lead|staff|principal|sr\.|jr\.)?[-\s]?(?:software|frontend|front-end|backend|back-end|full[- ]?stack|full stack|devops|cloud|mobile|ios|android|data|ml|ai|machine learning|product|project|engineering|solutions|systems|platform|security|qa|quality|test|site reliability|sre)\s+(?:engineer|developer|architect|manager|analyst|designer|scientist|specialist|lead|director|consultant|intern)/i;
    const titleM = text.match(titleRe);
    if (titleM) f.currentTitle = _titleCase(titleM[0].trim());

    // Years of experience
    const yoeM = text.match(/(\d+)\+?\s+years?(?:\s+of)?\s+(?:experience|exp)/i);
    if (yoeM) f.yearsExperience = yoeM[1];

    // ── Work history extraction (improved heuristics)
    try {
      // Helper: detect date ranges like "Jan 2018 - Present", "2018-2020", "2018" etc.
      const dateRangeRe = /(?:\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\.,]?\s+\d{4}|\b(?:19|20)\d{2})(?:\s*[\-–—to]+\s*(?:Present|Present\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\.,]?\s+\d{4}|\b(?:19|20)\d{2}|Present))?/i;

      // Find the most likely work section by heading or by year density
      let workText = '';
      const headRe = /(experience|work experience|employment history|professional experience|work history)\s*[:\-]?\s*\n([\s\S]{50,5000}?)(?=\n\s*\n(?:education|skills|summary|objective|certificat|projects|$))/i;
      const headMatch = text.match(headRe);
      if (headMatch) workText = headMatch[2];
      else {
        // Search for large contiguous blocks that contain multiple years
        const candidates = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
        let best = '';
        for (const c of candidates) {
          const countYears = (c.match(/\b(?:19|20)\d{2}\b/g) || []).length;
          if (countYears >= 1 && c.length > best.length) best = c;
        }
        if (best) workText = best;
      }

      if (workText) {
        // Break into entries by double newlines or bullets
        const blocks = workText.split(/(?:\n\s*[-•*]\s*|\n{2,})/).map(b => b.trim()).filter(Boolean);
        const entries = [];

        for (const block of blocks.slice(0, 12)) {
          const lines = block.split(/\n/).map(l => l.trim()).filter(Boolean);
          let title = '', company = '', dates = '', desc = '';

          // If any line contains a date range, take that as dates and remove it
          const dateLineIndex = lines.findIndex(l => dateRangeRe.test(l));
          if (dateLineIndex >= 0) {
            dates = (lines[dateLineIndex].match(dateRangeRe) || [''])[0];
            lines.splice(dateLineIndex, 1);
          }

          // Heuristics to find title/company
          if (lines.length === 1) {
            // single line: try split by ' at ' / '@' / '—' / ' - ' / ','
            const parts = lines[0].split(/\s+at\s+|\s+@\s+|\s+—\s+|\s+-\s+|,\s*/);
            title = parts[0] || '';
            company = parts.slice(1).join(' ').trim() || '';
          } else if (lines.length >= 2) {
            // Prefer patterns: Title (line0), Company (line1)
            title = lines[0];
            company = lines[1];
            desc = lines.slice(2).join(' ');

            // If line0 looks like company (all-caps / contains 'Inc'/'LLC' etc.) and line1 looks like title, swap
            const companyIndicator = /\b(inc|llc|ltd|corporation|corp|co\.|company|technologies|systems|solutions)\b/i;
            if (companyIndicator.test(title) && !companyIndicator.test(company)) {
              const tmp = title; title = company; company = tmp;
            }

            // Also handle cases where line0 contains both title and company separated by '·' or '|'
            const splitPossible = title.split(/\s[·|]\s|\s\|\s/);
            if (splitPossible.length >= 2) {
              title = splitPossible[0];
              company = company || splitPossible[1];
            }
          }

          // Clean up values
          title = title.replace(/^[\-–—\s]+|[\-–—\s]+$/g, '').trim();
          company = company.replace(/^[\-–—\s]+|[\-–—\s]+$/g, '').trim();
          dates = (dates || '').replace(/[\s]{2,}/g, ' ').trim();
          desc = desc.replace(/\s{2,}/g, ' ').trim();

          if (title || company || dates || desc) {
            entries.push({ title: _titleCase(title || ''), company: company || '', dates: dates || '', desc: desc || '' });
          }
        }

        if (entries.length) {
          // Provide both a human-readable multi-line string and a structured array
          f.workHistory = entries.slice(0, 8).map(e => `${e.title}${e.company ? ' — ' + e.company : ''}${e.dates ? ' (' + e.dates + ')' : ''}${e.desc ? '\n' + e.desc : ''}`).join('\n\n');
          f.workHistoryEntries = entries.slice(0, 8);
        }
      }
    } catch (e) { /* ignore parser errors */ }

    // ── Skills ────────────────────────────────────────────────────────────────
    // Look for a "Skills" section
    const skillsM = text.match(
      /(?:technical\s+)?skills?\s*[:\-]?\s*\n([\s\S]{20,500}?)(?:\n\s*\n|\n[A-Z]{3})/i
    );
    if (skillsM) {
      f.skills = skillsM[1]
        .replace(/\n+/g, ' · ')
        .replace(/[•·\-–—|,]+/g, ' · ')
        .replace(/\s{2,}/g, ' ')
        .replace(/(?:·\s*){2,}/g, '· ')
        .trim()
        .slice(0, 400);
    }

    // ── Summary / Objective ───────────────────────────────────────────────────
    const summaryM = text.match(
      /(?:summary|objective|profile|about\s+me)\s*[:\-]?\s*\n([\s\S]{30,500}?)(?:\n\s*\n|\n[A-Z]{3})/i
    );
    if (summaryM) {
      f.summary = summaryM[1].replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 500);
    }

    return f;
  }

  function _titleCase(str) {
    return str.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
  }

  return { parse };
})();
