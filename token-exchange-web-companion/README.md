# Token Exchange — Portfolio (read-only web companion)

A plain static website that shows the public balances and prices for any
EVM address you paste in — Ethereum, Base, Polygon, BNB Chain, Arbitrum,
and OP Mainnet, plus any custom network/RPC you add. It's the companion to
the **Token Exchange** browser extension, built for the times you (or
someone you'd share a link with) want to check a balance without installing
anything or unlocking a wallet.

**It cannot hold funds, sign anything, or send anything.** There is no
"import wallet," no password, no private key or recovery-phrase field
anywhere in this code — not hidden, not disabled, just not present. It only
ever takes a public `0x...` address and looks up what's already publicly
visible on a block explorer.

## What it does

- Paste any address (or pick a saved one) and see its native-coin balance
  on all six built-in networks, aggregated into one total portfolio value.
- Track specific ERC-20 tokens per network per address (paste a contract
  address, it previews the name/symbol/decimals straight from the
  contract, same as the extension's "Add token" flow).
- A QR code and identicon for the address you're viewing (scan it with the
  Token Exchange extension, or any wallet, to send funds there).
- A live prices board (18 major coins) with a star/watchlist, same list the
  extension shows.
- A read-only "Trending Markets" card (public Polymarket prediction-market
  odds) — informational only, no bets placed.
- Multi-fiat display currency (USD, EUR, GBP, JPY, CAD, AUD, INR, BRL).
- "Add a custom network / your own RPC" if a built-in public endpoint isn't
  working for you (see the CORS note below).

## What it does NOT do (on purpose)

- No key generation, import, storage, or signing of any kind.
- No sending, swapping, or approving anything.
- No dapp connections, no WalletConnect, no injected provider.
- No account, no login, no server of ours. Saved addresses, tracked
  tokens, your currency choice, and watchlist stars live only in **your
  browser's local storage** — clearing your browser data clears them, and
  they're never sent anywhere.

If you want to actually move funds, use the Token Exchange browser
extension (or any wallet) — that's a deliberate, permanent split, the same
reason MetaMask's own "Portfolio" website can't sign transactions either:
a plain webpage is a much easier target for a malicious/compromised site
to trick than an installed extension with its own isolated storage, so it
shouldn't be trusted with keys.

## Running it

This is a fully static site — no build step, no server-side code, no
`npm install`. Three ways to run it:

**1. Just open it locally.** Double-click `index.html`, or open it via
`file://` in your browser. This works in most browsers because the page
only ever makes outbound `fetch()` calls (to RPC endpoints, CoinGecko, and
Polymarket) — it doesn't need its own server. If your browser blocks
`fetch()` from `file://` pages (some do, as a security default), use
option 2 instead.

**2. Run a tiny local server.** From this folder:

```
python3 -m http.server 8080
```

then open `http://localhost:8080` in your browser. (Node users: `npx serve`
works the same way.)

**3. Deploy it for real, so you (or anyone) can open a link.** Any static
host works since there's nothing to build:

- **Netlify / Vercel**: drag-and-drop this folder onto their dashboard, or
  connect it as a git repo — both auto-detect "no build command needed."
- **GitHub Pages**: push this folder to a repo and enable Pages on it
  (Settings → Pages → deploy from branch).
- **Cloudflare Pages**: same idea — connect the repo or drag-and-drop.

There's no environment variable or API key to configure. It talks to
CoinGecko, Polymarket, and each network's public RPC directly and only
ever needs to be served as static files.

## A known limitation: public RPC CORS

Balances load by calling each network's **public RPC endpoint directly
from your browser** (the same endpoints the extension uses:
`cloudflare-eth.com`, `mainnet.base.org`, `polygon-rpc.com`,
`bsc-dataseed.binance.org`, `arb1.arbitrum.io/rpc`,
`mainnet.optimism.io`). Unlike a browser extension — which can declare
`host_permissions` to bypass normal cross-origin restrictions — a plain
website's `fetch()` calls are subject to ordinary browser CORS rules: the
RPC server has to explicitly allow being called from a webpage, or the
request fails.

Public RPCs used directly by dapp frontends (which is common — e.g. many
web wallets and bridge UIs call these exact endpoints from browser
JavaScript) generally do allow this, but **this could not be verified from
the sandboxed environment this was built in** (outbound requests to these
exact hosts were blocked there for unrelated reasons — see the extension's
own `README.md`/`CHROME_WEB_STORE_SUBMISSION.md` for the same
sandbox-network caveat noted elsewhere in this project). Please open this
page for real and check that each network's row loads a balance instead of
the red "Couldn't reach this network's RPC" message.

**If a specific network's public RPC doesn't allow browser calls:** click
"Add a custom network / your own RPC" under the Balances card and paste in
your own RPC URL for that same chain ID — a free one from
[Infura](https://www.infura.io/), [Alchemy](https://www.alchemy.com/), or
[Ankr](https://www.ankr.com/), for example. That custom entry is saved in
your browser and used instead going forward. (You can also just edit
`lib/networks.js`'s `rpcUrls` for a built-in network directly if you're
comfortable editing the file.)

CoinGecko's and Polymarket's public APIs are both designed for exactly this
kind of direct browser use and are expected to work without any of the
above — the CORS caveat is specific to the six chain RPC endpoints.

## Files

```
index.html          the page
styles.css           styling (same "Vault" brass/gold theme as the extension)
app.js               all the logic (balances, tokens, prices, markets, storage)
lib/networks.js       the six built-in networks + custom-network storage (localStorage, not chrome.storage)
lib/prices.js         CoinGecko price lookups -- copied unchanged from the extension
lib/polymarket.js      Polymarket trending-markets lookup -- copied unchanged from the extension
lib/identicon.js       local address-identicon generator -- copied unchanged from the extension
vendor/ethers.umd.min.js   ethers.js, vendored (same copy the extension uses)
vendor/qrcode-generator.js  QR code generator, vendored (same copy the extension uses)
fonts/                self-hosted Fredoka font files (same as the extension)
```

`lib/prices.js`, `lib/polymarket.js`, and `lib/identicon.js` are byte-for-byte
the same files the browser extension uses — they were already pure
`fetch()`-based with no `chrome.*` dependency, so no porting was needed.
Only `lib/networks.js` was adapted (chrome.storage.local → localStorage).
