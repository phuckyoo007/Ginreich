const chatEl = document.getElementById('chat');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('input');
const errorEl = document.getElementById('error');
const clearBtn = document.getElementById('clear-btn');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const attachmentsEl = document.getElementById('attachments');
const micBtn = document.getElementById('mic-btn');
const voiceBtn = document.getElementById('voice-btn');
const voiceStyleSelect = document.getElementById('voice-style-select');
const emblemEl = document.getElementById('emblem');

const STORAGE_KEY = 'gemini-assistant-history';
const VOICE_PREF_KEY = 'deidreich-voice-enabled';

// Client-side mirrors of the server's limits in app.py — kept in sync by
// hand since this is a two-file app with no shared config. Catching an
// oversized/over-count attachment here means a friendlier, instant error
// instead of waiting on a round trip just to get the same rejection back.
const MAX_FILES = 4;
const MAX_FILE_BYTES = 6 * 1024 * 1024;

let history = [];
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) history = JSON.parse(saved);
} catch (e) {
  // Corrupt or unavailable storage — just start fresh.
  history = [];
}

// Files attached to the message currently being composed (not yet sent).
// Each entry is {name, mimeType, size, data} where data is base64 with no
// "data:...;base64," prefix.
let pendingFiles = [];

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderAttachmentPreview(f) {
  if (f.mimeType && f.mimeType.startsWith('image/') && f.data) {
    return `<img class="attachment-thumb" src="data:${f.mimeType};base64,${f.data}" alt="${escapeHtml(f.name)}">`;
  }
  return `<span class="attachment-chip">📎 ${escapeHtml(f.name)}</span>`;
}

function render() {
  chatEl.innerHTML = history.map((m, i) => {
    const textHtml = m.text ? escapeHtml(m.text).replace(/\n/g, '<br>') : '';
    const filesHtml = (m.files && m.files.length)
      ? `<div class="msg-attachments">${m.files.map(renderAttachmentPreview).join('')}</div>`
      : '';
    // A little "hear it again" control on Deidreich's own lines, since the
    // whole point of this character is the voice — you should be able to
    // replay a line without re-asking the question.
    const replayHtml = (m.role === 'model' && m.text)
      ? `<button type="button" class="replay-btn" data-replay-index="${i}">🔊 Replay</button>`
      : '';
    return `
      <div class="msg ${m.role === 'user' ? 'user' : 'model'}">
        <div class="bubble">${filesHtml}${textHtml}${replayHtml ? `<div>${replayHtml}</div>` : ''}</div>
      </div>
    `;
  }).join('') || `<p class="muted empty-hint">Say hello to get started.</p>`;
  chatEl.scrollTop = chatEl.scrollHeight;
}

function save() {
  try {
    // Persist attachment metadata (name/type/size) but never the base64
    // payload — otherwise a handful of image-heavy conversations would
    // blow through localStorage's ~5-10MB quota. The tradeoff: thumbnails
    // stay visible for the rest of this session but are gone after a
    // reload, leaving just a "📎 filename" chip. That's consistent with
    // this app's whole approach to history (see app.py's docstring) —
    // simplest thing that works, not full fidelity forever.
    const trimmed = history.map(m => m.files
      ? { ...m, files: m.files.map(f => ({ name: f.name, mimeType: f.mimeType, size: f.size })) }
      : m);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    // Storage full or blocked — conversation just won't persist across reloads.
  }
}

function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = 'block';
}

function renderAttachments() {
  if (!pendingFiles.length) {
    attachmentsEl.style.display = 'none';
    attachmentsEl.innerHTML = '';
    return;
  }
  attachmentsEl.style.display = 'flex';
  attachmentsEl.innerHTML = pendingFiles.map((f, i) => `
    <span class="chip">
      <span class="chip-name">📎 ${escapeHtml(f.name)}</span>
      <button type="button" class="chip-remove" data-index="${i}" aria-label="Remove ${escapeHtml(f.name)}">&times;</button>
    </span>
  `).join('');
}

