// Pure, dependency-free logic shared by the edge function and the local tests.
// Nothing here touches the network, the database, keys, or signing.

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// Classify one confirmed transaction from the point of view of `wallet`.
// A BUY needs the wallet to pay SOL/WSOL/stable AND receive a token; a SELL the reverse.
// A token balance change with no quote leg is a transfer, never a trade.
export function parseSwap(tx: any, wallet: string): any {
  if (!tx || !tx.meta) return { kind: "unrelated" };
  if (tx.meta.err) return { kind: "failed" };
  const keys: string[] = tx.transaction.message.accountKeys.map((k: any) => (typeof k === "string" ? k : k.pubkey));
  const idx = keys.indexOf(wallet);
  if (idx < 0) return { kind: "unrelated" };
  const fee = idx === 0 ? tx.meta.fee : 0;
  let sol = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx] + fee) / 1e9;

  const m: Record<string, { pre: number; post: number }> = {};
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (b.owner !== wallet) continue;
    (m[b.mint] ??= { pre: 0, post: 0 }).pre += Number(b.uiTokenAmount?.uiAmountString ?? 0);
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.owner !== wallet) continue;
    (m[b.mint] ??= { pre: 0, post: 0 }).post += Number(b.uiTokenAmount?.uiAmountString ?? 0);
  }
  if (m[WSOL]) { sol += m[WSOL].post - m[WSOL].pre; delete m[WSOL]; }
  let stableDelta = 0;
  let stableMint: string | null = null;
  for (const s of [USDC, USDT]) {
    if (m[s] && m[s].post - m[s].pre !== 0) { stableDelta += m[s].post - m[s].pre; stableMint = s; }
    delete m[s];
  }
  const toks = Object.entries(m)
    .map(([mint, v]) => ({ mint, delta: v.post - v.pre, pre: v.pre, post: v.post }))
    .filter((t) => Math.abs(t.delta) > 0);
  if (toks.length === 0) return { kind: "no_token_change" };

  const ups = toks.filter((t) => t.delta > 0);
  const downs = toks.filter((t) => t.delta < 0);
  const base = { solDelta: sol, stableDelta, stableMint, blockTime: tx.blockTime ?? null, slot: tx.slot };
  if (ups.length && downs.length) {
    const t = ups[0];
    return { kind: "token_swap", mint: t.mint, tokenDelta: t.delta, tokenPre: t.pre, tokenPost: t.post, ...base };
  }
  const t = toks.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  const paidQuote = sol < -0.001 || stableDelta < -0.01;
  const gotQuote = sol > 0.001 || stableDelta > 0.01;
  let kind: string;
  if (t.delta > 0) kind = paidQuote ? "buy" : "transfer_in";
  else kind = gotQuote ? "sell" : "transfer_out";
  return { kind, mint: t.mint, tokenDelta: t.delta, tokenPre: t.pre, tokenPost: t.post, ...base };
}

export type ResearchRow = {
  signature: string; block_time: string | null; kind: string; mint: string | null;
  sol_delta: number | null; token_delta: number | null;
};

