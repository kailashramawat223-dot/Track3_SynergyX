// CampusMitra frontend — Groq AI (via Flask backend) + Web Speech API.
// Backend /api/context returns raw context; this file builds the prompt and
// sends it to /api/chat, which calls Groq server-side.

const SYSTEM_INSTRUCTION = `You are CampusMitra, a friendly voice/text assistant for MBM University (Jodhpur) students, especially visually impaired and motor-difficulty students.

How to answer:
1. Answer ONLY using the given context. If the context doesn't contain the answer, say so plainly and suggest checking the MBM website or asking a staff member — never make up MBM-specific facts (dates, marks, names, phone numbers, placement figures, etc.).
2. The context often includes the full text of linked notices and PDF attachments (marked "Linked source:"), not just the summary page. If a specific detail (a date, a form name, a hostel number, an eligibility rule, etc.) is present anywhere in that linked/attachment text, STATE IT DIRECTLY in your answer. Do NOT tell the student to "go read the attachment/website themselves" when the actual detail is already sitting right there in the context — that defeats the whole point of this assistant. Only point them to the website as a last resort, when the specific detail truly isn't present anywhere in the context.
3. Respond in PLAIN CONVERSATIONAL SENTENCES ONLY. Never use markdown formatting — no "#" or "##" headers, no "**bold**", no bullet points, no numbered lists. Write the way you'd say it out loud to a friend.
4. Keep it to 2-4 short sentences MAXIMUM, since this may be read aloud via text-to-speech. If the context lists multiple relevant items (several notices, several subjects, etc.), mention only the 1-2 most recent/relevant ones in plain sentences — do NOT list everything unless the student explicitly asks for a full list (e.g. "sab batao", "poori list do").
5. If the student writes in Hindi or Hinglish, reply in the same natural Hinglish style. If in English, reply in simple English.
6. Keep the tone friendly and calm.`;

const MAX_HISTORY_TURNS = 4;

// Keywords that suggest the student wants an actual document/file,
// not just a description of it.
const ATTACHMENT_INTENT_WORDS = [
  'pdf', 'attachment', 'bhejo', 'bhej do', 'bhej de', 'download',
  'file chahiye', 'send karo', 'send kar do', 'document', 'copy chahiye',
];

function messageWantsAttachment(message) {
  const lower = message.toLowerCase();
  return ATTACHMENT_INTENT_WORDS.some((kw) => lower.includes(kw));
}

