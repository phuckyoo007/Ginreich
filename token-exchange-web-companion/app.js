// app.js -- Token Exchange Portfolio (read-only web companion)
//
// This page NEVER asks for, generates, imports, or stores a private key or
// recovery phrase -- there is no code path in this file that could even
// accept one. It only ever takes a public 0x address you paste or save, and
// looks up PUBLIC on-chain balances (via each network's own public RPC) and
// PUBLIC prices (via CoinGecko / Polymarket's keyless APIs), the same data
// anyone can see on a block explorer. Nothing you type here is ever sent
// anywhere except: the RPC URL for the network you're viewing (to read a
// balance), CoinGecko (to price a coin), and Polymarket (for the trending
// markets card) -- see README.md for the full list.
//
// Everything below runs entirely in your own browser. Saved addresses,
// tracked tokens, your currency choice, and your watchlist stars live only
// in this browser's localStorage -- there is no server, no account, no
// analytics.

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

const LS_KEYS = {
  addresses: "tmw_saved_addresses",
  lastAddress: "tmw_last_address",
  currency: "tmw_currency",
  watchlist: "tmw_watchlist",
  tokensPrefix: "tmw_tokens_", // + `${networkKey}_${address.toLowerCase()}`
};

let currentAddress = null;
let currentCurrency = readLocal(LS_KEYS.currency, "usd") || "usd";
const providerCache = new Map(); // network.key -> ethers.providers.JsonRpcProvider (first URL that worked)

// ---------- localStorage helpers ----------

function readLocal(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function writeLocal(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* private browsing / quota -- fail quietly */
  }
}

function getSavedAddresses() {
  return readLocal(LS_KEYS.addresses, []);
}
function saveAddress(address) {
  const list = getSavedAddresses().filter((a) => a.toLowerCase() !== address.toLowerCase());
  list.unshift(address);
  writeLocal(LS_KEYS.addresses, list.slice(0, 10));
}
function removeSavedAddress(address) {
  writeLocal(LS_KEYS.addresses, getSavedAddresses().filter((a) => a.toLowerCase() !== address.toLowerCase()));
  renderSavedChips();
}

function tokensKey(networkKey, address) {
  return `${LS_KEYS.tokensPrefix}${networkKey}_${address.toLowerCase()}`;
}
function getTrackedTokens(networkKey, address) {
  return readLocal(tokensKey(networkKey, address), []);
}
function addTrackedToken(networkKey, address, token) {
  const list = getTrackedTokens(networkKey, address);
  if (list.some((t) => t.address.toLowerCase() === token.address.toLowerCase())) return list;
  list.push(token);
  writeLocal(tokensKey(networkKey, address), list);
  return list;
}
function removeTrackedToken(networkKey, address, tokenAddress) {
  const list = getTrackedTokens(networkKey, address).filter((t) => t.address.toLowerCase() !== tokenAddress.toLowerCase());
  writeLocal(tokensKey(networkKey, address), list);
  return list;
}

function getWatchlist() {
  return readLocal(LS_KEYS.watchlist, []);
}
function toggleWatchlist(symbol) {
  const list = getWatchlist();
  const idx = list.indexOf(symbol);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(symbol);
  writeLocal(LS_KEYS.watchlist, list);
}

// ---------- formatting ----------

function currencySymbol() {
  const entry = TM_PRICES.SUPPORTED_CURRENCIES[currentCurrency];
  return entry ? entry.symbol : "$";
}
function formatCurrency(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "--";
  const symbol = currencySymbol();
  const decimals = amount >= 1000 ? 2 : amount >= 1 ? 2 : 4;
  return `${symbol}${amount.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
function formatAmount(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "--";
  if (num === 0) return "0";
  if (num < 0.0001) return num.toExponential(2);
  return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
function shortAddr(a) {
  return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "";
}

// ---------- RPC / balances ----------

async function getProviderFor(network) {
  if (providerCache.has(network.key)) return providerCache.get(network.key);
  let lastErr;
  for (const url of network.rpcUrls) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url);
      await provider.getBlockNumber(); // cheap call to confirm this URL actually answers
      providerCache.set(network.key, provider);
      return provider;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No working RPC endpoint for this network.");
}

async function fetchNativeBalance(network, address) {
  const provider = await getProviderFor(network);
  const wei = await provider.getBalance(address);
  return ethers.utils.formatUnits(wei, network.nativeCurrency.decimals || 18);
}

async function fetchTokenBalance(network, address, tokenAddress, decimals) {
  const provider = await getProviderFor(network);
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const wei = await c.balanceOf(address);
  return ethers.utils.formatUnits(wei, decimals);
}

async function previewToken(network, tokenAddress) {
  const provider = await getProviderFor(network);
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [decimals, symbol, name] = await Promise.all([
    c.decimals(),
    c.symbol().catch(() => "TOKEN"),
    c.name().catch(() => ""),
  ]);
  return { address: tokenAddress, decimals, symbol, name };
}

// ---------- rendering: address bar ----------

function renderSavedChips() {
  const box = document.getElementById("saved-chips");
  const list = getSavedAddresses();
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<span class="empty-hint">No saved addresses yet -- view one, then hit "Save" to keep it here.</span>';
    return;
  }
  list.forEach((addr) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>${shortAddr(addr)}</span><span class="x" title="Remove">&times;</span>`;
    chip.querySelector("span:first-child").addEventListener("click", () => viewAddress(addr));
    chip.querySelector(".x").addEventListener("click", (e) => {
      e.stopPropagation();
      removeSavedAddress(addr);
    });
    box.appendChild(chip);
  });
}

