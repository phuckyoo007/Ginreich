"""
Tests app.py without needing a real Gemini API key or network access —
requests.post is monkeypatched for the success/error paths. Run:
python3 test_app.py
"""
import json
import sys
from unittest import mock

FAILURES = []


def check(label, cond):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {label}")
    if not cond:
        FAILURES.append(label)


# ---------- scenario 1: no API key configured ----------
import importlib
import os

os.environ.pop("GEMINI_API_KEY", None)
import app as app_mod  # noqa: E402

importlib.reload(app_mod)  # ensure GEMINI_API_KEY is re-read as empty
client = app_mod.app.test_client()

resp = client.get("/health")
check("health check returns 200 even with no API key", resp.status_code == 200)
check("health check reports gemini_configured=False", resp.get_json()["gemini_configured"] is False)

resp = client.post("/api/chat", json={"messages": [{"role": "user", "text": "hi"}]})
check("chat without API key returns 503, not a crash", resp.status_code == 503)
check("503 response has a helpful error message", "GEMINI_API_KEY" in resp.get_json()["error"])

resp = client.get("/")
check("index page still served with no API key", resp.status_code == 200)

# ---------- scenario 2: API key configured, mock a successful Gemini reply ----------
os.environ["GEMINI_API_KEY"] = "fake-test-key"
importlib.reload(app_mod)
client = app_mod.app.test_client()


def make_response(status_code, json_body, text_body=None):
    m = mock.Mock()
    m.status_code = status_code
    m.json.return_value = json_body
    m.text = text_body or json.dumps(json_body)
    return m


success_body = {
    "candidates": [{"content": {"parts": [{"text": "Hello! How can I help?"}]}, "finishReason": "STOP"}]
}
with mock.patch.object(app_mod.requests, "post", return_value=make_response(200, success_body)) as mock_post:
    resp = client.post("/api/chat", json={"messages": [{"role": "user", "text": "hi"}]})
    check("successful chat returns 200", resp.status_code == 200)
    check("successful chat returns the model's reply text", resp.get_json().get("reply") == "Hello! How can I help?")
    called_kwargs = mock_post.call_args.kwargs
    check("request includes the API key as a query param", called_kwargs["params"]["key"] == "fake-test-key")
    check("request body has properly shaped contents", called_kwargs["json"]["contents"][0]["role"] == "user")

# ---------- scenario 3: malformed / empty request bodies ----------
resp = client.post("/api/chat", json={})
check("missing 'messages' field returns 400", resp.status_code == 400)

resp = client.post("/api/chat", json={"messages": []})
check("empty 'messages' list returns 400", resp.status_code == 400)

resp = client.post("/api/chat", json={"messages": [{"role": "system", "text": "ignored"}]})
check("only-invalid-role messages returns 400 (no valid contents)", resp.status_code == 400)

# ---------- scenario 4: Gemini API returns a non-200 ----------
with mock.patch.object(app_mod.requests, "post", return_value=make_response(429, {}, text_body="rate limited")):
    resp = client.post("/api/chat", json={"messages": [{"role": "user", "text": "hi"}]})
    check("upstream Gemini error surfaces as 502", resp.status_code == 502)
    check("upstream error detail is included", "rate limited" in resp.get_json()["error"])

# ---------- scenario 5: Gemini returns 200 but no usable candidate (e.g. safety block) ----------
blocked_body = {"candidates": [{"finishReason": "SAFETY"}]}
with mock.patch.object(app_mod.requests, "post", return_value=make_response(200, blocked_body)):
    resp = client.post("/api/chat", json={"messages": [{"role": "user", "text": "hi"}]})
    check("safety-blocked response returns 502 with finish_reason", resp.status_code == 502 and "SAFETY" in resp.get_json()["error"])

# ---------- scenario 6: network failure talking to Gemini ----------
with mock.patch.object(app_mod.requests, "post", side_effect=app_mod.requests.RequestException("timeout")):
    resp = client.post("/api/chat", json={"messages": [{"role": "user", "text": "hi"}]})
    check("network failure returns 502, not a 500 crash", resp.status_code == 502)

# ---------- scenario 7: rate limiting ----------
app_mod._rate_state.clear()
with mock.patch.object(app_mod.requests, "post", return_value=make_response(200, success_body)):
    statuses = []
    for _ in range(app_mod.RATE_LIMIT_MAX_REQUESTS + 5):
        r = client.post("/api/chat", json={"messages": [{"role": "user", "text": "hi"}]},
                         environ_overrides={"REMOTE_ADDR": "1.2.3.4"})
        statuses.append(r.status_code)
    check("rate limiter allows requests under the cap", statuses[0] == 200)
    check("rate limiter kicks in once over the cap", 429 in statuses)

# ---------- scenario 8: history truncation doesn't crash on huge input ----------
with mock.patch.object(app_mod.requests, "post", return_value=make_response(200, success_body)) as mock_post:
    huge_history = [{"role": "user", "text": f"msg {i}"} for i in range(200)]
    resp = client.post("/api/chat", json={"messages": huge_history},
                        environ_overrides={"REMOTE_ADDR": "5.6.7.8"})
    check("oversized history is accepted (truncated), not rejected", resp.status_code == 200)
    sent_contents = mock_post.call_args.kwargs["json"]["contents"]
    check("history sent to Gemini is capped at MAX_HISTORY_MESSAGES", len(sent_contents) <= app_mod.MAX_HISTORY_MESSAGES)

print()
if FAILURES:
    print(f"{len(FAILURES)} check(s) FAILED:")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
else:
    print("All checks passed.")
