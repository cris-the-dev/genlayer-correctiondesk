# CorrectionDesk — bounties for factual errors in published articles

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Newsrooms say they welcome corrections, but a reader who spots a wrong date or
number has no way to make the error count: the email goes to the same desk that
published it, and nothing records whether it was fixed. **CorrectionDesk** puts
a bounty on accuracy. A publisher registers an article and funds a pool; a
reader who quotes a statement from it and cites a source that contradicts it is
paid, in the same transaction, when GenLayer validators agree that the source
really does contradict the statement. Every report and its verdict stay on
chain, so each article carries a public corrections log and each publisher a
record of errors caught.

```
publisher ── register_article(url, title, reward, fee) + pool ─▶ CorrectionDesk
reader    ── report(article, quote, article_sha256, source_url, source_sha256, explanation) + exact fee
             validators fetch both pages and check both hashes, then:
             quote not in the article text      ─▶ quote_not_found    fee to the pool
             source does not contradict it      ─▶ not_contradicted   fee to the pool
             source directly contradicts it     ─▶ accepted           fee + reward to the reader
publisher ── fund(article) / withdraw_pool(article, amount)
anyone    ── settle_payout(payout, tx, finalize_tx) / payee ── recover(to)
```

One transaction per report, no waiting windows: the verdict and the payout
happen when the report is decided.

## Live deployment

