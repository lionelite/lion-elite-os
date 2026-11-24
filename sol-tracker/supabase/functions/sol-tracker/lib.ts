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
// Two tiers. CORE rules are the evidence that a wallet makes money at a size and pace we can follow:
// a wallet that passes all of them goes on the PAPER watch list (no real money), where the scorecard
// measures what copying it actually earns. The other rules are cautions: shown, and required for
// "verified", but not a reason to ignore a profitable wallet. Requiring every rule just to paper-watch
// threw away every profitable wallet found (2026-11-24: 0 of 103 passed all, while 6 had real
// 30/60/90-day profit), and left only Kolscan names whose paper copies all lost money.
// Real money is unchanged: it still needs traderScore() eligibility AND the owner's Telegram approval.
export const CORE_RULES = [
  "History covers the window",
  "Profitable over 30, 60 and 90 days",
  "Enough closed positions (20+ over 90d)",
  "Copyable size (median buy 0.5–10 SOL)",
  "Still active (traded in the last 7 days)",
];
export function assess(m: any, days = 90, nowSec = Math.floor(Date.now() / 1000)) {
  const rules: { rule: string; pass: boolean; detail: string; core: boolean }[] = [];
  const add = (rule: string, pass: boolean, detail: string) => rules.push({ rule, pass, detail, core: CORE_RULES.includes(rule) });
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
  // Only when the sniper score was computed (research sets it; older results lack it).
  if (m.early_buy_pct !== undefined) {
    add("Buys established coins (< 50% of buys within 1h of launch)", m.early_buy_pct != null && m.early_buy_pct < 50,
      m.early_buy_pct == null ? "launch times unknown" : `${m.early_buy_pct}% of ${m.early_buy_known} buys within 1h of the token's launch`);
  }
  const failed = rules.filter((r) => !r.pass);
  const coreFailed = failed.filter((r) => r.core);
  return {
    qualifies: failed.length === 0, // verified: every rule
    watch: coreFailed.length === 0, // paper watch list: every core rule
    passed: rules.length - failed.length, total: rules.length, rules,
    cautions: failed.filter((r) => !r.core).map((r) => r.rule),
  };
}

