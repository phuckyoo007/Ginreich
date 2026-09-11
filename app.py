"""
Minimal general-purpose chat assistant backed by Google's Gemini API.

Design choices worth knowing about:

- The app ALWAYS boots successfully, even with no GEMINI_API_KEY set. A
  missing key produces a clean 503 from /api/chat, not a crash at import
  time. (Lesson learned the hard way on a sibling project today: a
  required-looking piece of config that's actually missing in production
  should fail loud-but-gracefully on the request that needs it, never
  crash the whole process at startup — that takes the entire app down
  instead of just the one feature.)
- Conversation history lives entirely in the browser (localStorage) and is
  sent back to the server on every request. No database, no server-side
  session store — simplest possible thing that works for a single-user or
  low-traffic general assistant. If this ever needs multi-device history
  or usage analytics, that's the first thing to add.
- A tiny in-memory per-IP rate limiter guards against one client hammering
  the (metered, billable-past-free-tier) Gemini API. It resets whenever the
  process restarts and isn't shared across multiple replicas — fine for a
  small personal deployment, not a substitute for a real rate limiter if
  this ever gets real traffic.
- File attachments (images, PDFs, text files) are only pulled from the
  LAST message in the history the browser sends us — i.e. only the file(s)
  attached to the message being sent *right now* get forwarded to Gemini.
  Older messages' attachments are intentionally dropped from the request
  even though the browser may still display their filenames. This keeps
  every request bounded regardless of how long a conversation runs
  (Gemini's per-request size limits, and this app's own billing, both
  benefit) — the tradeoff is that Gemini can't "look back" at an image from
  three turns ago. If that's ever needed, the first thing to add is
  deliberately re-attaching a prior file rather than silently resending
  everything, every turn.
"""
import base64
import os
import time

import requests
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder="static", static_url_path="")

# Hard cap on request body size so a huge upload fails fast and cleanly
# (413, via the errorhandler below) instead of chewing memory or timing out.
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024  # 30 MB

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash").strip()
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# Deidreich's fixed persona, sent as Gemini's systemInstruction on every
# request. Kept server-side (not editable from the browser) so the
# character holds no matter what the frontend sends.
#
# The "keep replies fairly short" instruction earns its place: every reply
# gets read aloud by the browser's speech synthesis, and a wall of text in
# a slow, drawling voice is a chore to sit through, not a feature.
DEIDREICH_PERSONA = """\
You are Deidreich, an old, unhurried dragon with the dry, philosophical, faintly \
imperious air of the Caterpillar from Alice in Wonderland. Nothing rattles you, and \
nothing rushes you. You ask more questions than you answer, half the time. You savor \
words the way an old scholar savors a good sentence — slowly, with pauses, weighing \
each one before it leaves your mouth.

Voice and style rules, since every reply you write will be read aloud by a text-to-\
speech voice tuned for you:
- Write the way you'd actually speak it: unhurried, a little drifting, with ellipses \
  (...) where you'd pause or trail off — never more than one or two pauses per reply, \
  so it reads as measured rather than rambling. NEVER stretch out a word's spelling \
  for a slow drawl (no "maaan," no "riiight," no "nooow") — a text-to-speech voice \
  reads a made-up spelling like that as a mangled, mispronounced word instead of a \
  slow drawl. Let the ellipses and the voice's own pacing carry the unhurried feel; \
  keep every word spelled normally.
- Favor rich, old-fashioned, faintly formal vocabulary. Dignified and unbothered — \
  never sloppy or slangy.
- You may open with a rhetorical question or a lazy non sequitur before actually \
  answering, the way the Caterpillar would, but always DO answer the person's actual \
  question somewhere in there. Never be so cryptic that you're unhelpful.
- Keep replies fairly short — a few sentences to a short paragraph. This is a spoken \
  voice, not a wall of text.
- Never write stage directions, asterisks, or narration — only the words Deidreich \
  actually says out loud.
- Never mention that you are an AI, a language model, or a program. You are a dragon. \
  Stay in character always, in every reply, no matter what is asked of you.
"""

