"""Articles, the three verdicts, pinning, funds and payout settlement."""

import pytest

from tests.direct.conftest import (
    ARTICLE,
    ARTICLE_URL,
    FEE,
    POOL,
    QUOTE,
    REWARD,
    SOURCE,
    UNRELATED_URL,
    chain_balance,
    pages,
    report,
    sha,
    tick,
    to_hex,
)

OTHER = "0x" + "77" * 20


def test_register(desk, direct_alice):
    a = desk.get_article(0)
    assert a["publisher"].lower() == to_hex(direct_alice).lower() and a["url"] == ARTICLE_URL
    assert (a["reward"], a["fee"], a["pool"], a["reports"], a["corrections"]) == (REWARD, FEE, POOL, 0, 0)
    assert desk.get_publisher(to_hex(direct_alice)) == {"articles": 1, "corrections": 0}
    assert desk.get_articles(0, 10)["total"] == 1


@pytest.mark.parametrize(
    "url, title, reward, fee, msg",
    [("ftp://x.example/a", "Title", 1, 1, "http(s)"), (ARTICLE_URL, "x", 1, 1, "3-120"), (ARTICLE_URL, "Title", 0, 1, "positive"), (ARTICLE_URL, "Title", 1, 0, "positive")],
)
def test_register_validation(desk, direct_vm, url, title, reward, fee, msg):
    with direct_vm.expect_revert(msg):
        desk.register_article(url, title, reward, fee)


def test_accepted_correction_pays_fee_and_reward(desk, direct_vm, direct_alice, direct_bob, ledger):
    assert report(direct_vm, desk, direct_bob) == "accepted"
    assert ledger.paid_to(direct_bob) == FEE + REWARD
    a = desk.get_article(0)
    assert a["pool"] == POOL - REWARD and a["corrections"] == 1 and a["reports"] == 1
    r = desk.get_report(0)
    assert r["verdict"] == "accepted" and r["quote"] == QUOTE and r["source_sha256"] == sha(SOURCE) and r["note"] == "1932 vs 1928"
    assert desk.get_publisher(to_hex(direct_alice))["corrections"] == 1
    assert desk.get_payout(0)["kind"] == "reward" and desk.get_payout(0)["ref"] == 0
    assert desk.get_accounting()["expected_balance"] == POOL - REWARD


def test_a_fake_quote_is_rejected_without_the_llm(desk, direct_vm, direct_bob, ledger):
    quote = "The Elm Street bridge, built in 1928, reopened on Monday"
    assert report(direct_vm, desk, direct_bob, contradicted=True, quote=quote) == "quote_not_found"
    assert ledger.transfers == [] and desk.get_article(0)["pool"] == POOL + FEE


def test_quote_matching_ignores_markup_case_and_typography(desk, direct_vm, direct_bob):
    art = ARTICLE.replace("built in 1932,", "built&nbsp;in <b>1932</b>,").replace("The Elm", "The   ELM")
    quote = "the elm street bridge, built in 1932, reopened on monday"
    assert report(direct_vm, desk, direct_bob, quote=quote, article=art, a_sha=sha(art)) == "accepted"


def test_script_text_is_not_article_text(desk, direct_vm, direct_bob):
    assert report(direct_vm, desk, direct_bob, quote="var x='hidden'; and more text here") == "quote_not_found"


def test_an_irrelevant_source_is_rejected(desk, direct_vm, direct_bob, ledger):
    assert report(direct_vm, desk, direct_bob, contradicted=False, source_url=UNRELATED_URL) == "not_contradicted"
    assert ledger.transfers == [] and desk.get_article(0)["pool"] == POOL + FEE
    assert desk.get_reports(0, 0, 10, True)["items"] == [] and len(desk.get_reports(-1, 0, 10, False)["items"]) == 1


def test_the_same_statement_is_paid_once(desk, direct_vm, direct_bob, direct_charlie):
    report(direct_vm, desk, direct_bob)
    tick(direct_vm)
    with direct_vm.expect_revert("already corrected"):
        report(direct_vm, desk, direct_charlie, quote="  the ELM street bridge, built in 1932,  reopened on Monday ")


def test_a_rejected_statement_can_be_reported_again(desk, direct_vm, direct_bob):
    report(direct_vm, desk, direct_bob, contradicted=False)
    tick(direct_vm)
    assert report(direct_vm, desk, direct_bob) == "accepted"


@pytest.mark.parametrize(
    "kw, msg",
    [
        ({"value": FEE - 1}, "exactly the report fee"),
        ({"value": 0}, "exactly the report fee"),
        ({"quote": "too short"}, "20-500"),
        ({"source_url": ARTICLE_URL}, "another http(s) url"),
        ({"source_url": "javascript:alert(1)"}, "another http(s) url"),
        ({"s_sha": "abc"}, "64 hex"),
    ],
)
def test_report_validation(desk, direct_vm, direct_bob, kw, msg):
    with direct_vm.expect_revert(msg):
        report(direct_vm, desk, direct_bob, **kw)


def test_pages_are_pinned_by_hash(desk, direct_vm, direct_bob):
    with direct_vm.expect_revert("article does not match its sha256"):
        report(direct_vm, desk, direct_bob, a_sha="0" * 64)
    with direct_vm.expect_revert("source does not match its sha256"):
        report(direct_vm, desk, direct_bob, s_sha="0" * 64)
    edited = SOURCE.replace("1928", "1932")
    with direct_vm.expect_revert("source does not match its sha256"):
        report(direct_vm, desk, direct_bob, source=edited)  # edited after the reader hashed it
    assert desk.get_article(0)["reports"] == 0


