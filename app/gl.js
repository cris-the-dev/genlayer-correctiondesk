// Wallet + contract helpers for the ModCourt app (testnet Bradbury Phase 2, MetaMask).
import { createClient, testnetBradbury, MessageType, encodeExternalMessageFeeParams } from "./genlayer.js"; // bundle of genlayer-js 2.0.0-rc.2 (see README);

export const EXPLORER = "https://explorer-bradbury.genlayer.com";
// The chain's default RPC (rpc.testnet-chain.genlayer.com) does not serve gen_call; this one serves the same chain.
const RPC = "https://rpc-bradbury.genlayer.com";
// Gas the contract's payout (an external EVM message) may use on delivery; unused budget is refunded.
const PAYOUT_GAS = 100000n, PAYOUT_GAS_PRICE = 1000000000n;
const CHAIN_HEX = "0x" + testnetBradbury.id.toString(16);
const CONSENSUS_MAIN = "0x2e2766cbc3e5e61ce93bbcdcbb3eacb82082a019";
const T_FINALIZED = "0x24196ec40f90671b7144e716978686b4f3c7d6b00b23da3971ef2b52af27d87f";
const NOT_APPLIED = ["UNDETERMINED", "CANCELED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT"];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Integers stay exact: small ones become numbers, anything past 2^53 stays a BigInt.
export const plain = (v) =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), plain(x)]))
  : Array.isArray(v) ? v.map(plain)
  : typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : v) : v;

const reader = createClient({ chain: testnetBradbury, endpoint: RPC });
let account = null;

export async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const out = await r.json();
  if (out.error) throw new Error(`${method}: ${out.error.message ?? JSON.stringify(out.error)}`);
  return out.result;
}

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// Payouts are keyed on chain by (sender, creation second) of the transaction that made them;
// remember our own transactions under that key so the settle step can find them.
async function remember(address, hash) {
  try {
    const r = await rpc("gen_getTransactionReceipt", [{ txId: hash }]);
    store.set(`gl:tx:${address.toLowerCase()}:${String(r.sender).toLowerCase()}:${r.timestamps.Created}`, hash);
  } catch {}
}
export const payingTx = (address, sender, at) => store.get(`gl:tx:${address.toLowerCase()}:${sender.toLowerCase()}:${at}`);

// The consensus-layer transaction that finalized GenLayer transaction `tx` (null while it is not finalized).
export async function finalizeTx(tx) {
  const r = await rpc("gen_getTransactionReceipt", [{ txId: tx }]);
  if (!r || r.status !== 7) return null;
  const start = Number(r.readStateBlockRanges?.[0]?.ProposalBlock ?? 0), head = Number(await rpc("eth_blockNumber", []));
  for (let lo = start; lo <= head && lo < start + 1_000_000; lo += 10_000) { // ponytail: scans 1M blocks past the proposal
    const logs = await rpc("eth_getLogs", [{ address: CONSENSUS_MAIN, topics: [T_FINALIZED, tx], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + Math.min(lo + 9_999, head).toString(16) }]);
    if (logs.length) return logs[0].transactionHash;
  }
  return null;
}

export function contract(address) {
  return {
    address,
    // Reads the finalized state: what the page shows cannot be rolled back by an appeal.
    // A dropped request ("Failed to fetch": RPC hiccup, flaky network) is retried; a contract error is not.
    read: async (functionName, args = []) => {
      for (let i = 0; ; i++) {
        try {
          return plain(await reader.readContract({ address, functionName, args, jsonSafeReturn: false, transactionHashVariant: "latest-final" }));
        } catch (e) {
          if (i >= 4 || !/fetch|network|timed? ?out/i.test(e.message)) throw e;
          await sleep(1500 * (i + 1));
        }
      }
    },
    // Sends a tx through MetaMask and resolves only once it is FINALIZED with a successful execution result.
    // `payee`: the address the call may pay; its transfer's gas is allocated from this tx's fee deposit.
    write: async (functionName, args = [], value = 0n, { onHash, onProgress, payee } = {}) => {
      if (!account) throw new Error("Connect a wallet first");
      const client = createClient({ chain: testnetBradbury, endpoint: RPC, account });
      // Bradbury Phase 2 rejects transactions without a fee deposit; the unused part is refunded.
      const messageAllocations = payee ? [{
        messageType: MessageType.External, onAcceptance: false, recipient: payee, budget: PAYOUT_GAS * PAYOUT_GAS_PRICE,
        callKey: "0x" + "00".repeat(32), feeParams: encodeExternalMessageFeeParams({ gasLimit: PAYOUT_GAS, maxGasPrice: PAYOUT_GAS_PRICE }),
      }] : undefined;
      const e = await client.estimateTransactionFees(messageAllocations ? { messageAllocations } : {});
      const fees = { distribution: e.distribution, feeValue: e.feeValue, ...(payee && { messageAllocations: e.messageAllocations }) };
      const hash = await client.writeContract({ address, functionName, args, value, fees });
      onHash?.(hash);
      const deadline = Date.now() + 60 * 60_000;
      let last = null, since = Date.now();
      while (Date.now() < deadline) {
        let t;
        try { t = await client.getTransaction({ hash }); } catch { await sleep(5000); continue; } // a lagging RPC node
        const s = t.statusName ?? String(t.status), res = t.txExecutionResultName;
        if (s !== last) { last = s; since = Date.now(); onProgress?.(s, res, hash); }
        if (s === "FINALIZED") {
          if (res === "FINISHED_WITH_RETURN") { await remember(address, hash); return hash; }
          throw Object.assign(new Error("The contract rejected this transaction. Nothing changed on-chain."), { hash });
        }
        // An appeal can still revive these, so give them 10 minutes before reporting.
        if (NOT_APPLIED.includes(s) && Date.now() - since > 10 * 60_000)
          throw Object.assign(new Error(`Validators did not reach a decision (${s}). Nothing changed on-chain; you can try again.`), { hash });
        await sleep(5000);
      }
      throw Object.assign(new Error("Not finalized after 60 minutes. Nothing is assumed: check the transaction in the explorer before retrying."), { hash });
    },
  };
}

