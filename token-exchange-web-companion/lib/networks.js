// lib/networks.js (web companion build)
// Same built-in EVM network list as the Token Exchange extension's
// lib/networks.js, ported to run in a plain webpage: chrome.storage.local
// is replaced with window.localStorage, everything else is unchanged.
// See the extension's lib/networks.js for the router-verification notes --
// this companion site never swaps or sends, so swapRouter/swapFactory are
// carried over only for reference and aren't used here.

const BUILTIN_NETWORKS = [
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum Mainnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://cloudflare-eth.com", "https://eth.llamarpc.com"],
    blockExplorer: "https://etherscan.io",
    builtin: true,
  },
  {
    key: "base",
    chainId: 8453,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorer: "https://basescan.org",
    builtin: true,
  },
  {
    key: "polygon",
    chainId: 137,
    name: "Polygon",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: ["https://polygon-rpc.com"],
    blockExplorer: "https://polygonscan.com",
    builtin: true,
  },
  {
    key: "bsc",
    chainId: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.binance.org"],
    blockExplorer: "https://bscscan.com",
    builtin: true,
  },
  {
    key: "arbitrum",
    chainId: 42161,
    name: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    blockExplorer: "https://arbiscan.io",
    builtin: true,
  },
  {
    key: "optimism",
    chainId: 10,
    name: "OP Mainnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.optimism.io"],
    blockExplorer: "https://optimistic.etherscan.io",
    builtin: true,
  },
];

const CUSTOM_NETWORKS_KEY = "tmw_custom_networks";

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
    // localStorage unavailable (private mode, quota) -- fail quietly, same
    // "never crash the page over a storage write" stance as the extension.
  }
}

function getAllNetworks() {
  const custom = readLocal(CUSTOM_NETWORKS_KEY, []);
  return [...BUILTIN_NETWORKS, ...custom];
}

function addCustomNetwork(net) {
  if (!net.chainId || !net.name || !net.rpcUrls || !net.rpcUrls.length) {
    throw new Error("Custom network requires chainId, name, and at least one RPC URL.");
  }
  const custom = readLocal(CUSTOM_NETWORKS_KEY, []);
  if (custom.some((n) => n.chainId === net.chainId) || BUILTIN_NETWORKS.some((n) => n.chainId === net.chainId)) {
    throw new Error(`A network with chainId ${net.chainId} already exists.`);
  }
  custom.push({
    key: `custom-${net.chainId}`,
    chainId: net.chainId,
    name: net.name,
    nativeCurrency: net.nativeCurrency || { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: net.rpcUrls,
    blockExplorer: net.blockExplorer || "",
    builtin: false,
  });
  writeLocal(CUSTOM_NETWORKS_KEY, custom);
  return custom;
}

function removeCustomNetwork(chainId) {
  const custom = readLocal(CUSTOM_NETWORKS_KEY, []).filter((n) => n.chainId !== chainId);
  writeLocal(CUSTOM_NETWORKS_KEY, custom);
  return custom;
}

if (typeof window !== "undefined") {
  window.TM_NETWORKS = {
    BUILTIN_NETWORKS,
    getAllNetworks,
    addCustomNetwork,
    removeCustomNetwork,
  };
}