render();

// ---- Voice output (Deidreich speaking his replies aloud) ----
// Uses the browser's native SpeechSynthesis (Web Speech API) — no server
// involvement, nothing leaves the device for this. Tuned slow and low to
// land somewhere between "ancient dragon" and "hasn't been in a hurry
// since the Clinton administration." Support is broad (Chrome, Edge,
// Safari) but voice lists and quality vary a lot by OS/browser, so this
// degrades gracefully: if speech synthesis isn't available at all, the
// voice toggle just quietly disables itself rather than pretending to work.
const synth = window.speechSynthesis;
let voiceEnabled = true;
try {
  const saved = localStorage.getItem(VOICE_PREF_KEY);
  if (saved !== null) voiceEnabled = saved === 'true';
} catch (e) {
  // Storage unavailable — default to on.
}

// A handful of named presets — rate/pitch tuning plus a gender + accent hint
// used to pick an actual different underlying browser voice, not just the
// same voice sped up or slowed down. Real voice availability varies a lot
// by OS/browser, so each hint is best-effort with graceful fallback (see
// pickVoiceForStyle below) rather than a guarantee of an exact match.
const VOICE_STYLES = {
  smooth: { label: 'Smooth & Flowing', rate: 1.02, pitch: 0.95, gender: 'male', accent: 'us' },
  original: { label: 'Deep & Slow (original)', rate: 0.78, pitch: 0.55, gender: 'male', accent: 'us' },
  deep: { label: 'Deep Growl', rate: 0.68, pitch: 0.45, gender: 'male', accent: 'us' },
  sage: { label: 'Old Sage (British)', rate: 0.78, pitch: 0.8, gender: 'male', accent: 'gb' },
  bright: { label: 'Bright & Quick', rate: 1.15, pitch: 1.05, gender: 'male', accent: 'us' },
  warmFemale: { label: 'Warm Female (US)', rate: 0.92, pitch: 1.05, gender: 'female', accent: 'us' },
  refinedFemale: { label: 'Refined Female (British)', rate: 0.88, pitch: 1.0, gender: 'female', accent: 'gb' },
  aussie: { label: 'Australian', rate: 0.95, pitch: 0.95, gender: 'male', accent: 'au' },
};
const VOICE_STYLE_KEY = 'deidreich-voice-style';
let voiceStyle = 'smooth';
try {
  const savedStyle = localStorage.getItem(VOICE_STYLE_KEY);
  if (savedStyle && VOICE_STYLES[savedStyle]) voiceStyle = savedStyle;
} catch (e) {
  // Storage unavailable — default stands.
}

function currentVoiceStyle() {
  return VOICE_STYLES[voiceStyle] || VOICE_STYLES.smooth;
}

if (voiceStyleSelect) {
  voiceStyleSelect.innerHTML = Object.entries(VOICE_STYLES)
    .map(([key, s]) => `<option value="${key}">${escapeHtml(s.label)}</option>`)
    .join('');
  voiceStyleSelect.value = voiceStyle;
  voiceStyleSelect.addEventListener('change', () => {
    voiceStyle = voiceStyleSelect.value;
    try { localStorage.setItem(VOICE_STYLE_KEY, voiceStyle); } catch (e) { /* ignore */ }
  });
}

let voicesReady = false;
// Per-style voice picks, memoized so we don't re-scan the voice list on
// every single utterance — cleared whenever the browser's voice list
// changes (e.g. it finishes loading asynchronously after page load).
let voiceCache = {};

