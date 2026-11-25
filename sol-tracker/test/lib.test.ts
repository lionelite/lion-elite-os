import { describe, expect, test } from "bun:test";
import { parseSwap, researchMetrics, WSOL, USDC } from "../supabase/functions/sol-tracker/lib.ts";

const W = "Wa11et1111111111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";
const tb = (mint: string, amount: number, owner = W) => ({ mint, owner, uiTokenAmount: { uiAmountString: String(amount) } });
const tx = (o: { pre: number; post: number; preT?: any[]; postT?: any[]; err?: any; signerIdx?: number; fee?: number }) => ({
  slot: 1, blockTime: 1_800_000_000,
  transaction: { message: { accountKeys: (o.signerIdx === 1 ? ["Other", W] : [W, "Other"]).map((pubkey) => ({ pubkey })) } },
  meta: {
    err: o.err ?? null, fee: o.fee ?? 5000,
    preBalances: o.signerIdx === 1 ? [0, o.pre] : [o.pre, 0], postBalances: o.signerIdx === 1 ? [0, o.post] : [o.post, 0],
    preTokenBalances: o.preT ?? [], postTokenBalances: o.postT ?? [],
  },
});

describe("parseSwap", () => {
  test("raw webhook shape (account keys as plain strings) parses the same as jsonParsed", () => {
    const parsed = tx({ pre: 2e9, post: 1.4e9 - 5000, preT: [], postT: [tb(MINT, 1000)] });
    const raw = { ...parsed, transaction: { signatures: ["sig"], message: { accountKeys: [W, "Other"] } } };
    expect(parseSwap(raw, W)).toEqual(parseSwap(parsed, W));
    expect(parseSwap(raw, W).kind).toBe("buy");
  });
  test("SOL -> token is a BUY with the SOL spent (fee excluded)", () => {
    const p = parseSwap(tx({ pre: 2e9, post: 1.4e9 - 5000, preT: [], postT: [tb(MINT, 1000)] }), W);
    expect(p.kind).toBe("buy");
    expect(p.mint).toBe(MINT);
    expect(p.solDelta).toBeCloseTo(-0.6, 6);
    expect(p.tokenDelta).toBe(1000);
  });
  test("WSOL-funded buy counts the WSOL leg as SOL", () => {
    const p = parseSwap(tx({ pre: 1e9, post: 1e9 - 5000, preT: [tb(WSOL, 0.8)], postT: [tb(WSOL, 0), tb(MINT, 50)] }), W);
    expect(p.kind).toBe("buy");
    expect(p.solDelta).toBeCloseTo(-0.8, 6);
  });
  test("token -> SOL is a SELL; partial vs full is visible from pre/post", () => {
    const p = parseSwap(tx({ pre: 1e9, post: 1.9e9, preT: [tb(MINT, 1000)], postT: [tb(MINT, 400)] }), W);
    expect(p.kind).toBe("sell");
    expect(p.tokenPre).toBe(1000);
    expect(p.tokenPost).toBe(400);
  });
  test("token received with no payment is a transfer, not a buy", () => {
    expect(parseSwap(tx({ pre: 1e9, post: 1e9, preT: [], postT: [tb(MINT, 5)] }), W).kind).toBe("transfer_in");
  });
  test("token sent away with no proceeds is a transfer, not a sell", () => {
    expect(parseSwap(tx({ pre: 1e9, post: 1e9 - 5000, preT: [tb(MINT, 5)], postT: [] }), W).kind).toBe("transfer_out");
  });
  test("fee paid by someone else (wallet not signer) is not subtracted twice", () => {
    const p = parseSwap(tx({ pre: 2e9, post: 1.5e9, signerIdx: 1, postT: [tb(MINT, 10)] }), W);
    expect(p.solDelta).toBeCloseTo(-0.5, 6);
  });
  test("USDC-paid buy is a BUY with the stable leg recorded", () => {
    const p = parseSwap(tx({ pre: 1e9, post: 1e9 - 5000, preT: [tb(USDC, 100)], postT: [tb(USDC, 0), tb(MINT, 7)] }), W);
    expect(p.kind).toBe("buy");
    expect(p.stableDelta).toBe(-100);
  });
  test("failed and unrelated transactions are ignored", () => {
    expect(parseSwap(tx({ pre: 1, post: 1, err: { x: 1 } }), W).kind).toBe("failed");
    expect(parseSwap(tx({ pre: 1, post: 1 }), "Nobody").kind).toBe("unrelated");
    expect(parseSwap(tx({ pre: 1e9, post: 1e9 - 5000 }), W).kind).toBe("no_token_change");
  });
  test("token balances owned by other accounts are not attributed to the wallet", () => {
    const p = parseSwap(tx({ pre: 1e9, post: 0.5e9, preT: [], postT: [tb(MINT, 99, "SomeoneElse")] }), W);
    expect(p.kind).toBe("no_token_change");
  });
});