def test_an_unavailable_article_reverts(desk, direct_vm, direct_bob):
    with direct_vm.expect_revert("article unavailable (HTTP 404)"):
        report(direct_vm, desk, direct_bob, status=404)


def test_the_pool_must_cover_a_reward(desk, direct_vm, direct_alice, direct_bob, direct_charlie):
    report(direct_vm, desk, direct_bob)
    direct_vm.sender = direct_alice
    tick(direct_vm)
    desk.withdraw_pool(0, POOL - REWARD)
    tick(direct_vm)
    with direct_vm.expect_revert("pool cannot cover"):
        report(direct_vm, desk, direct_charlie, quote="reopened on Monday after a two-year repair")
    direct_vm.value = REWARD
    desk.fund(0)
    direct_vm.value = 0
    assert desk.get_article(0)["pool"] == REWARD


def test_only_the_publisher_withdraws(desk, direct_vm, direct_alice, direct_bob, ledger):
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("not authorised"):
        desk.withdraw_pool(0, 1)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("1..pool"):
        desk.withdraw_pool(0, POOL + 1)
    desk.withdraw_pool(0, POOL)
    assert ledger.paid_to(direct_alice) == POOL and desk.get_article(0)["pool"] == 0


def test_a_payout_needs_the_balance(desk, direct_vm, direct_alice):
    chain_balance(direct_vm, POOL - 1)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("contract balance below payout"):
        desk.withdraw_pool(0, POOL)


# ── Consensus ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("mine, ok", [(True, True), (False, False)])
def test_agreement_is_on_the_verdict(desk, direct_vm, direct_bob, mine, ok):
    report(direct_vm, desk, direct_bob)
    pages(direct_vm, mine)
    assert direct_vm.run_validator() is ok


def test_the_note_is_not_part_of_consensus(desk, direct_vm, direct_bob):
    report(direct_vm, desk, direct_bob)
    pages(direct_vm, True)
    assert direct_vm.run_validator(leader_result={"verdict": "accepted", "note": "other words"}) is True


def test_forged_payloads_are_rejected(desk, direct_vm, direct_bob):
    report(direct_vm, desk, direct_bob)
    pages(direct_vm, True)
    for bad in ({"verdict": "ACCEPTED"}, {"verdict": True}, {}, {"verdict": "accepted", "note": "x" * 5000}, "accepted"):
        assert direct_vm.run_validator(leader_result=bad) is False


def test_a_fake_quote_needs_no_llm_agreement(desk, direct_vm, direct_bob):
    report(direct_vm, desk, direct_bob, quote="this sentence is nowhere in the article")
    pages(direct_vm, False)
    assert direct_vm.run_validator() is True
    assert direct_vm.run_validator(leader_result={"verdict": "accepted", "note": ""}) is False


# ── Each payout settles from its own transfer ───────────────────────────────


def accepted(desk, vm, who):
    report(vm, desk, who)
    return [0, QUOTE, sha(ARTICLE), "https://records.example/bridge.html", sha(SOURCE), "register says 1928"]


def test_delivered_reward_settles(desk, direct_vm, direct_bob, chain):
    args = accepted(desk, direct_vm, direct_bob)
    tx, fin = chain.pay(desk, 0, "report", args)
    assert desk.settle_payout(0, tx, fin) == "DELIVERED"
    with direct_vm.expect_revert("already settled"):
        desk.settle_payout(0, tx, fin)


def test_failed_reward_is_recoverable(desk, direct_vm, direct_bob, chain, ledger):
    args = accepted(desk, direct_vm, direct_bob)
    tx, fin = chain.pay(desk, 0, "report", args, delivered=False)
    assert desk.settle_payout(0, tx, fin) == "FAILED"
    assert desk.get_recoverable(to_hex(direct_bob)) == FEE + REWARD
    tick(direct_vm)
    direct_vm.sender = direct_bob
    assert desk.recover(OTHER) == FEE + REWARD and ledger.paid_to(OTHER) == FEE + REWARD
    with direct_vm.expect_revert("nothing to recover"):
        desk.recover(OTHER)


def test_withdraw_amount_is_bound_to_the_transaction(desk, direct_vm, direct_alice, chain):
    direct_vm.sender = direct_alice
    desk.withdraw_pool(0, REWARD)
    tx, fin = chain.pay(desk, 0, "withdraw_pool", [0, REWARD - 1], delivered=False)
    with direct_vm.expect_revert("did not create this payout"):
        desk.settle_payout(0, tx, fin)
    tx, fin = chain.pay(desk, 0, "withdraw_pool", [0, REWARD], delivered=False)
    assert desk.settle_payout(0, tx, fin) == "FAILED" and desk.get_recoverable(to_hex(direct_alice)) == REWARD


@pytest.mark.parametrize(
    "kw",
    [{"method": "withdraw_pool"}, {"args": [1]}, {"sender": "0x" + "99" * 20}, {"at": 1}, {"result": 2}, {"delivered": None}],
)
def test_settle_rejects_a_transaction_that_is_not_this_payout(kw, desk, direct_vm, direct_bob, chain):
    args = accepted(desk, direct_vm, direct_bob)
    method, a = kw.pop("method", "report"), kw.pop("args", args)
    tx, fin = chain.pay(desk, 0, method, a, **{"delivered": False, **kw})
    with direct_vm.expect_revert("did not create this payout"):
        desk.settle_payout(0, tx, fin)
    assert desk.get_payout(0)["status"] == "SENT"