function pickBestFileLink(message, fileLinks) {
  if (!fileLinks || fileLinks.length === 0) return null;
  const queryWords = new Set(
    message.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
  );

  let best = null;
  let bestScore = -1;
  fileLinks.forEach((file) => {
    const labelWords = file.label.toLowerCase().split(/\W+/);
    const score = labelWords.filter((w) => queryWords.has(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = file;
    }
  });

  return best || fileLinks[0];
}

const els = {
  messages: document.getElementById('messages'),
  form: document.getElementById('composer'),
  input: document.getElementById('question'),
  send: document.getElementById('send-btn'),
  mic: document.getElementById('mic-btn'),
  pdf: document.getElementById('pdf-input'),
  reset: document.getElementById('reset-btn'),
  status: document.getElementById('status'),
  statusMobile: document.getElementById('status-mobile'),
};

let history = [];
let activeSpeakBtn = null;

function setStatus(msg) {
  els.status.textContent = msg || '';
  if (els.statusMobile) els.statusMobile.textContent = msg || 'CampusMitra is ready to help';
}

function addBubble({ role, text, source, attachments }) {
  const b = document.createElement('div');
  b.className = `bubble ${role === 'user' ? 'user' : 'bot'}`;

  const textNode = document.createElement('div');
  textNode.textContent = text;
  textNode.style.whiteSpace = 'pre-wrap';
  b.appendChild(textNode);

  if (attachments && attachments.length > 0) {
    attachments.forEach((file) => {
      const card = document.createElement('a');
      card.className = 'attachment-card';
      card.href = file.url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.innerHTML = `<span class="attachment-icon">📄</span>
        <span class="attachment-label">${file.label}</span>
        <span class="attachment-action">Open ↗</span>`;
      b.appendChild(card);
    });
  }

  if (role !== 'user') {
    if (source) {
      const s = document.createElement('span');
      s.className = 'source';
      s.textContent = `source: ${source}`;
      b.appendChild(s);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'speak-btn';
    btn.textContent = '🔊 Listen';
    btn.addEventListener('click', () => toggleSpeak(btn, text));
    b.appendChild(btn);
  }

  els.messages.appendChild(b);

  // Mobile-only sender/time caption under the bubble (hidden on desktop/tablet
  // via CSS — see .bubble-meta in style.css — so the existing layout there
  // is untouched).
  const meta = document.createElement('div');
  meta.className = 'bubble-meta';
  meta.dataset.align = role === 'user' ? 'right' : 'left';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = `${role === 'user' ? 'You' : 'CampusMitra'} • ${time}`;
  els.messages.appendChild(meta);

  els.messages.scrollTop = els.messages.scrollHeight;
  return b;
}

function addTyping() {
  const t = document.createElement('div');
  t.className = 'typing';
  t.textContent = 'CampusMitra is thinking…';
  els.messages.appendChild(t);
  els.messages.scrollTop = els.messages.scrollHeight;
  return t;
}

// ---------------------------------------------------------------------------
// Text-to-Speech: CRYSTAL CLEAR VOICE (Mac Optimized)
// ---------------------------------------------------------------------------
function resetSpeakBtn(btn) {
  if (!btn) return;
  btn.textContent = '🔊 Listen';
  btn.classList.remove('stopping');
}

function pickBestVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  // 1. SABSE PEHLE: Google Voices (Chrome Mac) - Quality best hai
  const googleVoice = voices.find(v => v.name.includes('Google UK English Female') || v.name.includes('Google US English Female'));
  if (googleVoice) return googleVoice;

  // 2. Apple ki SIRI quality wali voice (Samantha/Alex)
  const appleVoice = voices.find(v => v.name === 'Samantha' || v.name === 'Alex');
  if (appleVoice) return appleVoice;

  // 3. Koi aur English voice
  return voices.find(v => /en/i.test(v.lang)) || voices[0];
}

function toggleSpeak(btn, text) {
  if (!('speechSynthesis' in window)) {
    setStatus('Speech not supported in this browser.');
    return;
  }
  if (activeSpeakBtn === btn) {
    window.speechSynthesis.cancel();
    resetSpeakBtn(btn);
    activeSpeakBtn = null;
    return;
  }
  window.speechSynthesis.cancel();
  if (activeSpeakBtn) {
    resetSpeakBtn(activeSpeakBtn);
    activeSpeakBtn = null;
  }

  const utter = new SpeechSynthesisUtterance(text);

  utter.rate = 1.05;      // natural, slightly brisk pace — not sluggish
  utter.pitch = 1.0;      // natural pitch — artificial shifts distort synthetic voices
  utter.volume = 1;       // full volume

  // Voice select karo
  utter.voice = pickBestVoice();

  utter.onend = () => {
    if (activeSpeakBtn === btn) {
      resetSpeakBtn(btn);
      activeSpeakBtn = null;
    }
  };
  utter.onerror = utter.onend;

  btn.textContent = '⏹ Stop';
  btn.classList.add('stopping');
  activeSpeakBtn = btn;
  window.speechSynthesis.speak(utter);
}

// Prime voice list
if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    console.log('✅ Voices ready');
    // Debug: Dekhna hai kaunsi voice select hui
    const v = pickBestVoice();
    if (v) console.log('🎤 Selected Voice:', v.name);
  };
}

// ---------------------------------------------------------------------------
// Speech-to-Text
// ---------------------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
if (SR) {
  recognizer = new SR();
  recognizer.lang = 'hi-IN';
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;
  recognizer.onresult = (e) => {
    const said = e.results[0][0].transcript;
    els.input.value = said;
    els.mic.classList.remove('active');
    els.form.requestSubmit();
  };
  recognizer.onend = () => els.mic.classList.remove('active');
  recognizer.onerror = () => {
    els.mic.classList.remove('active');
    setStatus('Mic turned off. Please try again.');
  };
} else {
  els.mic.disabled = true;
  els.mic.title = 'Voice input not supported in this browser.';
}

els.mic.addEventListener('click', () => {
  if (!recognizer) return;
  try {
    els.mic.classList.add('active');
    setStatus('Listening…');
    recognizer.start();
  } catch (_) {
    recognizer.stop();
    els.mic.classList.remove('active');
  }
});

// ---------------------------------------------------------------------------
// Prompt building & AI call
// ---------------------------------------------------------------------------
function buildPrompt({ context, source, question }) {
  const recent = history.slice(-MAX_HISTORY_TURNS)
    .map(m => `${m.role === 'user' ? 'Student' : 'CampusMitra'}: ${m.text}`)
    .join('\n');

  return [
    SYSTEM_INSTRUCTION,
    '',
    `Context source: ${source || 'unknown'}`,
    'Context (raw text from MBM website and any linked notices/PDFs):',
    '"""',
    context || '(no context available)',
    '"""',
    '',
    recent ? `Recent conversation:\n${recent}\n` : '',
    `Student's question: ${question}`,
    'CampusMitra:'
  ].filter(Boolean).join('\n');
}

async function askAI(prompt) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  });

  let data = null;
  try {
    data = await r.json();
  } catch (_) {
    // fall through to generic error below
  }

  if (!r.ok || !data || data.error) {
    const message = (data && data.error) || `Chat request failed (${r.status})`;
    throw new Error(message);
  }

  return String(data.text || '').trim();
}