const NOW = 1_800_000_000;
const iso = (daysAgo: number, extraSec = 0) => new Date((NOW - daysAgo * 86400 + extraSec) * 1000).toISOString();
let n = 0;
const buy = (mint: string, daysAgo: number, sol: number, qty: number, s = 0) =>
  ({ signature: `s${n++}`, block_time: iso(daysAgo, s), kind: "buy", mint, sol_delta: -sol, token_delta: qty });
const sell = (mint: string, daysAgo: number, sol: number, qty: number, s = 0) =>
  ({ signature: `s${n++}`, block_time: iso(daysAgo, s), kind: "sell", mint, sol_delta: sol, token_delta: -qty });

describe("researchMetrics", () => {
  test("realized profit uses average cost and splits into 30/60/90-day windows", () => {
    const rows = [
      buy("A", 80, 1, 100), sell("A", 79, 1.5, 100),          // +0.5, 60-90 bucket
      buy("B", 45, 2, 100), sell("B", 44, 1, 50), sell("B", 43, 1.5, 50), // +0.5, 30-60
      buy("C", 10, 1, 100), sell("C", 9, 0.4, 100),           // -0.6, last 30
    ];
    const m = researchMetrics(rows, NOW);
    expect(m.d90.realized_sol).toBeCloseTo(0.4, 6);
    expect(m.d60.realized_sol).toBeCloseTo(-0.1, 6);
    expect(m.d30.realized_sol).toBeCloseTo(-0.6, 6);
    expect(m.month_buckets).toEqual({ last_30: -0.6, days_30_60: 0.5, days_60_90: 0.5 });
    expect(m.d90.tokens_closed).toBe(3);
    expect(m.d90.win_rate_pct).toBe(67);
    expect(m.max_drawdown_sol).toBeCloseTo(0.6, 6);
  });
  test("selling tokens that were never bought (airdrop/transfer) is NOT profit", () => {
    const m = researchMetrics([sell("X", 5, 3, 1000)], NOW);
    expect(m.d90.realized_sol).toBe(0);
    expect(m.unknown_basis_sell_sol).toBe(3);
    const a = m.assessment.rules.find((r: any) => r.rule.startsWith("Profit not driven"));
    expect(a.pass).toBe(false);
  });
  test("selling more than was bought only counts the bought part", () => {
    const m = researchMetrics([buy("Y", 5, 1, 100), sell("Y", 4, 4, 200)], NOW);
    expect(m.d90.realized_sol).toBeCloseTo(1, 6);       // 2 SOL for the 100 bought, cost 1
    expect(m.unknown_basis_sell_sol).toBeCloseTo(2, 6); // other 100 had no recorded buy
  });
  test("open positions are excluded, not counted as gains", () => {
    const m = researchMetrics([buy("Z", 3, 5, 100)], NOW);
    expect(m.d90.realized_sol).toBe(0);
    expect(m.open_positions_excluded).toBe(1);
  });
  test("flags sniper-speed wallets as hard to copy", () => {
    const rows: any[] = [];
    for (let i = 0; i < 10; i++) { rows.push(buy(`F${i}`, 2, 1, 10)); rows.push(sell(`F${i}`, 2, 1.1, 10, 20)); }
    const m = researchMetrics(rows, NOW);
    expect(m.round_trips_under_60s_pct).toBe(100);
    expect(m.assessment.rules.find((r: any) => r.rule.startsWith("Copyable speed")).pass).toBe(false);
  });
  test("a consistent, copyable wallet passes every check", () => {
    const rows: any[] = [];
    for (let d = 1; d <= 88; d += 3) {
      rows.push(buy(`G${d}`, d, 1, 100, 0));
      rows.push(sell(`G${d}`, d, d % 4 === 0 ? 0.8 : 1.3, 100, 3600));
    }
    const m = researchMetrics(rows, NOW);
    const failed = m.assessment.rules.filter((r: any) => !r.pass).map((r: any) => r.rule);
    expect(failed).toEqual([]);
    expect(m.assessment.qualifies).toBe(true);
  });
});