// No standard "gender" or "accent" field exists on SpeechSynthesisVoice, so
// both are best-effort name/lang matches against the voice names browsers
// and operating systems commonly ship (Windows SAPI voices, Chrome's
// "Google ..." voices, macOS/iOS voices, etc.) — not a guarantee every
// browser has a match for every style.
const FEMALE_NAME_PATTERN = /female|zira|hazel|susan|catherine|karen|samantha|victoria|tessa|serena|fiona|moira|kate|amy|emma|joanna|salli|kimberly|ivy|allison|linda|heather|sonia|shelley/i;
const MALE_NAME_PATTERN = /male|daniel|fred|albert|arthur|david|alex|guy|gordon|oliver|thomas|rishi|eddy|mark|george|james|ravi|sean|matthew/i;
const ACCENT_LANG_PATTERN = { us: /^en-US/i, gb: /^en-GB/i, au: /^en-AU/i };
const ACCENT_NAME_PATTERN = { us: /US|America/i, gb: /UK|Britain|British|England/i, au: /Australia/i };

function filterByGender(voices, gender) {
  const pattern = gender === 'female' ? FEMALE_NAME_PATTERN : MALE_NAME_PATTERN;
  return voices.filter(v => pattern.test(v.name));
}

function filterByAccent(voices, accent) {
  const langPattern = ACCENT_LANG_PATTERN[accent];
  const namePattern = ACCENT_NAME_PATTERN[accent];
  return voices.filter(v =>
    (langPattern && langPattern.test(v.lang)) || (namePattern && namePattern.test(v.name)));
}

// Chrome ships cloud-quality "Google ..." voices, and Edge ships neural
// "... Online (Natural)" ones — both sound like an actual person. Left
// unguarded, a name match like MALE_NAME_PATTERN happily matches "Microsoft
// David Desktop," an old robotic SAPI voice, before it ever considers a
// much better-sounding "Google US English." So we always exhaust the
// higher-quality pool first, at every match tier, before touching the
// old-school system voices at all.
const HIGH_QUALITY_NAME_PATTERN = /Google|Natural|Neural|Online/i;

function pickVoiceForStyle(style) {
  const voices = synth.getVoices();
  if (!voices.length) return null;
  const englishVoices = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
  const pool = englishVoices.length ? englishVoices : voices;

  const highQuality = pool.filter(v => HIGH_QUALITY_NAME_PATTERN.test(v.name));
  const standard = pool.filter(v => !HIGH_QUALITY_NAME_PATTERN.test(v.name));

  const tiers = [
    () => filterByGender(filterByAccent(highQuality, style.accent), style.gender),
    () => filterByAccent(highQuality, style.accent),
    () => filterByGender(highQuality, style.gender),
    () => highQuality,
    () => filterByGender(filterByAccent(standard, style.accent), style.gender),
    () => filterByGender(standard, style.gender),
    () => filterByAccent(standard, style.accent),
    () => standard,
  ];
  for (const tier of tiers) {
    const candidates = tier();
    if (candidates.length) return candidates[0];
  }
  return pool[0] || null;
}

function getVoiceForCurrentStyle() {
  if (!voiceCache[voiceStyle]) {
    voiceCache[voiceStyle] = pickVoiceForStyle(currentVoiceStyle());
  }
  return voiceCache[voiceStyle];
}

function ensureVoicesLoaded() {
  if (voicesReady) return;
  if (synth.getVoices().length) voicesReady = true;
}

if (synth) {
  ensureVoicesLoaded();
  synth.addEventListener('voiceschanged', () => {
    voicesReady = false;
    voiceCache = {};
    ensureVoicesLoaded();
  });
}

function setSpeakingUI(isSpeaking) {
  emblemEl.classList.toggle('speaking', isSpeaking);
}

function speak(text) {
  if (!synth || !voiceEnabled || !text || !text.trim()) return;
  synth.cancel(); // never overlap two lines
  const utter = new SpeechSynthesisUtterance(text);
  ensureVoicesLoaded();
  const style = currentVoiceStyle();
  const voice = getVoiceForCurrentStyle();
  if (voice) utter.voice = voice;
  // Rate/pitch come from whichever style is selected in the dropdown —
  // the actual character still comes as much from how app.py writes the
  // text as from these two numbers.
  utter.rate = style.rate;
  utter.pitch = style.pitch;
  utter.volume = 1;
  utter.onstart = () => setSpeakingUI(true);
  utter.onend = () => setSpeakingUI(false);
  utter.onerror = () => setSpeakingUI(false);
  synth.speak(utter);
}