const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const pct = (a: number[], p: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const r3 = (n: number | null) => (n == null ? null : Number(n.toFixed(3)));

// Realized results from parsed swaps, average-cost basis in SOL.
// - Only SELLS of tokens the wallet BOUGHT inside the history count as realized profit.
// - Proceeds from selling tokens with no recorded buy (airdrop, insider transfer, bought before the
//   window) are reported separately as unknown_basis_sell_sol and never counted as profit.
// - Tokens still held are open (unrealized) and excluded.
export function researchMetrics(rows: ResearchRow[], nowSec: number, days = 90) {
  const trades = rows
    .filter((r) => (r.kind === "buy" || r.kind === "sell") && r.mint && r.block_time && r.sol_delta != null && r.token_delta != null)
    .map((r) => ({ ...r, t: Math.floor(Date.parse(r.block_time!) / 1000) }))
    .sort((a, b) => a.t - b.t);
  const pos: Record<string, { qty: number; cost: number; firstBuy: number | null }> = {};
  const realized: { t: number; mint: string; pnl: number }[] = [];
  const holds: number[] = [];
  let unknownBasisSol = 0;
  const buySizes: number[] = [];
  const activeDays = new Set<string>();
  for (const tr of trades) {
    const p = (pos[tr.mint!] ??= { qty: 0, cost: 0, firstBuy: null });
    activeDays.add(new Date(tr.t * 1000).toISOString().slice(0, 10));
    if (tr.kind === "buy") {
      const spent = -Number(tr.sol_delta);
      if (spent <= 0) continue;
      buySizes.push(spent);
      p.qty += Number(tr.token_delta);
      p.cost += spent;
      if (p.firstBuy == null) p.firstBuy = tr.t;
    } else {
      const sold = -Number(tr.token_delta);
      const proceeds = Number(tr.sol_delta);
      if (sold <= 0) continue;
      if (p.qty <= 0) { unknownBasisSol += proceeds; continue; }
      const covered = Math.min(sold, p.qty);
      const share = covered / sold;
      const basis = p.cost * (covered / p.qty);
      realized.push({ t: tr.t, mint: tr.mint!, pnl: proceeds * share - basis });
      unknownBasisSol += proceeds * (1 - share);
      p.qty -= covered;
      p.cost -= basis;
      if (p.qty <= 1e-9 || p.cost <= 1e-12) {
        if (p.firstBuy != null) holds.push(tr.t - p.firstBuy);
        p.qty = 0; p.cost = 0; p.firstBuy = null;
      }
    }
  }
  const window = (fromDaysAgo: number, toDaysAgo = 0) => {
    const lo = nowSec - fromDaysAgo * 86400, hi = nowSec - toDaysAgo * 86400;
    const ev = realized.filter((e) => e.t >= lo && e.t < hi);
    const byMint: Record<string, number> = {};
    for (const e of ev) byMint[e.mint] = (byMint[e.mint] ?? 0) + e.pnl;
    const vals = Object.values(byMint);
    const total = vals.reduce((s, v) => s + v, 0);
    const best = vals.length ? Math.max(...vals) : 0;
    return {
      realized_sol: r3(total),
      tokens_closed: vals.length,
      win_rate_pct: vals.length ? Math.round((vals.filter((v) => v > 0).length / vals.length) * 100) : null,
      best_token_sol: r3(best),
      best_token_share_pct: total > 0 ? Math.round((best / total) * 100) : null,
    };
  };
  // Max drawdown of the cumulative realized curve over the whole history.
  let cum = 0, peak = 0, maxDd = 0;
  for (const e of realized) { cum += e.pnl; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); }
  const openPositions = Object.values(pos).filter((p) => p.qty > 0).length;
  const oldest = trades.length ? trades[0].t : null;
  const coverageDays = oldest ? (nowSec - oldest) / 86400 : 0;
  const m = {
    d30: window(30), d60: window(60), d90: window(90),
    month_buckets: { last_30: window(30, 0).realized_sol, days_30_60: window(60, 30).realized_sol, days_60_90: window(90, 60).realized_sol },
    max_drawdown_sol: r3(maxDd),
    swaps_buy: trades.filter((t) => t.kind === "buy").length,
    swaps_sell: trades.filter((t) => t.kind === "sell").length,
    active_days: activeDays.size,
    trades_per_active_day: activeDays.size ? Number((trades.length / activeDays.size).toFixed(1)) : null,
    median_buy_sol: r3(median(buySizes)),
    p90_buy_sol: r3(pct(buySizes, 0.9)),
    buys_at_least_0_5_sol_pct: buySizes.length ? Math.round((buySizes.filter((b) => b >= 0.5).length / buySizes.length) * 100) : null,
    median_hold_seconds: median(holds),
    round_trips: holds.length,
    round_trips_under_60s_pct: holds.length ? Math.round((holds.filter((h) => h < 60).length / holds.length) * 100) : null,
    open_positions_excluded: openPositions,
    unknown_basis_sell_sol: r3(unknownBasisSol),
    history_days_covered: Number(coverageDays.toFixed(1)),
    last_trade_at: trades.length ? new Date(trades[trades.length - 1].t * 1000).toISOString() : null,
  };
  return { ...m, assessment: assess(m, days, nowSec) };
}

// Balanced-risk screen. Returns pass/fail per rule so the reasoning is visible, not just a score.
export function assess(m: any, days = 90, nowSec = Math.floor(Date.now() / 1000)) {
  const rules: { rule: string; pass: boolean; detail: string }[] = [];
  const add = (rule: string, pass: boolean, detail: string) => rules.push({ rule, pass, detail });
  add("History covers the window", m.history_days_covered >= days * 0.8, `${m.history_days_covered} of ${days} days`);
  add("Profitable over 30, 60 and 90 days", [m.d30, m.d60, m.d90].every((w: any) => (w.realized_sol ?? 0) > 0),
    `30d ${m.d30.realized_sol} · 60d ${m.d60.realized_sol} · 90d ${m.d90.realized_sol} SOL realized`);
  const buckets = Object.values(m.month_buckets) as (number | null)[];
  add("Positive in at least 2 of the 3 months", buckets.filter((b) => (b ?? 0) > 0).length >= 2,
    `by month: ${buckets.map((b) => b ?? 0).join(" / ")} SOL`);
  add("Enough closed positions (20+ over 90d)", m.d90.tokens_closed >= 20, `${m.d90.tokens_closed} tokens closed`);
  add("Not one lucky trade (best token < 50% of 90d profit)", m.d90.best_token_share_pct != null && m.d90.best_token_share_pct < 50,
    `best token ${m.d90.best_token_share_pct ?? "n/a"}% of profit`);
  add("Drawdown under half of 90d profit", (m.d90.realized_sol ?? 0) > 0 && m.max_drawdown_sol < m.d90.realized_sol * 0.5,
    `max drawdown ${m.max_drawdown_sol} SOL`);
  add("Copyable speed (< 30% of round trips under 60s)", m.round_trips_under_60s_pct != null && m.round_trips_under_60s_pct < 30,
    `${m.round_trips_under_60s_pct ?? "n/a"}% under 60s, median hold ${m.median_hold_seconds ?? "n/a"}s`);
  add("Copyable size (median buy 0.5–10 SOL)", m.median_buy_sol != null && m.median_buy_sol >= 0.5 && m.median_buy_sol <= 10,
    `median buy ${m.median_buy_sol} SOL, p90 ${m.p90_buy_sol} SOL`);
  add("Profit not driven by transfers/airdrops", (m.unknown_basis_sell_sol ?? 0) < Math.max(1, (m.d90.realized_sol ?? 0) * 0.25),
    `${m.unknown_basis_sell_sol} SOL sold with no recorded buy`);
  add("Still active (traded in the last 7 days)", !!m.last_trade_at && nowSec - Date.parse(m.last_trade_at) / 1000 < 7 * 86400, m.last_trade_at ?? "no trades");
  const failed = rules.filter((r) => !r.pass);
  return { qualifies: failed.length === 0, passed: rules.length - failed.length, total: rules.length, rules };
}