async function viewAddress(rawAddress) {
  const errBox = document.getElementById("address-error");
  errBox.textContent = "";
  errBox.hidden = true;
  const address = (rawAddress || document.getElementById("address-input").value || "").trim();
  if (!address) return;
  if (!ethers.utils.isAddress(address)) {
    errBox.textContent = "That doesn't look like a valid 0x address.";
    errBox.hidden = false;
    return;
  }
  currentAddress = ethers.utils.getAddress(address); // checksum
  document.getElementById("address-input").value = currentAddress;
  writeLocal(LS_KEYS.lastAddress, currentAddress);

  document.getElementById("viewer-summary").hidden = false;
  document.getElementById("summary-address").textContent = currentAddress;
  document.getElementById("identicon-box").innerHTML = TM_IDENTICON.svgFor(currentAddress, 40);
  renderQr(currentAddress);
  document.getElementById("total-value").textContent = "...";

  await renderNetworks();
}

function renderQr(address) {
  const box = document.getElementById("qr-box");
  box.classList.remove("shown");
  box.innerHTML = "";
  try {
    const qr = qrcode(0, "M");
    qr.addData(address);
    qr.make();
    box.innerHTML = qr.createSvgTag({ scalable: true, margin: 2 });
  } catch (e) {
    // QR is a nice-to-have; a failure here shouldn't block anything else
  }
}

// ---------- rendering: networks + tokens ----------

async function renderNetworks() {
  const grid = document.getElementById("network-grid");
  grid.innerHTML = "";
  const networks = TM_NETWORKS.getAllNetworks();
  let total = 0;
  let anySucceeded = false;

  const cardPromises = networks.map(async (network) => {
    const card = document.createElement("div");
    card.className = "network-card";
    card.innerHTML = `
      <div class="network-head">
        <div class="network-name-group">
          <span class="network-dot" style="background:${networkColor(network.key)}"></span>
          <div>
            <div class="network-name">${network.name}</div>
            <div class="network-chainid">chainId ${network.chainId}${network.builtin ? "" : " (custom)"}</div>
          </div>
        </div>
        <div class="network-balances"><span class="network-loading"><span class="spinner"></span> loading...</span></div>
      </div>
      <div class="token-list-mount"></div>
    `;
    grid.appendChild(card);

    const balancesBox = card.querySelector(".network-balances");
    try {
      const [nativeBal, nativePrice] = await Promise.all([
        fetchNativeBalance(network, currentAddress),
        TM_PRICES.getNativePriceForNetwork(network.key, currentCurrency).catch(() => null),
      ]);
      const usdVal = nativePrice != null ? Number(nativeBal) * nativePrice : null;
      if (usdVal != null) total += usdVal;
      anySucceeded = true;
      balancesBox.innerHTML = `
        <div class="network-native">${formatAmount(nativeBal)} ${network.nativeCurrency.symbol}</div>
        <div class="network-usd">${usdVal != null ? formatCurrency(usdVal) : "price unavailable"}</div>
      `;
    } catch (e) {
      balancesBox.innerHTML = `<div class="network-usd" style="color:var(--danger)">Couldn't reach this network's RPC</div>`;
    }

    const tokenMount = card.querySelector(".token-list-mount");
    await renderTokenSection(tokenMount, network, (usdAdd) => {
      if (typeof usdAdd === "number") {
        total += usdAdd;
        document.getElementById("total-value").textContent = formatCurrency(total);
      }
    });
  });

  await Promise.all(cardPromises);
  document.getElementById("total-value").textContent = anySucceeded ? formatCurrency(total) : "--";
}