import { poolSwapSide, discoveryVerdict, historyTooShort } from "../supabase/functions/sol-tracker/lib.ts";
describe("discovery pre-filters", () => {
  const P = "Payer11111111111111111111111111111111111111";
  const htx = (o: { native: number; sent?: boolean; got?: boolean; wsolIn?: number; wsolOut?: number; err?: any }) => ({
    feePayer: P, fee: 5000, transactionError: o.err ?? null,
    accountData: [{ account: P, nativeBalanceChange: o.native * 1e9 - 5000 }],
    tokenTransfers: [
      ...(o.sent ? [{ mint: MINT, fromUserAccount: P, toUserAccount: "Pool", tokenAmount: 1000 }] : []),
      ...(o.got ? [{ mint: MINT, fromUserAccount: "Pool", toUserAccount: P, tokenAmount: 1000 }] : []),
      ...(o.wsolIn ? [{ mint: WSOL, fromUserAccount: "Pool", toUserAccount: P, tokenAmount: o.wsolIn }] : []),
      ...(o.wsolOut ? [{ mint: WSOL, fromUserAccount: P, toUserAccount: "Pool", tokenAmount: o.wsolOut }] : []),
    ],
  });
  test("native SOL buy and sell, fee excluded", () => {
    expect(poolSwapSide(htx({ native: -2, got: true }), MINT)).toEqual({ payer: P, side: "buy", sol: 2 });
    expect(poolSwapSide(htx({ native: 3.5, sent: true }), MINT)).toEqual({ payer: P, side: "sell", sol: 3.5 });
  });
  test("pre-held WSOL counts when native barely moves", () => {
    expect(poolSwapSide(htx({ native: 0, sent: true, wsolIn: 4 }), MINT)?.sol).toBe(4);
    expect(poolSwapSide(htx({ native: 0, got: true, wsolOut: 1.5 }), MINT)).toEqual({ payer: P, side: "buy", sol: 1.5 });
  });
  test("wrapped in-tx WSOL is not double counted", () => {
    expect(poolSwapSide(htx({ native: -2, got: true, wsolOut: 2 }), MINT)?.sol).toBe(2);
  });
  test("failed, two-way, or payment-less moves are not trades", () => {
    expect(poolSwapSide(htx({ native: -2, got: true, err: "x" }), MINT)).toBeNull();
    expect(poolSwapSide(htx({ native: -2, got: true, sent: true }), MINT)).toBeNull();
    expect(poolSwapSide(htx({ native: 0, sent: true }), MINT)).toBeNull();
    expect(poolSwapSide(htx({ native: 2, got: true }), MINT)).toBeNull();
  });
  test("verdict keeps only profitable round trips at a copyable size", () => {
    expect(discoveryVerdict({ buys: 1, sells: 2, sol_in: 2, sol_out: 5 })).toEqual({ keep: true, reason: "bought_and_profited" });
    expect(discoveryVerdict({ buys: 0, sells: 3, sol_in: 0, sol_out: 900 }).reason).toBe("sold_without_buying");
    expect(discoveryVerdict({ buys: 2, sells: 1, sol_in: 4, sol_out: 4.5 }).reason).toBe("not_profitable");
    expect(discoveryVerdict({ buys: 1, sells: 1, sol_in: 60, sol_out: 90 }).reason).toBe("uncopyable_size");
    expect(discoveryVerdict({ buys: 1, sells: 1, sol_in: 0.1, sol_out: 1.5 }).reason).toBe("uncopyable_size");
    expect(discoveryVerdict({ buys: 30, sells: 30, sol_in: 30, sol_out: 60 }).reason).toBe("bot_frequency");
    expect(discoveryVerdict({ buys: 1, sells: 0, sol_in: 1, sol_out: 0 }).reason).toBe("no_sell");
  });
  test("history gate rejects only wallets whose whole history is younger than the window", () => {
    const now = 1_800_000_000, day = 86400;
    expect(historyTooShort([{ blockTime: now - day }, { blockTime: now - 10 * day }], 1000, now, 72)).toBe(true);
    expect(historyTooShort([{ blockTime: now - 100 * day }], 1000, now, 72)).toBe(false);
    expect(historyTooShort(Array(1000).fill({ blockTime: now - day }), 1000, now, 72)).toBe(false); // more history exists
    expect(historyTooShort([], 1000, now, 72)).toBe(true);
  });
});