// ---------- discovery pre-filters ----------
// Research costs thousands of RPC calls per wallet, so discovery only queues wallets that already
// look like copyable traders on the evidence it has in hand. Neither filter ever promotes a wallet:
// research still decides. historyTooShort() only rejects wallets research would certainly reject.
// discoveryVerdict() is a heuristic: it also drops a real trader whose buy predates the scanned
// window (~1,500 swaps per pool), which is a cheap false negative next to researching dev wallets.

// One Helius parsed swap on a pool, from the fee payer's side. null when the payer neither clearly
// bought nor clearly sold `mint` (failed tx, token moved both ways, or not involved).
export function poolSwapSide(tx: any, mint: string): { payer: string; side: "buy" | "sell"; sol: number } | null {
  const payer = tx?.feePayer;
  if (!payer || tx.transactionError) return null;
  const tt = tx.tokenTransfers ?? [];
  const sent = tt.some((t: any) => t.mint === mint && t.fromUserAccount === payer);
  const got = tt.some((t: any) => t.mint === mint && t.toUserAccount === payer);
  if (sent === got) return null;
  const acct = (tx.accountData ?? []).find((a: any) => a.account === payer);
  // Native change includes the fee; add it back so a trade is measured without network costs.
  const native = ((acct?.nativeBalanceChange ?? 0) + (tx.fee ?? 0)) / 1e9;
  // A wallet that already held WSOL pays/receives it as a token transfer with ~no native change.
  // When SOL is wrapped/unwrapped inside the tx, the native change already carries it, so prefer it.
  let wsol = 0;
  for (const t of tt) {
    if (t.mint !== WSOL) continue;
    if (t.toUserAccount === payer) wsol += Number(t.tokenAmount ?? 0);
    if (t.fromUserAccount === payer) wsol -= Number(t.tokenAmount ?? 0);
  }
  const sol = Math.abs(native) > 0.01 ? native : wsol;
  if (got && sol < 0) return { payer, side: "buy", sol: -sol };
  if (sent && sol > 0) return { payer, side: "sell", sol };
  return null;
}

export type PoolAgg = { buys: number; sells: number; sol_in: number; sol_out: number };
export const DISCOVERY_RULES = {
  min_profit_sol: 1,        // realized on this coin inside the scanned window
  min_avg_buy_sol: 0.3,     // smaller than this is dust we cannot meaningfully copy
  max_avg_buy_sol: 15,      // larger than this moves the price we would be buying at
  max_swaps_on_pool: 40,    // more swaps on one coin in the window is a bot, not a trader
};
// A seller is worth researching only if it also BOUGHT in the scanned window and came out ahead.
// Selling with no buy is the profile research kept rejecting: dev/bundle/airdrop wallets that
// "sold" thousands of SOL of tokens they never paid for.
export function discoveryVerdict(a: PoolAgg, r = DISCOVERY_RULES): { keep: boolean; reason: string } {
  if (a.sells < 1) return { keep: false, reason: "no_sell" };
  if (a.buys < 1) return { keep: false, reason: "sold_without_buying" };
  if (a.buys + a.sells > r.max_swaps_on_pool) return { keep: false, reason: "bot_frequency" };
  const avgBuy = a.sol_in / a.buys;
  if (avgBuy < r.min_avg_buy_sol || avgBuy > r.max_avg_buy_sol) return { keep: false, reason: "uncopyable_size" };
  if (a.sol_out - a.sol_in < r.min_profit_sol) return { keep: false, reason: "not_profitable" };
  return { keep: true, reason: "bought_and_profited" };
}

// One getSignaturesForAddress page (newest first). If the page is not full we have seen the wallet's
// entire history; if even its oldest signature is younger than `minDays`, the "history covers the
// window" research check cannot pass, so the wallet is not worth the research credits.
export function historyTooShort(sigs: { blockTime?: number | null }[], pageLimit: number, nowSec: number, minDays: number): boolean {
  if (sigs.length >= pageLimit) return false; // more history exists; let research decide
  if (!sigs.length) return true;
  const oldest = sigs[sigs.length - 1]?.blockTime;
  if (typeof oldest !== "number") return false;
  return nowSec - oldest < minDays * 86400;
}