function networkColor(key) {
  const colors = {
    ethereum: "#8aa8f0",
    base: "#4d7bf3",
    polygon: "#a855f7",
    bsc: "#f0b90b",
    arbitrum: "#28a0f0",
    optimism: "#ff0420",
  };
  return colors[key] || "#ddac4d";
}

async function renderTokenSection(mount, network, onValueAdded) {
  const address = currentAddress;
  const tokens = getTrackedTokens(network.key, address);

  const wrap = document.createElement("div");
  wrap.className = "token-list";
  const listEl = document.createElement("div");
  wrap.appendChild(listEl);

  if (!tokens.length) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "No tokens tracked on this network yet.";
    listEl.appendChild(hint);
  }

  for (const token of tokens) {
    const row = document.createElement("div");
    row.className = "token-row";
    row.innerHTML = `
      <div class="token-left">
        <span class="sym">${token.symbol}</span>
        <span class="name">${token.name || ""}</span>
      </div>
      <div class="token-right"><span class="spinner"></span></div>
      <button class="link" data-remove="${token.address}" title="Stop tracking">remove</button>
    `;
    listEl.appendChild(row);
    row.querySelector("[data-remove]").addEventListener("click", () => {
      removeTrackedToken(network.key, address, token.address);
      row.remove();
    });
    (async () => {
      try {
        const [bal, priceMap] = await Promise.all([
          fetchTokenBalance(network, address, token.address, token.decimals),
          TM_PRICES.getTokenPricesByContract(network.key, [token.address], currentCurrency).catch(() => ({})),
        ]);
        const priceEntry = priceMap[token.address.toLowerCase()] || priceMap[token.address];
        const price = priceEntry ? priceEntry.price : null;
        const usdVal = price != null ? Number(bal) * price : null;
        row.querySelector(".token-right").innerHTML = `
          <div class="bal">${formatAmount(bal)}</div>
          <div class="usd">${usdVal != null ? formatCurrency(usdVal) : ""}</div>
        `;
        if (usdVal != null) onValueAdded(usdVal);
      } catch (e) {
        row.querySelector(".token-right").innerHTML = `<div class="usd" style="color:var(--danger)">error</div>`;
      }
    })();
  }

  const addRow = document.createElement("div");
  addRow.className = "add-token-row";
  addRow.innerHTML = `
    <input type="text" placeholder="ERC-20 contract address (0x...)" />
    <button class="small">Add</button>
  `;
  const input = addRow.querySelector("input");
  const btn = addRow.querySelector("button");
  btn.addEventListener("click", async () => {
    const tokenAddress = input.value.trim();
    if (!tokenAddress || !ethers.utils.isAddress(tokenAddress)) {
      alert("That doesn't look like a valid contract address.");
      return;
    }
    btn.disabled = true;
    btn.textContent = "...";
    try {
      const preview = await previewToken(network, tokenAddress);
      addTrackedToken(network.key, address, preview);
      input.value = "";
      mount.innerHTML = "";
      await renderTokenSection(mount, network, onValueAdded);
    } catch (e) {
      alert(`Couldn't read that contract on ${network.name}: ${e.message || e}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Add";
    }
  });
  wrap.appendChild(addRow);

  mount.innerHTML = "";
  mount.appendChild(wrap);
}

// ---------- prices board ----------

function sortByWatchlist(board) {
  const watchlist = getWatchlist();
  return [...board].sort((a, b) => {
    const aw = watchlist.includes(a.symbol) ? 0 : 1;
    const bw = watchlist.includes(b.symbol) ? 0 : 1;
    return aw - bw;
  });
}

async function renderPrices() {
  const box = document.getElementById("price-board");
  box.innerHTML = '<span class="empty-hint"><span class="spinner"></span> loading prices...</span>';
  try {
    const board = sortByWatchlist(await TM_PRICES.getPriceBoard(currentCurrency));
    box.innerHTML = "";
    board.forEach((c) => box.appendChild(renderPriceRow(c)));
  } catch (e) {
    box.innerHTML = `<div class="error-msg">${e.message || "Couldn't load prices."}</div>`;
  }
}

function renderPriceRow(c) {
  const row = document.createElement("div");
  row.className = "price-row";
  const starred = getWatchlist().includes(c.symbol);
  const changeClass = c.change24h == null ? "" : c.change24h >= 0 ? "up" : "down";
  const changeText = c.change24h == null ? "" : `${c.change24h >= 0 ? "+" : ""}${c.change24h.toFixed(2)}%`;
  row.innerHTML = `
    <div class="price-left">
      <button class="star-btn ${starred ? "starred" : ""}" title="Watchlist">&#9733;</button>
      <div>
        <div class="price-sym">${c.symbol}</div>
        <div class="price-name">${c.name}</div>
      </div>
    </div>
    <div class="price-right">
      <div>
        <div class="price-val">${c.price != null ? formatCurrency(c.price) : "--"}</div>
        <div class="price-change ${changeClass}">${changeText}</div>
      </div>
    </div>
  `;
  row.querySelector(".star-btn").addEventListener("click", () => {
    toggleWatchlist(c.symbol);
    renderPrices();
  });
  return row;
}

// ---------- trending markets ----------

async function renderMarkets() {
  const box = document.getElementById("markets-board");
  box.innerHTML = '<span class="empty-hint"><span class="spinner"></span> loading markets...</span>';
  try {
    const markets = await TM_POLYMARKET.getTrendingMarkets(8);
    if (!markets.length) {
      box.innerHTML = '<span class="empty-hint">No trending markets right now.</span>';
      return;
    }
    box.innerHTML = "";
    markets.forEach((m) => {
      const row = document.createElement("div");
      row.className = "market-row";
      row.innerHTML = `
        <div class="market-q">${m.question}<div class="market-volume">$${Math.round(m.volume24hr).toLocaleString()} 24h volume</div></div>
        <div class="market-odds">${m.leadName || ""} ${m.leadPct != null ? m.leadPct + "%" : ""}</div>
      `;
      box.appendChild(row);
    });
  } catch (e) {
    box.innerHTML = `<div class="error-msg">${e.message || "Couldn't load trending markets."}</div>`;
  }
}

// ---------- custom network ----------

function renderCustomNetworkNote() {
  const form = document.getElementById("custom-network-form");
  document.getElementById("btn-add-network").addEventListener("click", () => {
    const chainId = Number(document.getElementById("cn-chainid").value);
    const name = document.getElementById("cn-name").value.trim();
    const rpc = document.getElementById("cn-rpc").value.trim();
    const symbol = document.getElementById("cn-symbol").value.trim() || "ETH";
    const errBox = document.getElementById("custom-network-error");
    errBox.textContent = "";
    errBox.hidden = true;
    try {
      TM_NETWORKS.addCustomNetwork({
        chainId,
        name,
        rpcUrls: [rpc],
        nativeCurrency: { name: symbol, symbol, decimals: 18 },
      });
      document.getElementById("cn-chainid").value = "";
      document.getElementById("cn-name").value = "";
      document.getElementById("cn-rpc").value = "";
      document.getElementById("cn-symbol").value = "";
      if (currentAddress) renderNetworks();
    } catch (e) {
      errBox.textContent = e.message || String(e);
      errBox.hidden = false;
    }
  });
}

// ---------- init ----------

function populateCurrencySelect() {
  const sel = document.getElementById("currency-select");
  Object.entries(TM_PRICES.SUPPORTED_CURRENCIES).forEach(([code, meta]) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${meta.label} (${meta.symbol})`;
    if (code === currentCurrency) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", async () => {
    currentCurrency = sel.value;
    writeLocal(LS_KEYS.currency, currentCurrency);
    await renderPrices();
    if (currentAddress) await renderNetworks();
  });
}

function init() {
  populateCurrencySelect();
  renderSavedChips();
  renderCustomNetworkNote();

  document.getElementById("btn-view-address").addEventListener("click", () => viewAddress());
  document.getElementById("address-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") viewAddress();
  });
  document.getElementById("btn-save-address").addEventListener("click", () => {
    if (!currentAddress) return;
    saveAddress(currentAddress);
    renderSavedChips();
  });
  document.getElementById("btn-toggle-qr").addEventListener("click", () => {
    document.getElementById("qr-box").classList.toggle("shown");
  });
  document.getElementById("btn-copy-address").addEventListener("click", () => {
    if (!currentAddress) return;
    navigator.clipboard.writeText(currentAddress).catch(() => {});
  });

  renderPrices();
  renderMarkets();

  const last = readLocal(LS_KEYS.lastAddress, null);
  if (last) {
    document.getElementById("address-input").value = last;
    viewAddress(last);
  }
}

document.addEventListener("DOMContentLoaded", init);