import { liveBuyDecision, liveSellAmount, LIVE_DEFAULTS } from "../supabase/functions/sol-tracker/lib.ts";
describe("live copy trading decisions", () => {
  const ok = { cfg: { ...LIVE_DEFAULTS, enabled: true }, keySet: true, copyWallet: true, spentSol: 0, openPositions: 0,
    holdingMint: false, walletSol: 1, liquidityUsd: 50_000, freezeAuthority: false, delaySeconds: 40 };
  test("buys when every gate is open", () => expect(liveBuyDecision(ok)).toEqual({ go: true, reason: "ok" }));
  test("switched off, no key, or not a copied wallet never buys", () => {
    expect(liveBuyDecision({ ...ok, cfg: { ...ok.cfg, enabled: false } }).go).toBe(false);
    expect(liveBuyDecision({ ...ok, keySet: false }).go).toBe(false);
    expect(liveBuyDecision({ ...ok, copyWallet: false }).go).toBe(false);
  });
  test("the total cap is never exceeded, even by one buy", () => {
    expect(liveBuyDecision({ ...ok, spentSol: 4.75 }).go).toBe(true); // 4.75 + 0.25 = 5 exactly
    expect(liveBuyDecision({ ...ok, spentSol: 4.8 }).reason).toMatch(/Spend cap/);
  });
  test("keeps a fee reserve and refuses risky or late entries", () => {
    expect(liveBuyDecision({ ...ok, walletSol: 0.27 }).reason).toMatch(/needs/);
    expect(liveBuyDecision({ ...ok, walletSol: null }).go).toBe(false);
    expect(liveBuyDecision({ ...ok, freezeAuthority: true }).reason).toMatch(/freeze/);
    expect(liveBuyDecision({ ...ok, liquidityUsd: 5000 }).reason).toMatch(/Liquidity/);
    expect(liveBuyDecision({ ...ok, liquidityUsd: null }).go).toBe(false);
    expect(liveBuyDecision({ ...ok, delaySeconds: 300 }).reason).toMatch(/after their buy/);
    expect(liveBuyDecision({ ...ok, holdingMint: true }).go).toBe(false);
    expect(liveBuyDecision({ ...ok, openPositions: 8 }).go).toBe(false);
    expect(liveBuyDecision({ ...ok, traderBuySol: 0.05 }).reason).toMatch(/Their buy/);
    expect(liveBuyDecision({ ...ok, traderBuySol: 3 }).go).toBe(true);
  });
  test("sell size mirrors the trader's exit", () => {
    expect(liveSellAmount(1000n, "FULL", 100)).toBe(1000n);
    expect(liveSellAmount(1000n, "PARTIAL", 40)).toBe(400n);
    expect(liveSellAmount(1000n, "PARTIAL", 97)).toBe(1000n);
    expect(liveSellAmount(1000n, "PARTIAL", null)).toBe(1000n);
    expect(liveSellAmount(0n, "FULL", 100)).toBe(0n);
  });
});

