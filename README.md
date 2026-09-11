# Assistant — a local chatbot

A small chat app that runs on your own computer. A Python server (Flask)
serves the chat page and talks to OpenAI's API on your behalf, so your
API key never has to touch the browser or leave your machine.

## 1. Get an OpenAI API key

1. Go to <https://platform.openai.com/signup> and create an account (or
   sign in) at OpenAI — this is separate from any Anthropic/Claude
   account.
2. Add billing details at <https://platform.openai.com/account/billing> —
   the chat API is pay-as-you-go, not covered by a ChatGPT Plus
   subscription. Costs for casual personal use are typically small
   (fractions of a cent per message with the default model), but it is
   real money, so consider setting a spending limit on that same
   billing page.
3. Create a key at <https://platform.openai.com/api-keys> → **Create new
   secret key**. Copy it immediately — OpenAI only shows it once.

**Keep that key private.** Don't paste it into a chat with me or anyone
else, don't commit it to a public repo, don't post it anywhere. Anyone
who has it can spend money on your account. It only ever goes into the
`.env` file described below, which stays on your computer.

## 2. Install

Requires Python 3.9+. From this folder:

```bash
pip install -r requirements.txt
```

## 3. Add your key

```bash
cp .env.example .env
```

Open `.env` in any text editor and paste your key in:

```
OPENAI_API_KEY=sk-...your-real-key...
```

## 4. Run it

```bash
python app.py
```

Then open **http://localhost:5050** in your browser. That's the whole
app — one page, one server, nothing installed system-wide.

## Customizing

Optional lines you can add to `.env`:

- `MODEL=gpt-4o-mini` — swap in another OpenAI model name (e.g.
  `gpt-4o` for a stronger but pricier model).
- `SYSTEM_PROMPT=...` — change the assistant's personality or
  instructions. This is the one line that shapes how it behaves.
- `ACCESS_PASSWORD=...` — see below; matters once this is public.
- `RATE_LIMIT_PER_HOUR=100` — caps total messages/hour as a cost guard.

## Deploying on Railway

Locally, only you can reach `localhost:5050`. Deployed on Railway, the
app gets a public URL — which means **anyone who finds that URL can
chat using your OpenAI key and your money** unless you lock it down.
The app already has a password gate built in for exactly this; just
set it before you deploy.

1. **Push this folder to a GitHub repo** (Railway deploys from Git).
   From this folder:
   ```bash
   git init && git add . && git commit -m "chatbot"
   ```
   Create an empty repo on GitHub, then follow its "push an existing
   repo" instructions to add the remote and push. (`.env` won't be
   included — it's in `.gitignore` on purpose, since it would otherwise
   put your API key in a public commit.)

2. **Create the Railway project.** At <https://railway.app>, sign in,
   **New Project → Deploy from GitHub repo**, and pick this repo.
   Railway auto-detects it's a Python app and uses the included
   `Procfile` to run it with `gunicorn` (a production server — the
   `python app.py` command is for local use only).

3. **Set environment variables.** In the Railway project → your
   service → **Variables** tab, add:
   - `OPENAI_API_KEY` — your real key
   - `ACCESS_PASSWORD` — something only you know; you'll type this
     once in the browser after deploying, and it's remembered after that
   - optionally `MODEL`, `SYSTEM_PROMPT`, `RATE_LIMIT_PER_HOUR`

   Railway sets `PORT` itself — you don't need to add it.

4. **Deploy and open it.** Railway builds and starts the app
   automatically after you save the variables (or on push). Under
   **Settings → Networking**, click **Generate Domain** to get a public
   `*.up.railway.app` URL. Open it, enter your `ACCESS_PASSWORD` once,
   and it's a chatbot you can reach from your phone anywhere.

A few things worth knowing about this setup: the rate limit and the
password check both live in server memory, which works cleanly with
the single worker the `Procfile` runs — don't raise `--workers` above
1 without also moving those to a shared store like Redis, or each
worker will enforce its own separate limit. And Railway's free tier
has usage limits of its own (separate from OpenAI's) — check their
current pricing if you plan to leave this running continuously.

## How it's built, if you want to change it

- `app.py` — the whole server: serves the page, a `/api/chat` endpoint
  that forwards your conversation to OpenAI and returns the reply, the
  password check, and the rate limiter. No framework magic.
- `static/index.html` — the entire frontend: HTML, CSS, and JS in one
  file, including the login screen. No build step, no npm — edit and
  refresh the browser.
- `Procfile` — tells Railway (or any Procfile-based host) to run the
  app with `gunicorn` instead of Flask's built-in dev server.
- Conversation history lives in the browser tab's memory, so reloading
  the page starts a fresh conversation. If you want it to persist
  across reloads, or want multiple saved conversations, that's a
  natural next step I can add.

## Notes

- This is unrelated to the Kalshi paper-trading desk from earlier in
  our conversation — a separate, general-purpose assistant.
- Everything runs locally; nothing here talks to Kalshi, Polymarket, or
  any trading account.