App: https://correctiondesk.cristhedev.com (articles, corrections logs, publisher records and every role's actions; source in [`app/`](app/))  
Testnet Bradbury Phase 2 (chainId 4221, GenVM v0.3): [`0x72BC664a5A060326a8679Ed464DE2E68141f5982`](https://explorer-bradbury.genlayer.com/address/0x72BC664a5A060326a8679Ed464DE2E68141f5982)

## Bradbury evidence

Run by [`tests/integration/bradbury.mjs`](tests/integration/bradbury.mjs) on Bradbury Phase 2 (all checks passed). Contract `0x72BC664a5A060326a8679Ed464DE2E68141f5982` (deploy [`0xb8f16802…`](https://explorer-bradbury.genlayer.com/tx/0xb8f16802ab1268e58e7e1ee167fe66b13625d3de7e9fe95a9e72299360b5f0f8)), code `build/correction_desk.py` (sha256 `3d0f644b…`). Publisher and reader are separate accounts. Pages are served from [`evidence/`](evidence/) and pinned by hash. The leader's note on the accepted report (not part of consensus): "The statement claims the bridge was built in 1932, whereas the source states its construction was completed in 1928."

| Step | Transaction | Outcome |
|---|---|---|
| register article #0: reward 0.001, fee 0.0001, pool 0.002 GEN | [`0xce65f292…`](https://explorer-bradbury.genlayer.com/tx/0xce65f292ce7f8fcadfe7fb086bd1f3471ef41982e8106b39000e0d3842d51c9a) | ok |
| report with half the fee | [`0xc9fe4119…`](https://explorer-bradbury.genlayer.com/tx/0xc9fe4119428420ef996069e94d245ceed0b7459f5de7786123126b6a7438f354) | rejected: exact fee required |
| report with a stale article hash | [`0x50c483d3…`](https://explorer-bradbury.genlayer.com/tx/0x50c483d301afc09955df3bc966bc4b348263ed7f54983b4c725429401bf3face) | reverts: article does not match its sha256 |
| report citing a missing source (404) | [`0xa7e27a6e…`](https://explorer-bradbury.genlayer.com/tx/0xa7e27a6e12037782f361463eca2b099d7fbcc85dcdf4b1bf5539470281228b27) | reverts: source unavailable; no report recorded |
| report a misquote (1925, not in the article) | [`0x42d0ea77…`](https://explorer-bradbury.genlayer.com/tx/0x42d0ea770203a23c0229e0d5ddc0a75060d231fd0f1ee8368acda312acf39358) | `quote_not_found`, fee to the pool |
| report citing an unrelated source (weather page) | [`0x23f6f23f…`](https://explorer-bradbury.genlayer.com/tx/0x23f6f23fa6a0863b227c6a1af250b9ce0877f54347a34d89a9e86d609cd0ef0b) | `not_contradicted`, fee to the pool |
| report "built in 1932" against the register (1928) | [`0x31d2f73f…`](https://explorer-bradbury.genlayer.com/tx/0x31d2f73fcb42d38dfb22f0a31a9f0a3fd6dedc0320442a0363567a6d73804b97) | **accepted**: fee + reward = payout 0; 3 reports on record |
| report the same statement again | [`0x9f3b364b…`](https://explorer-bradbury.genlayer.com/tx/0x9f3b364bfc84d00514af5cc13ecaacd10aa723f946a2a24e8b7767738898bdb9) | rejected: already corrected |
| the reader tries to withdraw the pool | [`0xac2aa7d5…`](https://explorer-bradbury.genlayer.com/tx/0xac2aa7d519f80469d582263977b912401814877df5634a5db82b7001b1f0f970) | rejected: publisher only |
| publisher withdraws the pool | [`0xb8b2c850…`](https://explorer-bradbury.genlayer.com/tx/0xb8b2c850109eaa0c2115f001d7fe286a37f70cb60816f56be6d31d4067b72716) | payout 1 |

Publisher record afterwards: 1 article, 1 correction. Both payouts were settled from their own transfer once the paying transaction finalized:

| Payout | Kind | Paid by | Finalized by | `settle_payout` | Result |
|---|---|---|---|---|---|
| 0 | fee + reward → reader | [`0x31d2f73f…`](https://explorer-bradbury.genlayer.com/tx/0x31d2f73fcb42d38dfb22f0a31a9f0a3fd6dedc0320442a0363567a6d73804b97) | [`0x0e7b6cbd…`](https://explorer-bradbury.genlayer.com/tx/0x0e7b6cbd4e47ca072ec7777b40fc31217dafb390376b2e673dd0fe8eaa72ff1a) | [`0x05c427d0…`](https://explorer-bradbury.genlayer.com/tx/0x05c427d09be5cb5fc827d19785fe339993578e96573fa01790646807e2dab442) | DELIVERED |
| 1 | withdraw → publisher | [`0xb8b2c850…`](https://explorer-bradbury.genlayer.com/tx/0xb8b2c850109eaa0c2115f001d7fe286a37f70cb60816f56be6d31d4067b72716) | [`0xb4d8a47a…`](https://explorer-bradbury.genlayer.com/tx/0xb4d8a47a4151138152d29d7f62282df542927a40e392b2b2d8e500ca47389425) | [`0x37d8d9a1…`](https://explorer-bradbury.genlayer.com/tx/0x37d8d9a15d86301ec50edee407be6f5a80a4e2ad5d1fdd44930949290bc0cfe7) | DELIVERED |

Settling the same payout again is rejected ([`0xb5b1b3db…`](https://explorer-bradbury.genlayer.com/tx/0xb5b1b3db506aa6428d746e703c3ca072616a35c311ddadf24b89340af92305d5), [`0x41c96a22…`](https://explorer-bradbury.genlayer.com/tx/0x41c96a2219267208a0977bd2776744688b8180196be9dc51a7858071586093bc)). Afterwards `get_accounting` reports `unaccounted: 0.00035` GEN: exactly the value attached to the four reverted report transactions (half fee + 3 × fee). On Bradbury a reverted payable transaction leaves its value in the contract; the contract never recorded it, so no one can withdraw it, and the E2E counts it explicitly.

## How a report is judged

1. **Pinned pages.** The reader submits the SHA-256 of the article and of the
   source as they read them. Each validator fetches both pages and checks the
   bytes against those hashes. A page that changed (the publisher quietly
   fixed it, or the source was edited) or cannot be fetched reverts the
   report: nothing is recorded and the fee stays with the reader.
2. **The quote check is text, not judgment.** The article's visible text
   (scripts and styles removed, entities decoded, inline tags joined) is
   searched for the quote, ignoring case, whitespace, quote marks and dash
   style. If it is not there the verdict is `quote_not_found` and the LLM is
   never asked. A reader cannot get paid for a sentence the article never
   said.
3. **One narrow question.** Otherwise the LLM sees the statement, the article
   for context, the source and the reader's explanation, all fenced as data,
   and answers one thing: does the source directly contradict a factual claim
   (a date, number, name, place, event) in the statement? Opinions,
   predictions, wording, or a source that is merely silent or vaguer do not
   count. The reader's explanation can point to the passage but is not
   evidence.
4. **Consensus on the verdict.** Every validator re-derives the verdict from
   its own fetch and its own LLM call and accepts the leader's result only if
   the verdict matches. The leader's one-sentence note is stored as
   `note` and labelled unverified everywhere. The same fetch error is agreed
   on only when a validator reproduces it; an LLM error is never agreed on.

## Where the money goes

- Each article has its own pool, funded by the publisher (`register_article`,
  `fund`). A report is accepted only while the pool covers one reward.
- **Accepted:** the reader gets the fee back plus the reward, the pool drops by
  the reward, the article's `corrections` and the publisher's record go up.
- **Rejected** (`quote_not_found`, `not_contradicted`): the fee goes to the
  article's pool. That is the anti-spam cost; it funds future rewards.
- The same statement (normalized) is paid once per article. A rejected
  statement can be reported again with a better source.
- The publisher can withdraw the pool at any time. CorrectionDesk does not
  lock publishers in; the record of what was corrected stays either way.

## Payments and settlement

Every transfer is a recorded payout (with its sender and creation time). A
payout is judged by its own transfer, never by the contract balance:
`settle_payout(payout_id, tx_hash, finalize_tx)` has validators read the paying
transaction (it must be this contract's `report`, `withdraw_pool` or `recover`
call for that payout, sent by the recorded sender at the recorded time, and
finalized with a successful result) and the consensus transaction that
finalized it, and check that the transfer to the payee was executed. Delivered
payouts are marked `DELIVERED`; a failed one is `FAILED` and its amount becomes
recoverable by the payee (by the sender, for a failed `recover`), who sends it
anywhere with `recover`. A withdrawal is also bound to its amount. One paying
transaction settles at most one payout, and a sender can create one payout per
second. `get_payouts(start, limit, only_unsettled)` pages through payouts, so
old unsettled payouts are always found. `get_accounting` (balance vs.
`expected_balance`) is informational only.

## Limits

- The judgment is about one statement against one source. Validators do not
  decide which source is right in general; they decide whether the cited
  source contradicts the statement. A publisher who disagrees with an
  accepted correction can say so; the record shows the source and its hash.
- Pages are fetched as served (no JavaScript rendering) and the LLM sees the
  first 12,000 characters of each. The quote check covers the whole article.
- Hashing pins pages, so dynamic pages (rotating ads, timestamps) cannot be
  reported until they serve stable bytes.

## The app

https://correctiondesk.cristhedev.com ([`app/`](app/)) reads the **finalized**
state and treats a write as done only when it is `FINALIZED` with
`FINISHED_WITH_RETURN` **and** reading the contract back shows the change.
Reports are shown per article as a corrections log (accepted statements struck
through, the leader's note labelled unverified). The report form needs both
hashes; "Fill hashes" computes them in the browser where the site allows it,
otherwise `curl -s URL | shasum -a 256`. The report button is disabled when the
pool cannot cover a reward. GEN amounts use BigInt only. "Settle" finds the
paying transaction (remembered by the browser that sent it, or pasted) and
looks up its finalization from the `TransactionFinalized` log.
`node app/check-actions.mjs app/index.html` (CI) asserts the controls per role
and pool state and exact money formatting.

## API

| Method | Who | Notes |
|---|---|---|
| `register_article(url, title, reward, fee)` payable | publisher | pool = `msg.value` |
| `fund(id)` payable / `withdraw_pool(id, amount)` | anyone / publisher | withdraw ≤ pool |
| `report(id, quote, article_sha256, source_url, source_sha256, explanation)` payable | anyone | exactly the fee; quote 20–500 chars; returns the verdict |
| `settle_payout(payout_id, tx_hash, finalize_tx)` / `recover(to)` | anyone / payee | |
| `get_article`, `get_articles(start, limit)`, `get_report`, `get_reports(article_id or -1, start, limit, only_accepted)`, `get_publisher(addr)`, `get_payout`, `get_payouts(start, limit, only_unsettled)`, `get_accounting`, `get_recoverable` | view | |

## Run

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
genvm-lint check contracts/correction_desk.py
pytest tests/direct -v                         # 37 tests
# end-to-end on Bradbury Phase 2, against the packed code (keys in GL_PK0, GL_PK1)
python deploy/shrink.py contracts/correction_desk.py build/correction_desk.py --pack
npm i genlayer-js@2.0.0-rc.2   # plus the fee-estimate patch in app/README.md
node tests/integration/bradbury.mjs build/correction_desk.py
```

Bradbury rejects deploys above ~20 KB of code; deploy the output of
`deploy/shrink.py` (AST-checked, 28.9 KB → 8.2 KB packed). CI re-runs all
direct tests against the packed code. The pages the E2E reports on are in
[`evidence/`](evidence/), served byte for byte at
`https://correctiondesk.cristhedev.com/evidence/`.

## Tests (37 direct, Bradbury E2E)

- **Verdicts** — the real error is accepted and pays fee + reward; a misquote is `quote_not_found` with no LLM involved; an unrelated source is `not_contradicted`; both rejected fees go to the pool; quote matching ignores markup, entities, case and spacing but not script text.
- **Pinning and fetch failures** — a wrong article or source hash, a source edited after the reader hashed it, and an unavailable article all revert with nothing recorded.
- **Money** — exact fee, the pool must cover a reward, the same statement paid once (after normalization), a rejected statement reported again, publisher-only withdraw bounded by the pool, no payout beyond the contract balance.
- **Settlement** — delivered and failed rewards, recovery to another address, withdraw bound to its amount; wrong method, args, sender, time, result, or a transaction that sent nothing are rejected and the payout stays `SENT`.
- **Consensus (validator replay)** — agreement on the verdict, disagreement when a validator's LLM differs, the note outside consensus, forged payloads rejected, a misquote agreed without the LLM.
- **App** — `check-actions.mjs`: controls per role and pool state, consensus vs unverified note display, escaping, exact GEN amounts beyond 2^53.

## License

MIT