import { entryCheck, earlyBuyShare, ENTRY_DEFAULTS, assess, rankWatch } from "../supabase/functions/sol-tracker/lib.ts";
describe("entry filter (video lesson, checked against paper results)", () => {
  const now = Date.parse("2026-11-23T00:00:00Z");
  const good = { fdvUsd: 16_400_000, volume24hUsd: 900_000, hasWebsite: true, hasTwitter: true, pairCreatedAt: "2026-11-20T00:00:00Z" };
  test("an established coin with socials passes", () => expect(entryCheck(good, ENTRY_DEFAULTS, now)).toEqual({ pass: true, reasons: [] }));
  test("the typical coin our copied traders bought fails on every count", () => {
    const sniped = { fdvUsd: 9_876, volume24hUsd: 26_462, hasWebsite: false, hasTwitter: false, pairCreatedAt: "2026-11-22T23:48:00Z" };
    const r = entryCheck(sniped, ENTRY_DEFAULTS, now);
    expect(r.pass).toBe(false);
    expect(r.reasons.length).toBe(4);
  });
  test("each rule rejects on its own, and missing data fails closed", () => {
    expect(entryCheck({ ...good, fdvUsd: 900_000 }, ENTRY_DEFAULTS, now).reasons[0]).toMatch(/market cap/);
    expect(entryCheck({ ...good, volume24hUsd: null }, ENTRY_DEFAULTS, now).reasons[0]).toMatch(/volume unknown/);
    expect(entryCheck({ ...good, hasWebsite: false, hasTwitter: false }, ENTRY_DEFAULTS, now).reasons[0]).toMatch(/website/);
    expect(entryCheck({ ...good, hasWebsite: false }, ENTRY_DEFAULTS, now).pass).toBe(true); // Twitter alone is enough
    expect(entryCheck({ ...good, pairCreatedAt: "2026-11-22T23:30:00Z" }, ENTRY_DEFAULTS, now).reasons[0]).toMatch(/30 min/);
    expect(entryCheck({ ...good, pairCreatedAt: null }, ENTRY_DEFAULTS, now).pass).toBe(false);
    expect(entryCheck(null, ENTRY_DEFAULTS, now).pass).toBe(false);
  });
  test("switching the filter off lets everything through", () => {
    expect(entryCheck(null, { ...ENTRY_DEFAULTS, enabled: false }, now).pass).toBe(true);
  });
});
describe("sniper score", () => {
  test("counts buys within an hour of launch among tokens with a known launch time", () => {
    const buys = [{ mint: "A", t: 1000 }, { mint: "B", t: 10_000 }, { mint: "C", t: 500 }, { mint: "D", t: 99 }];
    expect(earlyBuyShare(buys, { A: 0, B: 0, C: null })).toEqual({ pct: 50, known: 2 });
    expect(earlyBuyShare([], {})).toEqual({ pct: null, known: 0 });
  });
  test("research adds the rule only when the score was computed, and unknown fails", () => {
    const base: any = { history_days_covered: 90, d30: { realized_sol: 1 }, d60: { realized_sol: 1 }, d90: { realized_sol: 1, tokens_closed: 30, best_token_share_pct: 10 },
      month_buckets: { a: 1, b: 1, c: 1 }, max_drawdown_sol: 0, round_trips_under_60s_pct: 0, median_buy_sol: 1, unknown_basis_sell_sol: 0, last_trade_at: new Date().toISOString() };
    expect(assess(base).total).toBe(10);
    expect(assess({ ...base, early_buy_pct: 20, early_buy_known: 40 }).qualifies).toBe(true);
    expect(assess({ ...base, early_buy_pct: 70, early_buy_known: 40 }).qualifies).toBe(false);
    expect(assess({ ...base, early_buy_pct: null, early_buy_known: 0 }).qualifies).toBe(false);
  });
});

