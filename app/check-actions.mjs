// Asserts which CorrectionDesk app controls appear per role and pool state, and that GEN amounts are exact
// (run: node app/check-actions.mjs app/index.html).
import { readFileSync } from "node:fs";
const html = readFileSync(process.argv[2], "utf8");
const js = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const body = js.slice(js.indexOf("function actions"), js.indexOf("async function show"));
// gen / toWei come straight from gl.js (which imports the browser bundle, so it is not loaded whole).
const gl = readFileSync(new URL("./gl.js", import.meta.url), "utf8");
const pick = (name) => gl.slice(gl.indexOf(`export const ${name} =`), gl.indexOf("\n};\n", gl.indexOf(`export const ${name} =`)) + 3).replace("export ", "");
const { gen, toWei } = new Function(`${pick("gen")}\n${pick("toWei")}\nreturn { gen, toWei };`)();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const make = new Function("esc", "gen", "B", "ctx", `let me = ctx.me; const cls = { accepted: "ok", quote_not_found: "bad", not_contradicted: "bad" }; ${body}; return { actions, verdict };`);
const PUB = "0xPublisher";
const art = { id: 0, publisher: PUB, reward: 10n ** 15n, fee: 10n ** 14n, pool: 2n * 10n ** 15n };
const fns = (me) => make(esc, gen, BigInt, { me });
const run = (me, a = {}, recov = 0) => fns(me).actions({ ...art, ...a }, recov);
const check = (name, ok) => { console.log(ok ? "ok  " : "FAIL", name); if (!ok) process.exitCode = 1; };

check("no wallet: prompt only", run(null).includes("Connect a wallet") && !run(null).includes("form"));
check("reader: report form with quote, source, both hashes, exact fee", /data-form="report"[\s\S]*name="quote"[\s\S]*name="source"[\s\S]*name="asha"[\s\S]*name="ssha"/.test(run("0xreader")) && run("0xreader").includes("Report for 0.0001 GEN"));
check("report disabled when the pool cannot cover a reward", run("0xreader", { pool: 10n ** 15n - 1n }).includes("disabled") && !run("0xreader").includes("disabled"));
check("reader: no publisher controls", !run("0xreader").includes("fund") && !run("0xreader").includes("withdraw_pool"));
check("publisher (case-insensitive): fund and withdraw up to the pool", run("0xpublisher").includes('data-form="fund"') && run("0xpublisher").includes("max 0.002 GEN"));
check("publisher: no withdraw on an empty pool", !run(PUB, { pool: 0n }).includes("withdraw_pool"));
check("recover only with a failed transfer", run("0xreader", {}, 5n).includes('data-form="recover"') && !run("0xreader", {}, 0n).includes("recover"));
const v = fns("0xreader").verdict;
check("verdicts: consensus result and unverified note kept apart", /contradicts the statement[\s\S]*not verified by consensus\): 1932 vs 1928/.test(v({ verdict: "accepted", note: "1932 vs 1928" })));
check("verdicts: rejected ones say the fee went to the pool", v({ verdict: "quote_not_found", note: "" }).includes("not in the article") && v({ verdict: "not_contradicted", note: "" }).includes("Fee added to the pool"));
check("the note is escaped", !v({ verdict: "accepted", note: "<img src=x onerror=alert(1)>" }).includes("<img"));

// Money: exact in both directions, no floating point.
check("exact amounts", gen(10n ** 14n) === "0.0001" && gen(1) === "0.000000000000000001" && gen(0) === "0");
check("amounts past 2^53 stay exact", gen(9007199254740993n) === "0.009007199254740993" && toWei("0.009007199254740993") === 9007199254740993n);
check("toWei rejects bad input", ["", ".", "1e3", "-1", "0.1234567890123456789", "1,5"].every((s) => { try { toWei(s); return false; } catch { return true; } }));