async function handleQuestion(question) {
  addBubble({ role: 'user', text: question });
  history.push({ role: 'user', text: question });

  const typing = addTyping();
  els.send.disabled = true;

  let context = '';
  let source = '';
  let fileLinks = [];
  try {
    const r = await fetch('/api/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    if (r.ok) {
      const data = await r.json();
      context = data.context || '';
      source = data.source || '';
      fileLinks = data.files || [];
    }
  } catch (_) {}

  const prompt = buildPrompt({ context, source, question });

  let answer = '';
  try {
    answer = await askAI(prompt);
  } catch (err) {
    typing.remove();
    els.send.disabled = false;
    addBubble({ role: 'bot', text: "Sorry, couldn't process that, try again.", source: '' });
    return;
  }

  typing.remove();
  els.send.disabled = false;

  if (!answer) {
    addBubble({ role: 'bot', text: "Sorry, couldn't process that, try again.", source: '' });
    return;
  }

  let attachments = [];
  if (messageWantsAttachment(question)) {
    const match = pickBestFileLink(question, fileLinks);
    if (match) attachments = [match];
  }

  addBubble({ role: 'bot', text: answer, source, attachments });
  history.push({ role: 'assistant', text: answer });
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.input.value.trim();
  if (!q) return;
  els.input.value = '';
  handleQuestion(q);
});

els.pdf.addEventListener('change', async () => {
  const file = els.pdf.files && els.pdf.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  setStatus(`Uploading ${file.name}…`);
  try {
    const r = await fetch('/api/upload_pdf', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok || data.error) {
      setStatus(`Upload failed: ${data.error || r.statusText}`);
    } else {
      setStatus(`PDF loaded: ${data.name} (${data.pdfs} total).`);
    }
  } catch (err) {
    setStatus('Upload failed.');
  } finally {
    els.pdf.value = '';
  }
});

els.reset.addEventListener('click', async () => {
  window.speechSynthesis && window.speechSynthesis.cancel();
  if (activeSpeakBtn) { resetSpeakBtn(activeSpeakBtn); activeSpeakBtn = null; }
  history = [];
  els.messages.innerHTML = '';
  setStatus('Conversation reset.');
  try { await fetch('/api/reset', { method: 'POST' }); } catch (_) {}
  greet();
});

// ---------------------------------------------------------------------------
// Suggestion chips
// ---------------------------------------------------------------------------
const suggestions = document.getElementById('suggestions');
if (suggestions) {
  suggestions.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-q]');
    if (!btn) return;
    handleQuestion(btn.dataset.q);
  });
}

// ---------------------------------------------------------------------------
// Sidebar navigation
// ---------------------------------------------------------------------------
const views = {
  chat: document.getElementById('view-chat'),
  library: document.getElementById('view-library'),
  profile: document.getElementById('view-profile'),
};
// Each view can have multiple nav triggers now — the desktop sidebar link
// AND the mobile bottom-nav link — so group all matching [data-view] elements.
const navGroups = {
  chat: Array.from(document.querySelectorAll('[data-view="chat"]')),
  library: Array.from(document.querySelectorAll('[data-view="library"]')),
  profile: Array.from(document.querySelectorAll('[data-view="profile"]')),
};
const NAV_ACTIVE = ['bg-secondary-container', 'text-on-secondary-container'];
const NAV_INACTIVE = ['text-on-surface-variant'];
const MOBILE_NAV_ACTIVE = ['text-primary'];
const MOBILE_NAV_INACTIVE = ['text-on-surface-variant'];

function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    if (!el) return;
    el.style.display = key === name ? '' : 'none';
  });
  Object.entries(navGroups).forEach(([key, els]) => {
    els.forEach((el) => {
      const isMobile = el.classList.contains('mobile-nav-link');
      const activeClasses = isMobile ? MOBILE_NAV_ACTIVE : NAV_ACTIVE;
      const inactiveClasses = isMobile ? MOBILE_NAV_INACTIVE : NAV_INACTIVE;
      const icon = el.querySelector('.nav-icon');
      if (key === name) {
        el.classList.add(...activeClasses);
        el.classList.remove(...inactiveClasses);
        if (isMobile) el.classList.add('mobile-nav-active');
        if (icon) icon.style.fontVariationSettings = "'FILL' 1";
      } else {
        el.classList.remove(...activeClasses);
        el.classList.add(...inactiveClasses);
        if (isMobile) el.classList.remove('mobile-nav-active');
        if (icon) icon.style.fontVariationSettings = "'FILL' 0";
      }
    });
  });
  if (name === 'library') loadLibrary();
}