import { copyRules, riskExit, traderScore, SCORE_RULES } from "../supabase/functions/sol-tracker/lib.ts";
describe("shared copy rules (paper/live parity)", () => {
  test("one source of truth, with fallbacks to the older paper/live fields", () => {
    const r = copyRules({ live: { buy_sol: 0.25, max_open_positions: 8 }, paper: { confirm_hold_seconds: 60, stop_loss_pct: 25, take_profit_pct: 50, take_profit_sell_frac: 0.5 } });
    expect(r).toEqual({ buy_sol: 0.25, confirm_hold_seconds: 60, stop_loss_pct: 25, take_profit_pct: 50, take_profit_sell_frac: 0.5, max_open_positions: 8 });
    expect(copyRules({ copy: { buy_sol: 0.1 }, live: { buy_sol: 0.25 } }).buy_sol).toBe(0.1);
  });
  test("stop-loss sells all, take-profit sells part once", () => {
    const r = copyRules({});
    expect(riskExit(1, 0.74, r, false)?.action).toBe("stop");
    expect(riskExit(1, 0.74, r, false)?.frac).toBe(1);
    expect(riskExit(1, 1.6, r, false)).toEqual({ action: "take", frac: 0.5, movePct: expect.closeTo(60, 5) });
    expect(riskExit(1, 1.6, r, true)).toBeNull();
    expect(riskExit(1, 0.9, r, false)).toBeNull();
    expect(riskExit(1, null, r, false)).toBeNull();
  });
  test("the live loss limit stops buying", () => {
    const ok = { cfg: { ...LIVE_DEFAULTS, enabled: true }, keySet: true, copyWallet: true, spentSol: 0, openPositions: 0,
      holdingMint: false, walletSol: 1, liquidityUsd: 50_000, freezeAuthority: false, delaySeconds: 40 };
    expect(liveBuyDecision({ ...ok, realizedPnlSol: -1.4 }).go).toBe(true);
    expect(liveBuyDecision({ ...ok, realizedPnlSol: -1.5 }).reason).toMatch(/Loss limit/);
  });
});
describe("trader scorecard", () => {
  const t = (realized: number, i: number) => ({ realized, cost: 35, closedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() });
  test("needs 20 trades, net profit, and a margin over costs", () => {
    expect(traderScore(Array.from({ length: 19 }, (_, i) => t(5, i))).eligible).toBe(false);
    const good = traderScore(Array.from({ length: 20 }, (_, i) => t(i % 2 ? 6 : -3, i)));
    expect(good.eligible).toBe(true);
    expect(good.win_rate_pct).toBe(50);
    expect(traderScore(Array.from({ length: 20 }, (_, i) => t(i % 2 ? 3.1 : -3, i))).eligible).toBe(false); // tiny edge
  });
  test("demotes when the most recent copies lose money overall", () => {
    const early = Array.from({ length: 20 }, (_, i) => t(10, i));
    const late = Array.from({ length: SCORE_RULES.recent_n }, (_, i) => t(-2, 100 + i));
    const s = traderScore([...early, ...late]);
    expect(s.eligible).toBe(true);
    expect(s.demote).toBe(true);
  });
});

