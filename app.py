"""
A small chatbot server — runs locally or deployed (e.g. on Railway).

Serves a single-page chat UI and proxies chat requests to OpenAI's API.
The API key lives only in this server process (from an environment
variable) — it is never sent to the browser.

If ACCESS_PASSWORD is set, /api/chat requires it (as a header from the
frontend's login prompt) — important once this is deployed somewhere
public, since anyone who finds the URL would otherwise be spending your
OpenAI credits.
"""
import os
import time
import threading
import requests
from flask import Flask, request, jsonify, send_from_directory
from dotenv import load_dotenv

load_dotenv()  # no-op if there's no .env file (e.g. on Railway, where you set real env vars instead)

app = Flask(__name__, static_folder="static", static_url_path="")

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
MODEL = os.environ.get("MODEL", "gpt-4o-mini").strip()
SYSTEM_PROMPT = os.environ.get(
    "SYSTEM_PROMPT",
    "You are a helpful, friendly personal assistant. Keep answers concise unless asked for detail."
).strip()
ACCESS_PASSWORD = os.environ.get("ACCESS_PASSWORD", "").strip()
RATE_LIMIT_PER_HOUR = int(os.environ.get("RATE_LIMIT_PER_HOUR", "100"))

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"

# ---- simple in-memory rate limiter ----------------------------------
# A best-effort cost guard, not a security feature: it resets on restart
# and only works correctly with a single worker process (see Procfile).
# For a personal single-user bot that's a fine trade for zero extra
# infrastructure; swap in Redis if this ever needs to scale past one dyno.
_request_times = []
_rate_lock = threading.Lock()


def _rate_limited():
    now = time.time()
    with _rate_lock:
        cutoff = now - 3600
        while _request_times and _request_times[0] < cutoff:
            _request_times.pop(0)
        if len(_request_times) >= RATE_LIMIT_PER_HOUR:
            return True
        _request_times.append(now)
        return False


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/health")
def health():
    """Lets the frontend show a setup banner or a password prompt up
    front, instead of a confusing failed request on the first message."""
    return jsonify({
        "configured": bool(OPENAI_API_KEY),
        "model": MODEL,
        "passwordRequired": bool(ACCESS_PASSWORD),
    })


@app.post("/api/chat")
def chat():
    if ACCESS_PASSWORD:
        supplied = request.headers.get("X-Access-Password", "")
        if supplied != ACCESS_PASSWORD:
            return jsonify({"error": "wrong_password"}), 401

    if not OPENAI_API_KEY:
        return jsonify({
            "error": "No OpenAI API key configured on the server. Set OPENAI_API_KEY and restart."
        }), 400

    if _rate_limited():
        return jsonify({
            "error": f"This bot is limited to {RATE_LIMIT_PER_HOUR} messages/hour to cap API cost. Try again later."
        }), 429

    body = request.get_json(silent=True) or {}
    history = body.get("messages", [])
    if not isinstance(history, list) or not history:
        return jsonify({"error": "No messages provided."}), 400

    # Keep only the fields OpenAI's API expects, and cap history length so
    # a very long session doesn't blow past context limits or run away in cost.
    trimmed = [
        {"role": m.get("role"), "content": m.get("content")}
        for m in history[-40:]
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
    ]
    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + trimmed

    try:
        resp = requests.post(
            OPENAI_CHAT_URL,
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"model": MODEL, "messages": messages, "temperature": 0.7},
            timeout=60,
        )
    except requests.RequestException as e:
        return jsonify({"error": f"Could not reach OpenAI: {e}"}), 502

    if resp.status_code != 200:
        # Surface OpenAI's own error message when we can parse one — this is
        # what tells you "bad API key" vs "rate limited" vs "model not found".
        try:
            detail = resp.json().get("error", {}).get("message", resp.text)
        except ValueError:
            detail = resp.text
        return jsonify({"error": f"OpenAI API error ({resp.status_code}): {detail}"}), 502

    data = resp.json()
    reply = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return jsonify({"reply": reply, "usage": usage})


if __name__ == "__main__":
    # Local dev only — Railway (or any real deploy) runs this via gunicorn
    # instead (see Procfile), which never executes this block.
    port = int(os.environ.get("PORT", 5050))
    print(f"\n  Chatbot running: http://localhost:{port}\n")
    if not OPENAI_API_KEY:
        print("  ⚠  No OPENAI_API_KEY found — the page will load but chat will show a setup message.\n")
    app.run(host="127.0.0.1", port=port, debug=False)