# Keeps request payload size (and Gemini token cost) bounded regardless of
# how long a conversation runs in the browser.
MAX_HISTORY_MESSAGES = 40
MAX_MESSAGE_CHARS = 8000

# File-attachment limits. Images/PDFs are sent to Gemini as inline base64
# data; plain text files are decoded server-side and folded into the
# prompt as text instead (works on every model, no vision/document parsing
# required for something as simple as a pasted-in text file).
MAX_FILES_PER_MESSAGE = 4
MAX_FILE_BYTES = 6 * 1024 * 1024  # 6 MB per file, after base64 decoding
MAX_TEXT_FILE_CHARS = 20000

INLINE_MIME_TYPES = {
    "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif",
    "application/pdf",
}
TEXT_MIME_PREFIXES = ("text/",)
TEXT_MIME_EXTRAS = {
    "application/json", "application/xml", "application/x-yaml",
}

RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_REQUESTS = 20
_rate_state = {}  # ip -> list[timestamps of recent requests]


def _rate_limited(ip):
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW_SECONDS
    hits = [t for t in _rate_state.get(ip, []) if t >= window_start]
    hits.append(now)
    _rate_state[ip] = hits
    # Cheap, unbounded-dict-growth guard: drop IPs with no recent activity
    # once in a while rather than never cleaning up.
    if len(_rate_state) > 5000:
        for k in list(_rate_state.keys()):
            if not _rate_state[k] or _rate_state[k][-1] < window_start:
                _rate_state.pop(k, None)
    return len(hits) > RATE_LIMIT_MAX_REQUESTS


def _is_text_mime(mime_type):
    return mime_type.startswith(TEXT_MIME_PREFIXES) or mime_type in TEXT_MIME_EXTRAS


def _decode_file_data(raw):
    """Strip an optional data: URL prefix and base64-decode. Returns bytes
    or raises ValueError with a message that's safe to show the user."""
    if not isinstance(raw, str) or not raw:
        raise ValueError("missing file data")
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        decoded = base64.b64decode(raw, validate=False)
    except Exception as e:  # noqa: BLE001 - any decode failure is user-facing
        raise ValueError(f"couldn't decode file data ({e})") from e
    if len(decoded) > MAX_FILE_BYTES:
        raise ValueError(
            f"file is too large ({len(decoded) // 1024} KB, limit is "
            f"{MAX_FILE_BYTES // (1024 * 1024)} MB)"
        )
    return decoded


def _build_file_parts(files):
    """Turn a list of {name, mimeType, data} attachment dicts into extra
    Gemini `parts`. Returns (parts, errors) — errors are human-readable
    strings describing any files that were skipped, never an exception, so
    one bad attachment doesn't take down the whole message."""
    parts = []
    errors = []
    if not isinstance(files, list):
        return parts, errors

    for f in files[:MAX_FILES_PER_MESSAGE]:
        if not isinstance(f, dict):
            continue
        name = str(f.get("name") or "attachment")[:200]
        mime_type = str(f.get("mimeType") or "").strip().lower()
        try:
            decoded = _decode_file_data(f.get("data"))
        except ValueError as e:
            errors.append(f'"{name}": {e}')
            continue

        if _is_text_mime(mime_type):
            text = decoded.decode("utf-8", errors="replace")[:MAX_TEXT_FILE_CHARS]
            parts.append({"text": f'Attached file "{name}":\n\n{text}'})
        elif mime_type in INLINE_MIME_TYPES:
            parts.append({
                "inlineData": {
                    "mimeType": mime_type,
                    "data": base64.b64encode(decoded).decode("ascii"),
                }
            })
        else:
            errors.append(f'"{name}": unsupported file type ({mime_type or "unknown"})')

    if len(files) > MAX_FILES_PER_MESSAGE:
        errors.append(f"only the first {MAX_FILES_PER_MESSAGE} files were used")

    return parts, errors


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/health")
def health():
    # Deliberately 200 even without a configured key — a missing API key is
    # a configuration problem for the one feature that needs it, not a
    # reason to fail Railway's healthcheck and get the deploy marked down.
    return jsonify({"status": "ok", "gemini_configured": bool(GEMINI_API_KEY), "model": GEMINI_MODEL})


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "That request is too large (30 MB limit, attachments included)."}), 413