export async function connect() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No wallet found. Install MetaMask to send transactions; reading works without one.");
  [account] = await eth.request({ method: "eth_requestAccounts" });
  if ((await eth.request({ method: "eth_chainId" })).toLowerCase() !== CHAIN_HEX) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await eth.request({ method: "wallet_addEthereumChain", params: [{
        chainId: CHAIN_HEX, chainName: "GenLayer Bradbury Testnet",
        nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
        rpcUrls: testnetBradbury.rpcUrls.default.http, blockExplorerUrls: [EXPLORER],
      }] });
    }
  }
  return account;
}

// EIP-191 personal_sign of a UTF-8 message by the connected account.
export async function personalSign(message) {
  if (!account) throw new Error("Connect a wallet first");
  const hex = "0x" + [...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return window.ethereum.request({ method: "personal_sign", params: [hex, account] });
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
// Exact GEN amounts from wei, with BigInt arithmetic (no floating point anywhere).
export const gen = (wei) => {
  let w = BigInt(wei);
  const neg = w < 0n;
  if (neg) w = -w;
  const f = (w % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + (w / 10n ** 18n) + (f ? "." + f : "");
};
export const toWei = (s) => {
  const m = String(s).trim().match(/^(\d*)(?:\.(\d{0,18}))?$/);
  if (!m || !(m[1] || m[2])) throw new Error("Enter a GEN amount with at most 18 decimals");
  return BigInt(m[1] || "0") * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
};
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const $ = (sel) => document.querySelector(sel);

// Wire the header "Connect wallet" button.
export function wireWallet(onConnected) {
  const btn = $("#connect");
  btn.addEventListener("click", async () => {
    try {
      const a = await connect();
      btn.textContent = short(a);
      btn.disabled = true;
      onConnected?.(a);
    } catch (e) { status(e.message, true); }
  });
}

export function status(msg, isError = false, hash) {
  const el = $("#status");
  el.hidden = !msg;
  el.className = isError ? "status err" : "status";
  el.innerHTML = esc(msg) + (hash ? ` <a href="${EXPLORER}/tx/${hash}">view tx ↗</a>` : "");
}

const STAGE = {
  ACCEPTED: "accepted by validators, waiting for finality (several minutes; nothing is final yet)…",
  FINALIZED: "finalized, reading the contract back…",
};

// Run a write and confirm it: FINALIZED + successful execution + `check()` true on the finalized state.
// Returns true only when all three hold.
export async function send(c, label, fn, args, value = 0n, check, payee) {
  status(`${label}: confirm in your wallet…`);
  let hash;
  try {
    hash = await c.write(fn, args, value, {
      payee,
      onHash: (h) => status(`${label}: submitted, waiting for validators…`, false, h),
      onProgress: (s, res, h) => status(`${label}: ${STAGE[s] ?? `${s.toLowerCase().replaceAll("_", " ")}…`}${s === "ACCEPTED" && res === "FINISHED_WITH_ERROR" ? " (the contract reported an error)" : ""}`, false, h),
    });
    // The finalized-state read can trail the receipt by a few seconds.
    for (let i = 0; check && i < 12; i++) {
      if (await check()) break;
      if (i === 11) throw Object.assign(new Error("finalized, but reading the contract back does not show the change yet. Reload before acting again."), { hash });
      await sleep(5000);
    }
    status(`${label}: finalized and confirmed on-chain.`, false, hash);
    return true;
  } catch (e) {
    status(`${label}: ${e.shortMessage ?? e.message}`, true, e.hash ?? hash);
    return false;
  }
}