function updateVoiceBtn() {
  if (!synth) {
    voiceBtn.disabled = true;
    voiceBtn.textContent = '🔇 Voice unsupported';
    voiceBtn.title = "This browser doesn't support spoken replies";
    return;
  }
  voiceBtn.textContent = voiceEnabled ? '🔊 Voice on' : '🔇 Voice off';
  voiceBtn.classList.toggle('voice-on', voiceEnabled);
  voiceBtn.classList.toggle('voice-off', !voiceEnabled);
}
updateVoiceBtn();

voiceBtn.addEventListener('click', () => {
  voiceEnabled = !voiceEnabled;
  try { localStorage.setItem(VOICE_PREF_KEY, String(voiceEnabled)); } catch (e) { /* ignore */ }
  if (!voiceEnabled && synth) {
    synth.cancel();
    setSpeakingUI(false);
  }
  updateVoiceBtn();
});

// Replay button on any of Deidreich's past lines.
chatEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.replay-btn');
  if (!btn) return;
  const idx = Number(btn.dataset.replayIndex);
  const msg = history[idx];
  if (msg && msg.text) {
    // Replaying is an explicit request to hear it — do it even if the
    // ambient voice toggle is currently off, then leave the toggle as-is.
    if (!synth) return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(msg.text);
    const style = currentVoiceStyle();
    const voice = getVoiceForCurrentStyle();
    if (voice) utter.voice = voice;
    utter.rate = style.rate;
    utter.pitch = style.pitch;
    utter.onstart = () => setSpeakingUI(true);
    utter.onend = () => setSpeakingUI(false);
    utter.onerror = () => setSpeakingUI(false);
    synth.speak(utter);
  }
});

// ---- File attachments ----

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = ''; // allow re-selecting the same file again later
  const room = MAX_FILES - pendingFiles.length;
  if (room <= 0) {
    showError(`You can attach up to ${MAX_FILES} files per message.`);
    return;
  }

  for (const file of files.slice(0, room)) {
    if (file.size > MAX_FILE_BYTES) {
      showError(`"${file.name}" is too large (limit ${MAX_FILE_BYTES / (1024 * 1024)} MB).`);
      continue;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        reader.readAsDataURL(file);
      });
      pendingFiles.push({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
      });
    } catch (e) {
      showError(`Couldn't read "${file.name}".`);
    }
  }
  if (files.length > room) {
    showError(`Only the first ${room} file(s) were attached (${MAX_FILES}-file limit per message).`);
  }
  renderAttachments();
});

attachmentsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip-remove');
  if (!btn) return;
  pendingFiles.splice(Number(btn.dataset.index), 1);
  renderAttachments();
});

// ---- Sending a message ----

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text && !pendingFiles.length) return;

  errorEl.style.display = 'none';
  const message = { role: 'user', text };
  if (pendingFiles.length) message.files = pendingFiles;
  history.push(message);
  pendingFiles = [];
  renderAttachments();
  render();
  save();
  inputEl.value = '';
  autoResize();
  inputEl.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    history.push({ role: 'model', text: body.reply });
    render();
    save();
    speak(body.reply);
    if (body.fileWarnings && body.fileWarnings.length) {
      showError(`Note: ${body.fileWarnings.join('; ')}`);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    inputEl.disabled = false;
    inputEl.focus();
  }
});

inputEl.addEventListener('input', autoResize);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

