// End-to-end on Testnet Bradbury (Phase 2), on the packed code that is deployed:
//
//   python deploy/shrink.py contracts/correction_desk.py build/correction_desk.py --pack
//   npm i genlayer-js@2.0.0-rc.2   # plus the estimateTransactionFees patch in app/README.md
//   GL_PK0=0x... GL_PK1=0x... node tests/integration/bradbury.mjs build/correction_desk.py [contract]
//
// GL_PK0 publishes the article (evidence/article.html, hosted at EVIDENCE); GL_PK1 reports.
// A wrong fee, a stale hash and an unreachable source revert and record nothing; a misquote is
// rejected as quote_not_found and an unrelated source as not_contradicted, both fees going to the
// pool; the real error (the article says 1932, the register says 1928) is accepted and paid; the
// same statement cannot be paid twice; the publisher withdraws the rest of the pool; both payouts
// settle from their own transfers once the paying transactions finalize. Every transaction carries
// a fee deposit; a paying one also allocates its payout's gas.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createAccount, createClient, MessageType, encodeExternalMessageFeeParams } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const REWARD = 10n ** 15n, FEE = 10n ** 14n;
const EVIDENCE = "https://correctiondesk.cristhedev.com/evidence/";
const ARTICLE = EVIDENCE + "article.html", REGISTER = EVIDENCE + "register.html", WEATHER = EVIDENCE + "weather.html";
const QUOTE = "The Elm Street bridge, built in 1932, reopened to traffic on Monday";
const MISQUOTE = "The Elm Street bridge, built in 1925, reopened to traffic on Monday";
const WHY = "The county register lists construction completed in 1928.";
const CONSENSUS_MAIN = "0x2e2766cbc3e5e61ce93bbcdcbb3eacb82082a019";
const T_FINALIZED = "0x24196ec40f90671b7144e716978686b4f3c7d6b00b23da3971ef2b52af27d87f";
const PAYOUT_GAS = 100000n, PAYOUT_GAS_PRICE = 1000000000n;
// rpc.testnet-chain.genlayer.com (the chain default) does not serve gen_call; this one serves the same chain.
const endpoint = "https://rpc-bradbury.genlayer.com";
const a0 = createAccount(process.env.GL_PK0);
const a1 = createAccount(process.env.GL_PK1);
const c0 = createClient({ chain: testnetBradbury, endpoint, account: a0 });
const c1 = createClient({ chain: testnetBradbury, endpoint, account: a1 });
const sha = (t) => createHash("sha256").update(t).digest("hex");
const page = async (url) => sha(Buffer.from(await (await fetch(url)).arrayBuffer()));
const fees = async (c, payee) => {
  const messageAllocations = payee && [{
    messageType: MessageType.External, onAcceptance: false, recipient: payee, budget: PAYOUT_GAS * PAYOUT_GAS_PRICE,
    callKey: "0x" + "00".repeat(32), feeParams: encodeExternalMessageFeeParams({ gasLimit: PAYOUT_GAS, maxGasPrice: PAYOUT_GAS_PRICE }),
  }];
  const e = await c.estimateTransactionFees(payee ? { messageAllocations } : {});
  return { distribution: e.distribution, feeValue: e.feeValue, ...(payee && { messageAllocations: e.messageAllocations }) };
};
// The public RPC drops connections now and then; retry the wait, never the write.
async function wait(c, hash, waitUntil = "decided") {
  for (let i = 0; ; i++) {
    try {
      return await c.waitForTransactionReceipt({ hash, waitUntil, interval: 10000, retries: 360 });
    } catch (e) {
      if (i >= 5 || !/fetch failed|ECONNRESET|timed out|socket/i.test(String(e?.details ?? e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}
const check = (ok, what) => {
  console.log(ok ? "  ok  " : "  FAIL", what);
  if (!ok) process.exit(1);
};
// A leader timeout (NOT_VOTED) executed nothing, so sending the call again is safe. Bradbury still
// moves the value of such a transaction, and of a reverted one, into the contract, where
// get_accounting shows it as unaccounted.
let stray = 0n;
async function tx(c, label, functionName, args, { value = 0n, payee } = {}) {
  for (let i = 0; ; i++) {
    const hash = await c.writeContract({ address, functionName, args, value, fees: await fees(c, payee) });
    const r = await wait(c, hash);
    console.log(`${label}: ${hash} ${r.txExecutionResultName}`);
    if (r.txExecutionResultName !== "FINISHED_WITH_RETURN") stray += value;
    if (r.txExecutionResultName !== "NOT_VOTED" || i >= 2) return { ...r, hash };
  }
}
const ok = async (...a) => { const r = await tx(...a); check(r.txExecutionResultName === "FINISHED_WITH_RETURN", `${a[1]} succeeds`); return r; };
const fails = async (what, ...a) => check((await tx(...a)).txExecutionResultName !== "FINISHED_WITH_RETURN", what);
const read = async (functionName, args = []) => {
  const v = await c0.readContract({ address, functionName, args });
  const plain = (x) => (x instanceof Map ? Object.fromEntries([...x].map(([k, y]) => [k, plain(y)])) : Array.isArray(x) ? x.map(plain) : x);
  return plain(v);
};
// RPC nodes behind the edge can lag the one that reported the receipt: re-read until `ok` holds (or give up).
async function settled(fn, args, ok) {
  for (let i = 0; ; i++) {
    const v = await read(fn, args);
    if (ok(v) || i >= 12) return v;
    await new Promise((r) => setTimeout(r, 10000));
  }
}
const rpc = async (method, params) => {
  const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "user-agent": "correctiondesk-e2e" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
};
// The consensus-layer transaction that finalized `hash`: it emits TransactionFinalized(txId).
async function finalizeTx(hash, fromBlock) {
  for (;;) {
    const to = BigInt(await rpc("eth_blockNumber", []));
    for (let b = fromBlock; b <= to; b += 1000n) {
      const end = b + 999n > to ? to : b + 999n;
      const logs = await rpc("eth_getLogs", [{ address: CONSENSUS_MAIN, topics: [T_FINALIZED, hash], fromBlock: "0x" + b.toString(16), toBlock: "0x" + end.toString(16) }]);
      if (logs?.length) return logs[0].transactionHash;
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
}
async function settle(id, paid, fromBlock) {
  await wait(c0, paid.hash, "finalized");
  const fin = await finalizeTx(paid.hash, fromBlock);
  console.log(`finalized by ${fin}`);
  await ok(c1, `settle payout ${id}`, "settle_payout", [id, paid.hash, fin]);
  check((await settled("get_payout", [id], (x) => x.status === "DELIVERED")).status === "DELIVERED", `payout ${id} DELIVERED`);
  await fails("a payout settles once", c1, "settle again", "settle_payout", [id, paid.hash, fin]);
}

let address = process.argv[3];
if (!address) {
  const hash = await c0.deployContract({ code: readFileSync(process.argv[2], "utf8"), args: [], fees: await fees(c0) });
  const r = await wait(c0, hash);
  address = r.txDataDecoded?.contractAddress;
  console.log(`deploy: ${hash} ${r.txExecutionResultName} -> ${address}`);
  check(r.txExecutionResultName === "FINISHED_WITH_RETURN", "deployed");
}
const fromBlock = BigInt(await rpc("eth_blockNumber", []));
stray = BigInt((await read("get_accounting")).unaccounted);
const [aSha, rSha, wSha] = [await page(ARTICLE), await page(REGISTER), await page(WEATHER)];
const aid = Number((await read("get_articles", [0, 1])).total);
await ok(c0, "register_article", "register_article", [ARTICLE, "Elm Street bridge reopens after two-year repair", REWARD, FEE], { value: 2n * REWARD });
const me = a1.address;
const rep = (label, quote, src, srcSha, value = FEE, articleSha = aSha) =>
  tx(c1, label, "report", [aid, quote, articleSha, src, srcSha, WHY], { value, payee: me });

// Guards and failed fetches revert: nothing recorded, the fee stays with the reader.
await fails("the exact fee is required", c1, "report with half the fee", "report", [aid, QUOTE, aSha, REGISTER, rSha, WHY], { value: FEE / 2n });
check((await rep("report with a stale article hash", QUOTE, REGISTER, rSha, FEE, "0".repeat(64))).txExecutionResultName !== "FINISHED_WITH_RETURN", "a page that differs from its hash reverts");
check((await rep("report citing a missing source", QUOTE, EVIDENCE + "missing.html", rSha)).txExecutionResultName !== "FINISHED_WITH_RETURN", "an unreachable source reverts");
check(Number((await read("get_article", [aid])).reports) === 0, "no report recorded");

// Rejected reports: the fee goes to the pool.
await ok(c1, "report a misquote", "report", [aid, MISQUOTE, aSha, REGISTER, rSha, WHY], { value: FEE, payee: me });
await ok(c1, "report citing an unrelated source", "report", [aid, QUOTE, aSha, WEATHER, wSha, WHY], { value: FEE, payee: me });
let rs = (await settled("get_reports", [aid, 0, 10, false], (x) => x.items.filter((r) => Number(r.article_id) === aid).length === 2)).items.filter((r) => Number(r.article_id) === aid);
check(rs.map((r) => r.verdict).join() === "quote_not_found,not_contradicted", "misquote: quote_not_found; unrelated source: not_contradicted");
check(BigInt((await read("get_article", [aid])).pool) === 2n * REWARD + 2n * FEE, "both fees went to the pool");

// The real error is accepted and paid.
const pid = Number((await read("get_accounting")).payout_count);
const paid = await ok(c1, "report the 1932/1928 error", "report", [aid, QUOTE, aSha, REGISTER, rSha, WHY], { value: FEE, payee: me });
rs = (await settled("get_reports", [aid, 0, 10, true], (x) => x.items.some((r) => Number(r.article_id) === aid))).items.filter((r) => Number(r.article_id) === aid);
check(rs.length === 1 && rs[0].verdict === "accepted" && rs[0].source_sha256 === rSha, "accepted, source pinned by hash");
console.log("    note (unverified):", rs[0].note);
const art = await settled("get_article", [aid], (x) => Number(x.corrections) === 1);
check(BigInt(art.pool) === REWARD + 2n * FEE && Number(art.reports) === 3, "pool paid one reward; 3 reports on record");
await fails("the same statement is paid once", c1, "report it again", "report", [aid, QUOTE, aSha, REGISTER, rSha, WHY], { value: FEE, payee: me });
const pub = await read("get_publisher", [a0.address]);
check(Number(pub.corrections) >= 1, `publisher record: ${pub.articles} articles, ${pub.corrections} corrections`);

await fails("only the publisher withdraws", c1, "withdraw by the reader", "withdraw_pool", [aid, 1n], { payee: me });
const withdrawn = await ok(c0, "withdraw_pool", "withdraw_pool", [aid, REWARD + 2n * FEE], { payee: a0.address });
const p0 = await read("get_payout", [pid]), p1 = await settled("get_payout", [pid + 1], (x) => x.kind === "withdraw");
check(p0.kind === "reward" && BigInt(p0.amount) === FEE + REWARD && p0.to.toLowerCase() === me.toLowerCase(), `payout ${pid}: fee + reward to the reader`);
check(p1.kind === "withdraw" && BigInt(p1.amount) === REWARD + 2n * FEE, `payout ${pid + 1}: pool withdrawal`);
await settle(pid, paid, fromBlock);
await settle(pid + 1, withdrawn, fromBlock);
check(BigInt((await read("get_accounting")).unaccounted) === stray, `balance matches what the contract expects to hold (+${stray} from unexecuted or reverted txs)`);
console.log("contract", address, "article", aid);