import { needsRug } from "../supabase/functions/sol-tracker/lib.ts";
describe("holder check (RugCheck), part of the entry filter", () => {
  const now = Date.parse("2026-11-23T00:00:00Z");
  const good = { fdvUsd: 16_400_000, volume24hUsd: 900_000, hasWebsite: true, hasTwitter: true, pairCreatedAt: "2026-11-20T00:00:00Z",
    rug: { totalHolders: 5385, rugged: false, risks: [] } };
  test("a widely held, unflagged coin passes", () => expect(entryCheck(good, ENTRY_DEFAULTS, now).pass).toBe(true));
  test("too few holders, rugged, or a danger-level risk each reject; warnings do not", () => {
    expect(entryCheck({ ...good, rug: { ...good.rug, totalHolders: 349 } }, ENTRY_DEFAULTS, now).reasons).toEqual(["349 holders < 500"]);
    expect(entryCheck({ ...good, rug: { ...good.rug, rugged: true } }, ENTRY_DEFAULTS, now).reasons[0]).toMatch(/rugged/);
    expect(entryCheck({ ...good, rug: { ...good.rug, risks: [{ name: "Top 10 holders high ownership", level: "danger" }] } }, ENTRY_DEFAULTS, now).reasons[0]).toMatch(/danger: Top 10/);
    expect(entryCheck({ ...good, rug: { ...good.rug, risks: [{ name: "Low Liquidity", level: "warn" }] } }, ENTRY_DEFAULTS, now).pass).toBe(true);
  });
  test("a missing report fails closed; the check is skipped only when switched off", () => {
    expect(entryCheck({ ...good, rug: null }, ENTRY_DEFAULTS, now).reasons).toEqual(["no RugCheck report"]);
    expect(entryCheck({ ...good, rug: null }, { ...ENTRY_DEFAULTS, min_holders: 0, reject_rug_danger: false }, now).pass).toBe(true);
    expect(needsRug(ENTRY_DEFAULTS)).toBe(true);
  });
});

describe("research tiers", () => {
  const good: any = { history_days_covered: 90, d30: { realized_sol: 27 }, d60: { realized_sol: 29 }, d90: { realized_sol: 61, tokens_closed: 300, best_token_share_pct: 20 },
    month_buckets: { a: 27, b: 2, c: 31 }, max_drawdown_sol: 5, round_trips_under_60s_pct: 10, median_buy_sol: 1, unknown_basis_sell_sol: 0, last_trade_at: new Date().toISOString() };
  test("a profitable wallet that only fails cautions is paper-watched, not verified (64aa on 2026-11-24)", () => {
    const a = assess({ ...good, round_trips_under_60s_pct: 33, max_drawdown_sol: 40 });
    expect(a.qualifies).toBe(false);
    expect(a.watch).toBe(true);
    expect(a.cautions).toEqual(["Drawdown under half of 90d profit", "Copyable speed (< 30% of round trips under 60s)"]);
  });
  test("losing, too-new, too-small or inactive wallets are never watched", () => {
    expect(assess({ ...good, d30: { realized_sol: -37 } }).watch).toBe(false); // Fashr/Gucci shape
    expect(assess({ ...good, history_days_covered: 42 }).watch).toBe(false);
    expect(assess({ ...good, d90: { ...good.d90, tokens_closed: 5 } }).watch).toBe(false);
    expect(assess({ ...good, median_buy_sol: 0.2 }).watch).toBe(false);
    expect(assess({ ...good, last_trade_at: "2026-01-01T00:00:00Z" }).watch).toBe(false);
  });
  test("ranking: verified first, then checks passed, then 90d profit; non-watch excluded", () => {
    const mk = (wallet: string, m: any) => ({ wallet, metrics: { ...m, assessment: assess(m) } });
    const rows = [
      mk("loser", { ...good, d30: { realized_sol: -1 } }),
      mk("watchBig", { ...good, round_trips_under_60s_pct: 50, d90: { ...good.d90, realized_sol: 500 } }),
      mk("verified", good),
      mk("watchSmall", { ...good, round_trips_under_60s_pct: 50, d90: { ...good.d90, realized_sol: 40 } }),
    ];
    expect(rankWatch(rows).map((r) => r.wallet)).toEqual(["verified", "watchBig", "watchSmall"]);
  });
});