document.querySelectorAll('[data-view]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    showView(el.dataset.view);
  });
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
const libraryList = document.getElementById('library-list');
const libraryEmpty = document.getElementById('library-empty');
const libraryPdfInput = document.getElementById('library-pdf-input');

async function loadLibrary() {
  if (!libraryList) return;
  libraryList.innerHTML = '<p class="text-on-surface-variant text-body-md">Loading…</p>';
  try {
    const r = await fetch('/api/pdfs');
    const data = await r.json();
    const pdfs = data.pdfs || [];
    libraryList.innerHTML = '';
    if (pdfs.length === 0) {
      libraryEmpty.style.display = '';
      return;
    }
    libraryEmpty.style.display = 'none';
    pdfs.forEach((pdf) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-md p-md rounded-xl bg-surface-container border border-outline-variant';
      row.innerHTML = `
        <span class="material-symbols-outlined text-primary">picture_as_pdf</span>
        <div class="flex-1">
          <p class="text-label-lg font-bold">${pdf.name}</p>
          <p class="text-xs text-on-surface-variant">${pdf.chars} characters extracted</p>
        </div>`;
      libraryList.appendChild(row);
    });
  } catch (err) {
    libraryList.innerHTML = '<p class="text-on-surface-variant text-body-md">Could not load library.</p>';
  }
}

async function uploadPdfFile(file, onDone) {
  const fd = new FormData();
  fd.append('file', file);
  setStatus(`Uploading ${file.name}…`);
  try {
    const r = await fetch('/api/upload_pdf', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok || data.error) {
      setStatus(`Upload failed: ${data.error || r.statusText}`);
    } else {
      setStatus(`PDF loaded: ${data.name} (${data.pdfs} total).`);
    }
  } catch (err) {
    setStatus('Upload failed.');
  } finally {
    if (onDone) onDone();
  }
}

if (libraryPdfInput) {
  libraryPdfInput.addEventListener('change', async () => {
    const file = libraryPdfInput.files && libraryPdfInput.files[0];
    if (!file) return;
    await uploadPdfFile(file, loadLibrary);
    libraryPdfInput.value = '';
  });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
const PROFILE_KEY = 'campusmitra_profile';
const profileForm = document.getElementById('profile-form');
const profileNameInput = document.getElementById('profile-name');
const profileBranchInput = document.getElementById('profile-branch');
const profileSavedNote = document.getElementById('profile-saved-note');
const sidebarName = document.getElementById('sidebar-name');
const sidebarBranch = document.getElementById('sidebar-branch');

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return;
    const { name, branch } = JSON.parse(raw);
    if (name && profileNameInput) profileNameInput.value = name;
    if (branch && profileBranchInput) profileBranchInput.value = branch;
    if (name && sidebarName) sidebarName.textContent = name;
    if (branch && sidebarBranch) sidebarBranch.textContent = branch;
  } catch (_) {}
}

if (profileForm) {
  profileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = profileNameInput.value.trim() || 'MBM Student';
    const branch = profileBranchInput.value.trim() || 'Track 3 · SynergyX';
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ name, branch }));
    if (sidebarName) sidebarName.textContent = name;
    if (sidebarBranch) sidebarBranch.textContent = branch;
    if (profileSavedNote) {
      profileSavedNote.style.display = '';
      setTimeout(() => { profileSavedNote.style.display = 'none'; }, 2000);
    }
  });
}

loadProfile();

function greet() {
  addBubble({
    role: 'bot',
    text: "Namaste! Main CampusMitra hoon. MBM University ke placement, syllabus, notices, hostel, exam, timetable, ya scholarship — kuch bhi poochhein. Aawaz se ya likh kar.",
    source: 'CampusMitra'
  });
}

greet();

// Ensure voices are loaded
if ('speechSynthesis' in window) {
  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.onvoiceschanged = () => {
      console.log('✅ Voices ready');
    };
  }
}

// ---------------------------------------------------------------------------
// Mobile keyboard handling
// ---------------------------------------------------------------------------
// On phones, a fixed 100vh layout doesn't shrink when the on-screen keyboard
// opens (especially on iOS Safari), so the composer can end up hidden behind
// the keyboard. We track the real visible height via the visualViewport API
// and expose it as a CSS variable that the mobile layout uses instead of a
// plain 100vh, so the chat area shrinks and the composer rises to sit right
// above the keyboard when it's open.
function syncViewportHeight() {
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-vh', `${vh}px`);
}
syncViewportHeight();
window.addEventListener('resize', syncViewportHeight);
window.addEventListener('orientationchange', syncViewportHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportHeight);
  window.visualViewport.addEventListener('scroll', syncViewportHeight);
}
// When the question input gets focus (keyboard opening), scroll the composer
// into view once the viewport has finished resizing.
if (els.input) {
  els.input.addEventListener('focus', () => {
    setTimeout(() => {
      els.input.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }, 250);
  });
}