// Best paper-watch candidates first: verified before watch-only, then rules passed, then 90d profit.
export function rankWatch(rows: { wallet: string; metrics: any }[]) {
  return rows
    .filter((r) => r.metrics?.assessment?.watch)
    .sort((a, b) => {
      const x = a.metrics.assessment, y = b.metrics.assessment;
      return Number(y.qualifies) - Number(x.qualifies) || y.passed - x.passed ||
        (b.metrics.d90?.realized_sol ?? 0) - (a.metrics.d90?.realized_sol ?? 0);
    });
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

// ---------- entry filter (paper and live) ----------
// From the owner's 2026-11-23 video lesson ("avoid rugs: lots of holders, high market cap, high volume,
// a website and Twitter"), checked against our own paper results first: all 35 closed paper trades with
// market data failed it, losing $161.89 (avg -24.8%), and the traders we copied bought coins with a median
// $9.9k market cap, 12 minutes after launch. Holder count is not in the market data we have; pair age is
// used as the stand-in (a coin minutes old cannot have a broad holder base yet).
export type EntryRules = {
  enabled: boolean;
  min_mcap_usd: number;
  min_volume24h_usd: number;
  require_website_or_twitter: boolean;
  min_pair_age_hours: number;
  min_holders: number;          // RugCheck totalHolders: the video's "ton of holders", measured (0 = off)
  reject_rug_danger: boolean;   // any RugCheck risk at level "danger", or a coin RugCheck marks rugged
};
export const ENTRY_DEFAULTS: EntryRules = {
  enabled: true, min_mcap_usd: 1_000_000, min_volume24h_usd: 250_000, require_website_or_twitter: true, min_pair_age_hours: 1,
  min_holders: 500, reject_rug_danger: true,
};
// What entryCheck() needs from a RugCheck report (api.rugcheck.xyz/v1/tokens/<mint>/report).
export type RugInfo = { totalHolders: number | null; rugged: boolean; risks: { name: string; level: string }[] };
export const needsRug = (r: EntryRules) => r.enabled && (r.min_holders > 0 || r.reject_rug_danger);
export function entryCheck(mk: any, r: EntryRules = ENTRY_DEFAULTS, nowMs = Date.now()): { pass: boolean; reasons: string[] } {
  if (!r.enabled) return { pass: true, reasons: [] };
  if (!mk) return { pass: false, reasons: ["no market data"] };
  const reasons: string[] = [];
  const usd = (n: number) => "$" + (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : Math.round(n));
  if (!(Number(mk.fdvUsd) >= r.min_mcap_usd)) reasons.push(`market cap ${mk.fdvUsd == null ? "unknown" : usd(Number(mk.fdvUsd))} < ${usd(r.min_mcap_usd)}`);
  if (!(Number(mk.volume24hUsd) >= r.min_volume24h_usd)) reasons.push(`24h volume ${mk.volume24hUsd == null ? "unknown" : usd(Number(mk.volume24hUsd))} < ${usd(r.min_volume24h_usd)}`);
  if (r.require_website_or_twitter && !mk.hasWebsite && !mk.hasTwitter) reasons.push("no website or Twitter listed");
  if (r.min_pair_age_hours > 0) {
    const created = mk.pairCreatedAt ? Date.parse(mk.pairCreatedAt) : NaN;
    const ageH = (nowMs - created) / 3600e3;
    if (!(ageH >= r.min_pair_age_hours)) reasons.push(`pair ${Number.isFinite(ageH) ? (ageH * 60).toFixed(0) + " min" : "age unknown"} old < ${r.min_pair_age_hours}h`);
  }
  // Holder data is fail-closed like everything else: no report, no buy.
  if (needsRug(r) && mk.rug !== undefined) {
    const rg: RugInfo | null = mk.rug;
    if (!rg) reasons.push("no RugCheck report");
    else {
      if (rg.rugged) reasons.push("RugCheck marks it rugged");
      if (r.min_holders > 0 && !(Number(rg.totalHolders) >= r.min_holders)) reasons.push(`${rg.totalHolders ?? "unknown"} holders < ${r.min_holders}`);
      const danger = r.reject_rug_danger ? (rg.risks ?? []).filter((x) => x.level === "danger").map((x) => x.name) : [];
      if (danger.length) reasons.push(`RugCheck danger: ${danger.join(", ")}`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

// Share of a trader's buys made within `windowSec` of the token's pair creation: a sniper score.
// Copying a sniper from behind means buying after their buy moved a brand-new micro-cap.
export function earlyBuyShare(buys: { mint: string; t: number }[], pairCreatedSec: Record<string, number | null>, windowSec = 3600): { pct: number | null; known: number } {
  let known = 0, early = 0;
  for (const b of buys) {
    const c = pairCreatedSec[b.mint];
    if (c == null) continue;
    known++;
    if (b.t - c < windowSec) early++;
  }
  return { pct: known ? Math.round((early / known) * 100) : null, known };
}

// ---------- live copy trading: decisions only (execution lives in index.ts) ----------
// Every rule that decides whether real money moves is here so it is tested, not buried in I/O.
export type LiveCfg = {
  enabled: boolean;
  buy_sol: number;              // SOL spent per copied buy
  total_cap_sol: number;        // lifetime SOL spent on buys; buying stops at this number
  max_open_positions: number;
  slippage_bps: number;
  min_sol_reserve: number;      // never spend below this; it pays for sells and fees
  min_liquidity_usd: number;
  max_buy_delay_seconds: number; // copying later than this after the trader's buy is chasing, not copying
  skip_freeze_authority: boolean; // a token whose issuer can freeze accounts may be unsellable
  min_trader_buy_sol: number;   // the trader's own buy must be at least this; smaller buys are tests/dust
  max_loss_sol: number;         // realized live loss at which buying stops by itself (owner re-enables)
};
export const LIVE_DEFAULTS: LiveCfg = {
  enabled: false, buy_sol: 0.25, total_cap_sol: 5, max_open_positions: 8, slippage_bps: 1500,
  min_sol_reserve: 0.03, min_liquidity_usd: 10_000, max_buy_delay_seconds: 120, skip_freeze_authority: true,
  min_trader_buy_sol: 0.25, max_loss_sol: 1.5,
};

export function liveBuyDecision(i: {
  cfg: LiveCfg; keySet: boolean; copyWallet: boolean; spentSol: number; openPositions: number; holdingMint: boolean;
  walletSol: number | null; liquidityUsd: number | null; freezeAuthority: boolean; delaySeconds: number | null;
  traderBuySol?: number | null; realizedPnlSol?: number;
}): { go: boolean; reason: string } {
  const c = i.cfg;
  if (!c.enabled) return { go: false, reason: "Live trading is switched off" };
  if ((i.realizedPnlSol ?? 0) <= -c.max_loss_sol) return { go: false, reason: `Loss limit reached (${(i.realizedPnlSol ?? 0).toFixed(2)} SOL realized, limit -${c.max_loss_sol})` };
  if (!i.keySet) return { go: false, reason: "No trading wallet key (LIVE_TRADER_KEY) is set" };
  if (!i.copyWallet) return { go: false, reason: "This wallet is monitored but not copied" };
  if (i.traderBuySol != null && i.traderBuySol < c.min_trader_buy_sol) return { go: false, reason: `Their buy was ${i.traderBuySol.toFixed(3)} SOL (copy only ${c.min_trader_buy_sol}+)` };
  if (i.holdingMint) return { go: false, reason: "Already holding this token" };
  if (i.spentSol + c.buy_sol > c.total_cap_sol + 1e-9) return { go: false, reason: `Spend cap reached (${i.spentSol.toFixed(2)} of ${c.total_cap_sol} SOL used)` };
  if (i.openPositions >= c.max_open_positions) return { go: false, reason: `Max open positions (${c.max_open_positions}) reached` };
  if (i.walletSol == null) return { go: false, reason: "Could not read the trading wallet balance" };
  if (i.walletSol < c.buy_sol + c.min_sol_reserve) return { go: false, reason: `Trading wallet has ${i.walletSol.toFixed(3)} SOL; needs ${(c.buy_sol + c.min_sol_reserve).toFixed(3)}` };
  if (c.skip_freeze_authority && i.freezeAuthority) return { go: false, reason: "Token has an active freeze authority (may be unsellable)" };
  if (i.liquidityUsd == null || i.liquidityUsd < c.min_liquidity_usd) return { go: false, reason: `Liquidity ${i.liquidityUsd == null ? "unknown" : "$" + Math.round(i.liquidityUsd)} is under $${c.min_liquidity_usd}` };
  if (i.delaySeconds != null && i.delaySeconds > c.max_buy_delay_seconds) return { go: false, reason: `Detected ${Math.round(i.delaySeconds)}s after their buy (limit ${c.max_buy_delay_seconds}s)` };
  return { go: true, reason: "ok" };
}

// How many raw token units to sell when the copied trader sells. FULL exits sell everything we hold;
// a PARTIAL exit sells the same fraction of our position that they sold of theirs.
export function liveSellAmount(heldRaw: bigint, exitType: string | null, exitPct: number | null): bigint {
  if (heldRaw <= 0n) return 0n;
  if (exitType === "FULL" || exitPct == null || exitPct >= 95) return heldRaw;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(exitPct * 100))));
  return (heldRaw * bps) / 10_000n;
}

// ---------- shared copy rules: ONE source for paper and live ----------
// Paper trading is only evidence for live trading if both follow the same rules. Every rule that
// shapes a copied position (size, the fast-flip wait, our own stop-loss and take-profit, the position
// limit) is read from here by both paths, so they cannot drift apart again.
export type CopyRules = {
  buy_sol: number; confirm_hold_seconds: number; stop_loss_pct: number; take_profit_pct: number;
  take_profit_sell_frac: number; max_open_positions: number;
};
export function copyRules(cfg: any): CopyRules {
  const c = cfg?.copy ?? {}, p = cfg?.paper ?? {}, l = cfg?.live ?? {};
  const pick = (k: string, ...alts: any[]) => Number(c[k] ?? alts.find((x) => x != null));
  return {
    buy_sol: pick("buy_sol", l.buy_sol, LIVE_DEFAULTS.buy_sol),
    confirm_hold_seconds: pick("confirm_hold_seconds", p.confirm_hold_seconds, 60),
    stop_loss_pct: pick("stop_loss_pct", p.stop_loss_pct, 25),
    take_profit_pct: pick("take_profit_pct", p.take_profit_pct, 50),
    take_profit_sell_frac: Math.min(1, pick("take_profit_sell_frac", p.take_profit_sell_frac, 0.5)),
    max_open_positions: pick("max_open_positions", l.max_open_positions, p.max_open_positions, 8),
  };
}
// Our own exit, independent of the trader. `entryPrice` is the effective price we paid (fees and
// slippage included), so the move is our real gain or loss before exit costs.
export function riskExit(entryPrice: number, price: number | null, r: CopyRules, tpTaken: boolean):
  { action: "stop" | "take"; frac: number; movePct: number } | null {
  if (!price || !entryPrice) return null;
  const movePct = (price / entryPrice - 1) * 100;
  if (r.stop_loss_pct > 0 && movePct <= -r.stop_loss_pct) return { action: "stop", frac: 1, movePct };
  if (r.take_profit_pct > 0 && movePct >= r.take_profit_pct && !tpTaken) return { action: "take", frac: r.take_profit_sell_frac, movePct };
  return null;
}

// ---------- trader scorecard: watch -> eligible -> live ----------
// A trader earns real money only by first making money on paper under the exact live rules.
// Eligible: >= min_trades closed copies, net positive, average return >= min_avg_pct (a margin for
// the costs paper cannot fully model). Demote: the last `recent_n` copies lost money in total.
export const SCORE_RULES = { min_trades: 20, min_avg_pct: 2, recent_n: 10 };
export function traderScore(closed: { realized: number; cost: number; closedAt: string }[], r = SCORE_RULES) {
  const xs = [...closed].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  const n = xs.length;
  const net = xs.reduce((s, x) => s + x.realized, 0);
  const wins = xs.filter((x) => x.realized > 0).length;
  const avgPct = n ? xs.reduce((s, x) => s + (x.cost ? x.realized / x.cost : 0), 0) / n * 100 : null;
  const recent = xs.slice(-r.recent_n);
  const recentNet = recent.reduce((s, x) => s + x.realized, 0);
  const reasons: string[] = [];
  if (n < r.min_trades) reasons.push(`${n} of ${r.min_trades} paper trades`);
  if (!(net > 0)) reasons.push(`net ${net.toFixed(2)} USD`);
  if (!(avgPct != null && avgPct >= r.min_avg_pct)) reasons.push(`avg ${avgPct == null ? "n/a" : avgPct.toFixed(1)}% < ${r.min_avg_pct}%`);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    n, net: r2(net), win_rate_pct: n ? Math.round((wins / n) * 100) : null, avg_pct: avgPct == null ? null : r2(avgPct),
    recent_net: r2(recentNet), eligible: reasons.length === 0, reasons,
    demote: recent.length >= r.recent_n && recentNet < 0,
  };
}