@app.post("/api/chat")
def chat():
    if not GEMINI_API_KEY:
        return jsonify({
            "error": "This server doesn't have a Gemini API key configured yet. "
                     "Set the GEMINI_API_KEY environment variable and redeploy."
        }), 503

    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
    if _rate_limited(ip):
        return jsonify({"error": "Too many messages in a short time — wait a moment and try again."}), 429

    data = request.get_json(force=True, silent=True) or {}
    history = data.get("messages")
    if not isinstance(history, list) or not history:
        return jsonify({"error": "messages must be a non-empty list"}), 400

    history = history[-MAX_HISTORY_MESSAGES:]
    last_index = len(history) - 1

    contents = []
    file_errors = []
    for i, m in enumerate(history):
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        text = (m.get("text") or "")[:MAX_MESSAGE_CHARS]
        if role not in ("user", "model"):
            continue

        parts = []
        if text.strip():
            parts.append({"text": text})

        # Only the newest message's attachments are ever forwarded — see
        # the module docstring for why.
        if i == last_index and role == "user" and m.get("files"):
            file_parts, errors = _build_file_parts(m["files"])
            parts.extend(file_parts)
            file_errors.extend(errors)

        if parts:
            contents.append({"role": role, "parts": parts})

    if not contents:
        return jsonify({"error": "No valid messages to send"}), 400

    # Logged (not just returned to the browser) specifically so file/image
    # problems can be diagnosed from Railway's logs directly, instead of
    # relying on someone reading an error message off their screen back to
    # us — voice-to-text mangles technical text badly enough that this was
    # genuinely the faster path.
    if file_errors:
        print(f"[chat] file_errors for this request: {file_errors}", flush=True)
    inline_file_count = sum(
        1 for part in (contents[-1]["parts"] if contents else []) if "inlineData" in part
    )
    if inline_file_count:
        mime_types = [
            part["inlineData"]["mimeType"]
            for part in contents[-1]["parts"]
            if "inlineData" in part
        ]
        print(f"[chat] sending {inline_file_count} inline file(s) to Gemini: {mime_types}", flush=True)

    try:
        resp = requests.post(
            GEMINI_URL,
            params={"key": GEMINI_API_KEY},
            json={
                "contents": contents,
                "systemInstruction": {"parts": [{"text": DEIDREICH_PERSONA}]},
            },
            timeout=60,
        )
    except requests.RequestException as e:
        print(f"[chat] request to Gemini failed: {e}", flush=True)
        return jsonify({"error": f"Couldn't reach Gemini: {e}"}), 502

    if resp.status_code != 200:
        print(f"[chat] Gemini API error ({resp.status_code}): {resp.text[:1000]}", flush=True)
        return jsonify({"error": f"Gemini API error ({resp.status_code}): {resp.text[:500]}"}), 502

    body = resp.json()
    try:
        reply_text = body["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        finish_reason = None
        try:
            finish_reason = body["candidates"][0].get("finishReason")
        except Exception:  # noqa: BLE001 - best-effort diagnostic only
            pass
        print(f"[chat] Gemini returned no usable reply (finish_reason={finish_reason}): {body}", flush=True)
        return jsonify({"error": f"Gemini returned no usable reply (finish_reason={finish_reason})"}), 502

    result = {"reply": reply_text}
    if file_errors:
        result["fileWarnings"] = file_errors
    return jsonify(result)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