clearBtn.addEventListener('click', () => {
  if (history.length && !confirm('Clear this conversation?')) return;
  if (synth) { synth.cancel(); setSpeakingUI(false); }
  history = [];
  pendingFiles = [];
  renderAttachments();
  save();
  render();
});

// ---- Voice-to-text ----
// Uses the browser's native SpeechRecognition (Web Speech API). No server
// involvement — audio never leaves the device via this app; the browser
// itself sends it to its speech-to-text backend (this is a browser
// platform feature, not something Deidreich implements). Support varies:
// solid in Chrome/Edge, absent in Firefox and most non-Safari mobile
// browsers as of 2026, so the button quietly disables itself rather than
// pretending to work.
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionCtor) {
  micBtn.disabled = true;
  micBtn.title = "Voice input isn't supported in this browser";
} else {
  const recognizer = new SpeechRecognitionCtor();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;
  let recording = false;

  // The original bug report ("I click it and nothing happens") turned out
  // to be this: recognition WAS starting, but the only feedback was a thin
  // border-color change on a small icon — easy to miss entirely. Recording
  // state now changes three things at once (icon glyph, button fill color,
  // and the input's own placeholder text) so it's unmistakable even at a
  // glance, not just on close inspection.
  const MIC_IDLE_ICON = '🎤';
  const MIC_RECORDING_ICON = '⏹';
  const MIC_IDLE_TITLE = 'Speak your message';
  const MIC_RECORDING_TITLE = 'Listening… click to stop';
  const originalPlaceholder = inputEl.placeholder;

  function setRecordingUI(isRecording) {
    recording = isRecording;
    micBtn.classList.toggle('recording', isRecording);
    micBtn.textContent = isRecording ? MIC_RECORDING_ICON : MIC_IDLE_ICON;
    micBtn.title = isRecording ? MIC_RECORDING_TITLE : MIC_IDLE_TITLE;
    inputEl.placeholder = isRecording ? '🔴 Listening… speak now' : originalPlaceholder;
  }

  recognizer.addEventListener('result', (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join(' ').trim();
    if (transcript) {
      inputEl.value = inputEl.value.trim() ? `${inputEl.value.trim()} ${transcript}` : transcript;
      autoResize();
      inputEl.focus();
    }
  });
  recognizer.addEventListener('end', () => setRecordingUI(false));
  recognizer.addEventListener('error', (e) => {
    setRecordingUI(false);
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      showError(`Voice input error: ${e.error}`);
    }
  });

  micBtn.addEventListener('click', () => {
    if (recording) {
      recognizer.stop();
      return;
    }
    if (synth) { synth.cancel(); setSpeakingUI(false); }
    errorEl.style.display = 'none';
    try {
      recognizer.start();
      setRecordingUI(true);
    } catch (e) {
      // start() throws synchronously in a couple of real cases: a session
      // is already active (harmless — the button's own state should have
      // prevented this, but browsers vary), or the browser/OS/enterprise
      // policy is blocking microphone access outright (NotAllowedError /
      // SecurityError), which is exactly the kind of failure that used to
      // vanish silently here. Only the "already running" case is safe to
      // swallow; everything else needs to reach the person clicking the
      // button, or a real problem looks identical to a missing feature.
      if (e && e.name !== 'InvalidStateError') {
        showError(`Couldn't start voice input: ${e.message || e.name || e}`);
      }
    }
  });

  // Some browsers/policies block microphone access without recognizer.start()
  // ever throwing — the request just sits there and 'error' or 'end' never
  // fires either. If neither happened within a few seconds of a click, say
  // so instead of leaving the mic looking permanently "listening".
  micBtn.addEventListener('click', () => {
    if (!recording) return;
    setTimeout(() => {
      if (recording && micBtn.classList.contains('recording')) {
        showError(
          "Voice input isn't responding — check that this site has microphone " +
          "permission (click the 🔒 icon in the address bar), and that no " +
          "browser or device policy is blocking microphone access."
        );
      }
    }, 4000);
  });
}
