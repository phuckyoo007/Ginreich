# Gemini Assistant

A small general-purpose chat assistant: a Flask backend that calls Google's
Gemini API, and a single-page web chat UI. No database — conversation
history lives in the browser (`localStorage`) and is replayed to the server
on every message.

## Get a free Gemini API key

1. Go to https://aistudio.google.com/apikey (sign in with a Google account).
2. Click "Create API key." It's free to start — Gemini's free tier covers
   the Flash models this app uses by default, with rate limits (see
   Google's current pricing page for the exact numbers, since they change).
3. Copy the key. You'll set it as `GEMINI_API_KEY` below.

Worth knowing before you rely on this for anything sensitive: Google's free
tier uses your prompts/responses to improve their products. Paid usage gets
a "not used for training" guarantee that the free tier doesn't. Fine for a
casual assistant; think twice before pasting anything private into it.

## Environment variables

- `GEMINI_API_KEY` (required) — from the step above. Without it, the app
  still starts up fine, but every chat request returns a clear "not
  configured" error instead of crashing the server.
- `GEMINI_MODEL` (optional) — defaults to `gemini-3.6-flash`. Swap in
  another Gemini model name if you want a different cost/quality tradeoff.
  Google periodically retires older free-tier model names for new API
  keys (this app originally shipped with `gemini-2.5-flash`, which got
  retired for new keys within days) — if you start seeing a 404 error
  mentioning a model name, check https://ai.google.dev/gemini-api/docs/models
  for the current free-tier model list and update this variable.

## Running locally

```
pip install -r requirements.txt
export GEMINI_API_KEY=your-key-here
python app.py
```

Then open http://localhost:5000.

## Deploying on Railway

1. Push this folder to a GitHub repo.
2. In Railway, create a new project from that repo (or ask whoever's
   managing your Railway account to do it).
3. Set the `GEMINI_API_KEY` environment variable on the service.
4. Railway auto-detects the `Procfile` and runs `gunicorn app:app` — no
   other config needed. Generate a domain from the service's Settings tab
   once it's deployed.

## What's deliberately *not* here

- No user accounts, no multi-device history sync — it's one browser, one
  conversation, stored locally. Add a database if that's ever needed.
- No streaming responses — replies come back as one chunk. Gemini supports
  streaming; wiring it in would mean switching `/api/chat` to
  Server-Sent Events and streaming tokens to the frontend as they arrive.
- No conversation persistence on the server, so clearing browser storage
  (or opening the app in a different browser) loses history for good.
