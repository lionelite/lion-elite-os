// Solana trader monitor: polls tracked wallets, detects swaps, sends Telegram alerts,
// runs a paper-trading simulation, and serves a JSON API for the dashboard.
// Live copy trading (real money) runs only for wallets marked copy_live, only with the owner's own
// LIVE_TRADER_KEY Edge Function secret, and only inside the owner-set per-buy and total caps.
import { createClient } from "npm:@supabase/supabase-js@2";
import { Keypair, VersionedTransaction } from "npm:@solana/web3.js@1.98.0";
import bs58 from "npm:bs58@6.0.0";
import { parseSwap, researchMetrics, assess, rankWatch, poolSwapSide, discoveryVerdict, historyTooShort, liveBuyDecision, liveSellAmount, LIVE_DEFAULTS, entryCheck, earlyBuyShare, ENTRY_DEFAULTS, copyRules, riskExit, traderScore, SCORE_RULES, needsRug, WSOL, USDC, USDT } from "./lib.ts";
import type { PoolAgg, LiveCfg, EntryRules, RugInfo } from "./lib.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
let SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SB_KEY) {
  try {
    const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    SB_KEY = k.default ?? Object.values(k)[0] ?? "";
  } catch { /* ignore */ }
}
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
// Keys come from Edge Function secrets, or from the locked sol_settings 'secrets' row
// (RLS on, no policies: only this function's service role can read it). Env wins if both exist.
let HELIUS_KEY = Deno.env.get("HELIUS_API_KEY") ?? "";
let BIRDEYE_KEY = Deno.env.get("BIRDEYE_API_KEY") ?? "";
let TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
let RPC_URL = "", KEYED_RPC = false, MAX_TX_PER_TICK = 40, SIG_PAGE = 100;
function applyKeys(secrets: any = {}) {
  HELIUS_KEY = Deno.env.get("HELIUS_API_KEY") || secrets.helius_api_key || "";
  BIRDEYE_KEY = Deno.env.get("BIRDEYE_API_KEY") || secrets.birdeye_api_key || "";
  TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || secrets.telegram_bot_token || "";
  RPC_URL = Deno.env.get("SOLANA_RPC_URL") ||
    (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");
  // The public RPC rate-limits hard (HTTP 429); a keyed provider gets a much larger per-minute budget.
  KEYED_RPC = !!(HELIUS_KEY || Deno.env.get("SOLANA_RPC_URL"));
  MAX_TX_PER_TICK = KEYED_RPC ? 150 : 40;
  // Large signature pages are throttled on the public endpoint; keep them small there.
  SIG_PAGE = KEYED_RPC ? 1000 : 100;
}
applyKeys();
const ALERT_MAX_AGE_MIN = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-dashboard-token, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Network errors can echo the request URL; never let an API key reach logs, the DB, or the dashboard.
const clean = (e: unknown) => String(e)
  .replace(/api-key=[^&\s)"']+/gi, "api-key=***")
  .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***");

// ---------- settings ----------
async function getRow(key: string): Promise<any> {
  const { data, error } = await db.from("sol_settings").select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data?.value ?? {};
}
async function setRow(key: string, value: unknown) {
  const { error } = await db.from("sol_settings").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}
async function logEvent(kind: string, message: string, level = "info", wallet: string | null = null) {
  await db.from("sol_events").insert({ kind, message: clean(message).slice(0, 2000), level, wallet });
}

// ---------- Solana RPC with retry / backoff ----------
async function rpc(method: string, params: unknown[], tries = 4): Promise<any> {
  let delay = 600;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`RPC HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(`RPC ${j.error.code}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) { await sleep(delay); delay *= 2; }
    }
  }
  throw new Error(clean(lastErr));
}
const getTx = (sig: string) =>
  rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);

// ---------- market data (DexScreener public API) ----------
type Market = {
  name: string | null; symbol: string | null; priceUsd: number | null; liquidityUsd: number | null;
  fdvUsd: number | null; pairCreatedAt: string | null; volume24hUsd: number | null; dex: string | null; pairUrl: string | null;
  hasWebsite: boolean; hasTwitter: boolean;
};
async function dexPairs(mints: string[]): Promise<Record<string, Market>> {
  const out: Record<string, Market> = {};
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`);
      if (!r.ok) continue;
      const pairs: any[] = await r.json();
      for (const mint of chunk) {
        const ps = pairs.filter((p) => p.baseToken?.address === mint);
        if (!ps.length) continue;
        const p = ps.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        out[mint] = {
          name: p.baseToken?.name ?? null, symbol: p.baseToken?.symbol ?? null,
          priceUsd: p.priceUsd ? Number(p.priceUsd) : null, liquidityUsd: p.liquidity?.usd ?? null,
          fdvUsd: p.fdv ?? null, pairCreatedAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
          volume24hUsd: p.volume?.h24 ?? null, dex: p.dexId ?? null, pairUrl: p.url ?? null,
          hasWebsite: (p.info?.websites ?? []).length > 0,
          hasTwitter: (p.info?.socials ?? []).some((s: any) => /twitter|^x$/i.test(String(s.type ?? s.platform ?? ""))),
        };
      }
    } catch { /* market data is best effort */ }
  }
  return out;
}
let solPriceCache: { at: number; usd: number } | null = null;
async function solUsd(): Promise<number | null> {
  if (solPriceCache && Date.now() - solPriceCache.at < 60_000) return solPriceCache.usd;
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${WSOL}`);
    const pairs: any[] = await r.json();
    const p = pairs
      .filter((p) => p.baseToken?.address === WSOL && [USDC, USDT].includes(p.quoteToken?.address))
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (p?.priceUsd) { solPriceCache = { at: Date.now(), usd: Number(p.priceUsd) }; return solPriceCache.usd; }
  } catch { /* ignore */ }
  return null;
}
async function mintAuthorities(mint: string) {
  try {
    const info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }], 2);
    const p = info?.value?.data?.parsed?.info;
    if (!p) return null;
    return { mintAuthority: p.mintAuthority ?? null, freezeAuthority: p.freezeAuthority ?? null };
  } catch { return null; }
}
function riskFlags(mk: Market | undefined, auth: any, solValue: number | null, sol: number | null) {
  const flags: string[] = [];
  if (!mk) flags.push("No DEX pair data found");
  else {
    if ((mk.liquidityUsd ?? 0) < 20_000) flags.push("Low liquidity (< $20k)");
    if (mk.pairCreatedAt && Date.now() - Date.parse(mk.pairCreatedAt) < 24 * 3600e3) flags.push("Pair under 24h old");
    if (mk.fdvUsd && mk.liquidityUsd && mk.fdvUsd / mk.liquidityUsd > 50) flags.push("FDV more than 50x liquidity");
    if (solValue && sol && mk.liquidityUsd && (solValue * sol) / mk.liquidityUsd > 0.02) flags.push("Trade is > 2% of pool liquidity");
  }
  if (auth?.mintAuthority) flags.push("Mint authority still active");
  if (auth?.freezeAuthority) flags.push("Freeze authority active");
  return flags;
}

// ---------- Telegram ----------
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function tgSend(chatId: string | number, html: string): Promise<number> {
  if (!TG_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN secret is not set");
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram: ${j.description ?? r.status}`);
  return j.result.message_id;
}
const fmt = (n: number | null | undefined, d = 2) =>
  n == null ? "n/a" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
const usd = (n: number | null | undefined) =>
  n == null ? "n/a" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 0 });
const et = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour12: true }) + " ET" : "unknown";

function alertText(t: any, label: string, test = false) {
  const mk = t.market ?? {};
  const isBuy = t.kind === "buy";
  const lines = [
    test ? "🧪 <b>TEST ALERT — not a real trade</b>" : "",
    `${isBuy ? "🟢 <b>BUY</b>" : "🔴 <b>SELL</b>"} — <b>${esc(label)}</b>`,
    `Wallet: <code>${esc(t.wallet)}</code>`,
    `Token: <b>${esc(t.token_name ?? "Unknown")}</b>${t.token_symbol ? ` ($${esc(t.token_symbol)})` : ""}`,
    `Mint: <code>${esc(t.mint)}</code>`,
    `Size: ${fmt(t.sol_value, 3)} SOL${t.quote !== "SOL" ? ` (paid in ${esc(t.quote)} ${fmt(t.quote_amount)})` : ""} · ${fmt(Math.abs(t.token_amount ?? 0), 0)} tokens`,
    `Time: ${esc(et(t.block_time))}`,
    !isBuy && t.exit_type ? `Exit: <b>${t.exit_type}</b>${t.exit_type === "PARTIAL" ? ` (${fmt(t.exit_pct, 0)}% of their position)` : ""}` : "",
    `<i>Market data (DexScreener, at detection):</i> Liquidity ${usd(mk.liquidityUsd)} · FDV ${usd(mk.fdvUsd)} · Price ${usd(mk.priceUsd)}`,
    t.risk?.length ? `<i>Risk indicators:</i> ${t.risk.map(esc).join(" · ")}` : "<i>Risk indicators:</i> none flagged",
    `<a href="https://gmgn.ai/sol/token/${esc(t.mint)}">GMGN token</a> · <a href="https://gmgn.ai/sol/address/${esc(t.wallet)}">GMGN wallet</a> · <a href="https://solscan.io/tx/${esc(t.signature)}">Transaction</a>`,
    "<i>Monitoring only. Not a recommendation.</i>",
  ];
  return lines.filter(Boolean).join("\n");
}

// ---------- paper trading ----------
async function paperState(cfg: any) {
  const { data: ledger } = await db.from("sol_paper_ledger").select("type,usd").in("type", ["buy", "sell", "reset"]).order("at").order("id");
  let cash = cfg.paper.starting_usd;
  for (const l of ledger ?? []) {
    if (l.type === "reset") cash = cfg.paper.starting_usd;
    if (l.type === "buy") cash -= Number(l.usd);
    if (l.type === "sell") cash += Number(l.usd);
  }
  const { data: open } = await db.from("sol_paper_positions").select("*").eq("status", "open");
  return { cash, open: open ?? [] };
}
// Fills are REAL Jupiter quotes taken at fill time: the exact amount a live swap of the same size would
// return, with DEX fees and price impact included, plus the priority fee. A flat "price + 3%" badly
// understates the cost of copying thin meme coins, which is how paper can look good while live loses.
const decCache: Record<string, number> = {};
async function mintDecimals(mint: string): Promise<number | null> {
  if (decCache[mint] != null) return decCache[mint];
  try {
    const info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }], 2);
    const d = info?.value?.data?.parsed?.info?.decimals;
    if (typeof d === "number") { decCache[mint] = d; return d; }
  } catch { /* fall through */ }
  return null;
}
// Paper is priced with the SAME Jupiter Ultra order live executes (route, Jupiter fee, automatic
// slippage, network fees), falling back to a plain quote only if Ultra is unavailable.
async function paperQuote(inputMint: string, outputMint: string, amount: bigint, bps: number): Promise<{ out: bigint; feeSol: number } | null> {
  try {
    // No taker: a quote only, so the live wallet's balance can never change what paper sees.
    const o = await ultraOrder(inputMint, outputMint, amount);
    const fees = Number(o.prioritizationFeeLamports ?? 0) + Number(o.signatureFeeLamports ?? 0) + Number(o.rentFeeLamports ?? 0);
    return { out: BigInt(o.outAmount), feeSol: fees > 0 ? fees / 1e9 : 0.0001 };
  } catch { /* fall back */ }
  try { const q = await jupQuote(inputMint, outputMint, amount, bps); return { out: BigInt(q.outAmount), feeSol: 0.0001 }; } catch { return null; }
}
// Speed: the webhook fast path starts a copied buy's Jupiter quote the moment it parses the trade,
// so it runs alongside the market lookups instead of after them. A prefetched quote is used only
// if it is for the same mint and size and was started within the last 5 s.
const buyPrefetch: Record<string, { at: number; sol: number; q: Promise<{ tokens: number; dec: number; feeSol: number } | null> }> = {};
function prefetchBuy(mint: string, cfg: any) {
  const sol = copyRules(cfg).buy_sol;
  buyPrefetch[mint] = { at: Date.now(), sol, q: quoteBuyTokens(mint, sol, liveCfg(cfg).slippage_bps).catch(() => null) };
  if (needsRug(entryRules(cfg))) rugReport(mint).catch(() => null);
}
function quoteBuyFast(mint: string, sol: number, bps: number) {
  const pf = buyPrefetch[mint];
  delete buyPrefetch[mint];
  if (pf && pf.sol === sol && Date.now() - pf.at < 5000) return pf.q;
  return quoteBuyTokens(mint, sol, bps);
}
async function quoteBuyTokens(mint: string, sol: number, bps: number): Promise<{ tokens: number; dec: number; feeSol: number } | null> {
  const dec = await mintDecimals(mint);
  if (dec == null) return null;
  const q = await paperQuote(WSOL, mint, BigInt(Math.round(sol * 1e9)), bps);
  return q ? { tokens: Number(q.out) / 10 ** dec, dec, feeSol: q.feeSol } : null;
}
async function quoteSellSol(mint: string, tokens: number, dec: number, bps: number): Promise<{ sol: number; feeSol: number } | null> {
  const raw = BigInt(Math.floor(tokens * 10 ** dec));
  if (raw <= 0n) return { sol: 0, feeSol: 0 };
  const q = await paperQuote(mint, WSOL, raw, bps);
  return q ? { sol: Number(q.out) / 1e9, feeSol: q.feeSol } : null;
}

// A copied buy waits copyRules().confirm_hold_seconds (live does the same): if the trader has already
// sold by then it was a fast flip we cannot copy profitably, and it is skipped. Sells keep a short delay.
async function paperOnTrade(t: any, cfg: any) {
  let extra = Number(cfg.paper.exec_delay_seconds ?? 0);
  if (t.kind === "buy") extra = Math.max(extra, copyRules(cfg).confirm_hold_seconds);
  if (extra > 0) {
    await db.from("sol_paper_orders").insert({
      signature: t.signature, wallet: t.wallet, trade: t, due_at: new Date(Date.now() + extra * 1000).toISOString(),
    });
    return;
  }
  await paperExecute(t, cfg, t.market?.priceUsd ?? null);
}
async function processPaperOrders(cfg: any) {
  const { data: due } = await db.from("sol_paper_orders").select("*").eq("status", "queued").lte("due_at", new Date().toISOString()).order("due_at").limit(20);
  if (!due?.length) return 0;
  const prices = await dexPairs([...new Set(due.map((o: any) => o.trade.mint))]);
  const hold = copyRules(cfg).confirm_hold_seconds;
  for (const o of due) {
    try {
      if (o.trade.kind === "buy" && hold > 0) {
        const still = await tokenBalanceRaw(o.wallet, o.trade.mint);
        if (still === 0n) {
          await db.from("sol_paper_ledger").insert({ wallet: o.wallet, mint: o.trade.mint, symbol: o.trade.token_symbol, source_signature: o.signature,
            type: "skip", note: `Fast flip: trader had already sold within ${hold}s, not copied` });
          await db.from("sol_paper_orders").update({ status: "skipped", filled_at: new Date().toISOString() }).eq("id", o.id);
          continue;
        }
      }
      await paperExecute(o.trade, cfg, prices[o.trade.mint]?.priceUsd ?? null);
      await db.from("sol_paper_orders").update({ status: "filled", filled_at: new Date().toISOString() }).eq("id", o.id);
    } catch (e) {
      await db.from("sol_paper_orders").update({ status: "error", error: clean(e) }).eq("id", o.id);
    }
  }
  return due.length;
}
async function paperExecute(t: any, cfg: any, price: number | null) {
  const p = cfg.paper;
  const cr = copyRules(cfg);
  const lc = liveCfg(cfg);
  // delay_seconds = trader's block time -> the moment our fill price is fixed (the quote is in hand).
  const delayNow = () => (t.block_time ? (Date.now() - Date.parse(t.block_time)) / 1000 : null);
  const base: any = { wallet: t.wallet, mint: t.mint, symbol: t.token_symbol, source_signature: t.signature, delay_seconds: delayNow() };
  const skip = (note: string) => db.from("sol_paper_ledger").insert({ ...base, delay_seconds: delayNow(), type: "skip", note });
  if (!price) { await skip("No price available at detection"); return; }
  if (t.kind === "buy") {
    // Speed: the entry filter, paper state, SOL price and the Jupiter quote are independent, so they
    // run at once instead of one after another. The rules applied to the results are unchanged.
    const [ec, { cash, open }, sol, q] = await Promise.all([
      entryCheckFull(t.market, t.mint, cfg), paperState(cfg), solUsd(),
      quoteBuyFast(t.mint, cr.buy_sol, lc.slippage_bps).catch(() => null),
    ]);
    base.delay_seconds = delayNow();
    if (!ec.pass) { await skip(`Entry filter: ${ec.reasons.join("; ")}`); return; }
    if (open.find((o: any) => o.mint === t.mint)) { await skip("Already holding this token"); return; }
    if (open.length >= cr.max_open_positions) { await skip("Max open positions reached"); return; }
    if (!sol) { await skip("No SOL price"); return; }
    if (cash < cr.buy_sol * sol * 1.01) { await skip("Not enough simulated cash"); return; }
    if (!q || !(q.tokens > 0)) { await skip("No Jupiter route at fill time (a live buy would fail too)"); return; }
    const cost = (cr.buy_sol + q.feeSol) * sol; // same SOL size live spends, plus the network fees Ultra quoted
    const fill = cost / q.tokens;
    await db.from("sol_paper_positions").insert({
      wallet: t.wallet, mint: t.mint, symbol: t.token_symbol, source_signature: t.signature,
      entry_price_usd: fill, qty: q.tokens, qty_open: q.tokens, cost_usd: cost, decimals: q.dec,
    });
    await db.from("sol_paper_ledger").insert({ ...base, type: "buy", usd: cost, price_usd: fill,
      note: `SIMULATED buy ${cr.buy_sol} SOL -> ${fmt(q.tokens, 0)} via a real Jupiter quote; effective ${usd(fill)} vs market ${usd(price)} (${fmt((fill / price - 1) * 100, 1)}% total cost)` });
  } else if (t.kind === "sell" && p.copy_sells) {
    const { open } = await paperState(cfg);
    const pos = open.find((o: any) => o.mint === t.mint && o.wallet === t.wallet);
    if (!pos) return;
    const frac = t.exit_type === "FULL" ? 1 : Math.min(1, Math.max(0, (t.exit_pct ?? 100) / 100));
    await paperSell(pos, frac, price, cfg, { ...base, delay_seconds: delayNow }, `${t.exit_type ?? ""} copy sell`);
  }
}
// Sell `frac` of a paper position's remaining tokens: a real Jupiter quote for that amount, minus the
// priority fee. Only if no route exists (or decimals are unknown) is it estimated from the market price.
async function paperSell(pos: any, frac: number, price: number, cfg: any, base: any, reason: string, extra: any = {}) {
  const p = cfg.paper;
  const q = Number(pos.qty_open) * frac;
  const [sol, out] = await Promise.all([
    solUsd(),
    pos.decimals != null ? quoteSellSol(pos.mint, q, Number(pos.decimals), Math.max(liveCfg(cfg).slippage_bps, 2000)).catch(() => null) : null,
  ]);
  // A copy sell passes delay_seconds as a function so it is read when the quote is in hand.
  if (typeof base.delay_seconds === "function") base = { ...base, delay_seconds: base.delay_seconds() };
  const prioUsd = sol ? p.priority_fee_sol * sol : 0;
  let proceeds: number | null = null, how = "Jupiter quote";
  if (out != null && sol) proceeds = Math.max(0, (out.sol - out.feeSol) * sol);
  if (proceeds == null) {
    how = "ESTIMATED, no Jupiter route";
    proceeds = Math.max(0, q * price * (1 - p.slippage_pct / 100) * (1 - p.fee_pct / 100) - prioUsd);
  }
  const fill = q ? proceeds / q : 0;
  const costPart = Number(pos.cost_usd) * (q / Number(pos.qty));
  const left = Number(pos.qty_open) - q;
  const closed = left <= Number(pos.qty) * 0.001;
  await db.from("sol_paper_positions").update({
    qty_open: left, realized_usd: Number(pos.realized_usd) + proceeds - costPart,
    status: closed ? "closed" : "open", closed_at: closed ? new Date().toISOString() : null, ...extra,
  }).eq("id", pos.id);
  await db.from("sol_paper_ledger").insert({ ...base, type: "sell", usd: proceeds, price_usd: fill,
    note: `SIMULATED ${reason}: sold ${Math.round(frac * 100)}% (${how}) @ ${usd(fill)}, P/L ${usd(proceeds - costPart)}` });
}
// Our own exits, independent of the trader, from the shared riskExit() rule (live uses the same one).
// Triggered on the current DexScreener price against our effective entry; executed at a real quote.
async function paperRiskExits(cfg: any) {
  const cr = copyRules(cfg);
  if (!cr.stop_loss_pct && !cr.take_profit_pct) return 0;
  const { data: open } = await db.from("sol_paper_positions").select("*").eq("status", "open");
  if (!open?.length) return 0;
  const prices = await dexPairs([...new Set(open.map((o: any) => o.mint))]);
  let n = 0;
  for (const pos of open) {
    const px = prices[pos.mint]?.priceUsd ?? null;
    const x = riskExit(Number(pos.entry_price_usd), px, cr, !!pos.tp_taken);
    if (!x) continue;
    const base = { wallet: pos.wallet, mint: pos.mint, symbol: pos.symbol, source_signature: pos.source_signature, delay_seconds: null };
    await paperSell(pos, x.frac, px!, cfg, base, x.action === "stop" ? `stop-loss (${x.movePct.toFixed(0)}%)` : `take-profit (+${x.movePct.toFixed(0)}%)`,
      x.action === "take" ? { tp_taken: true } : {});
    n++;
  }
  return n;
}

// ---------- live copy trading (REAL MONEY) ----------
// The key is read only from the LIVE_TRADER_KEY Edge Function secret: never from the database, never
// logged, never returned. Orders are rows in sol_live_orders, unique per (source trade, side), and are
// claimed atomically before execution, so an overlapping tick can never submit the same trade twice.
// Buys obey liveBuyDecision() (lib.ts). Sells of positions we hold run even when buying is switched
// off, so turning live trading off never strands an open position.
let LIVE_KP: Keypair | null = null;
let LIVE_KEY_ERR: string | null = null;
function liveKeypair(): Keypair | null {
  if (LIVE_KP) return LIVE_KP;
  const raw = (Deno.env.get("LIVE_TRADER_KEY") ?? "").trim();
  if (!raw) return null;
  try {
    const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
    LIVE_KP = Keypair.fromSecretKey(bytes);
    LIVE_KEY_ERR = null;
  } catch {
    LIVE_KEY_ERR = "LIVE_TRADER_KEY is set but is not a valid Solana secret key"; // never echo the value
  }
  return LIVE_KP;
}
const liveCfg = (cfg: any): LiveCfg => ({ ...LIVE_DEFAULTS, ...(cfg.live ?? {}) });
const entryRules = (cfg: any): EntryRules => ({ ...ENTRY_DEFAULTS, ...(cfg.entry ?? {}) });
const JUP = "https://lite-api.jup.ag/swap/v1";
const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (u: Uint8Array) => { let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s); };

async function jupQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number) {
  const u = new URL(`${JUP}/quote`);
  u.searchParams.set("inputMint", inputMint);
  u.searchParams.set("outputMint", outputMint);
  u.searchParams.set("amount", amount.toString());
  u.searchParams.set("slippageBps", String(slippageBps));
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok || !j.outAmount) throw new Error(`No Jupiter route: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function jupSwap(quote: any, kp: Keypair): Promise<string> {
  const r = await fetch(`${JUP}/swap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "veryHigh" } },
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.swapTransaction) throw new Error(`Jupiter swap build failed: ${JSON.stringify(j).slice(0, 200)}`);
  const tx = VersionedTransaction.deserialize(b64ToBytes(j.swapTransaction));
  tx.sign([kp]);
  // Preflight on: a swap that would fail (slippage, missing balance) is rejected here, costing nothing.
  return await rpc("sendTransaction", [bytesToB64(tx.serialize()), { encoding: "base64", skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" }], 2);
}
// ---------- RugCheck holder data for the entry filter ----------
const rugCache: Record<string, { at: number; r: RugInfo | null }> = {};
const rugInflight: Record<string, Promise<RugInfo | null>> = {};
function rugReport(mint: string): Promise<RugInfo | null> {
  const c = rugCache[mint];
  if (c && Date.now() - c.at < 10 * 60e3) return Promise.resolve(c.r);
  // A lookup already under way (e.g. started by the webhook fast path) is shared, not repeated.
  return (rugInflight[mint] ??= rugFetch(mint).finally(() => { delete rugInflight[mint]; }));
}
async function rugFetch(mint: string): Promise<RugInfo | null> {
  let r: RugInfo | null = null;
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const j = await res.json();
      r = { totalHolders: typeof j.totalHolders === "number" ? j.totalHolders : null, rugged: !!j.rugged,
        risks: (j.risks ?? []).map((x: any) => ({ name: String(x.name ?? ""), level: String(x.level ?? "") })) };
    }
  } catch { /* fail closed below */ }
  rugCache[mint] = { at: Date.now(), r };
  return r;
}
// The full entry filter. Cheap market checks first; RugCheck only for coins that already pass them.
async function entryCheckFull(market: any, mint: string, cfg: any) {
  const rules = entryRules(cfg);
  const pre = entryCheck(market, rules);
  if (!pre.pass || !needsRug(rules)) return pre;
  return entryCheck({ ...market, rug: await rugReport(mint) }, rules);
}

// ---------- Jupiter Ultra: managed, MEV-protected execution (primary) ----------
// Measured 2026-11-23 on a 0.25 SOL meme-coin buy: Ultra set 1% slippage automatically (our v1 call
// allowed 15%, i.e. up to ~15% extractable by a sandwich bot), a ~0.000025 SOL priority fee (v1 up to
// 0.001), a 0.1% Jupiter fee, and sends through Jupiter's own landing instead of the public mempool.
const ULTRA = "https://lite-api.jup.ag/ultra/v1";
async function ultraOrder(inputMint: string, outputMint: string, amount: bigint, taker?: string): Promise<any> {
  const u = new URL(`${ULTRA}/order`);
  u.searchParams.set("inputMint", inputMint);
  u.searchParams.set("outputMint", outputMint);
  u.searchParams.set("amount", amount.toString());
  if (taker) u.searchParams.set("taker", taker);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.outAmount || (taker && !j.transaction)) {
    throw new Error(`Ultra order HTTP ${r.status}: ${j.errorMessage ? `${j.errorMessage} (code ${j.errorCode})` : JSON.stringify(j).slice(0, 200)}`);
  }
  return j;
}
// Signs and submits through Ultra /execute. The signature is computed locally first: if the network
// call dies after submission we still return it, so liveConfirm() can tell whether it actually landed
// (a lost answer must never leave a real position untracked).
async function ultraExecute(order: any, kp: Keypair): Promise<string> {
  const tx = VersionedTransaction.deserialize(b64ToBytes(order.transaction));
  tx.sign([kp]);
  const localSig = bs58.encode(tx.signatures[0]);
  let j: any;
  try {
    const r = await fetch(`${ULTRA}/execute`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedTransaction: bytesToB64(tx.serialize()), requestId: order.requestId }) });
    j = await r.json();
  } catch { return localSig; }
  if (j?.status === "Success") return j.signature ?? localSig;
  throw new Error(`Ultra execute ${j?.status ?? "error"} ${j?.code ?? ""}: ${String(j?.error ?? "").slice(0, 200)}`);
}
// Live swap: Ultra first. Only when Ultra itself is unreachable or rate-limited (HTTP 429/5xx on the
// order) do we fall back to the plain route, and then with slippage capped at 5%, never the old 15%.
async function liveSwap(inputMint: string, outputMint: string, amount: bigint, kp: Keypair): Promise<{ sig: string; outAmount: string; via: string }> {
  try {
    const o = await ultraOrder(inputMint, outputMint, amount, kp.publicKey.toBase58());
    return { sig: await ultraExecute(o, kp), outAmount: String(o.outAmount), via: `ultra ${o.slippageBps}bps` };
  } catch (e) {
    if (!/Ultra order HTTP (429|5\d\d)/.test(String(e))) throw e;
    const q = await jupQuote(inputMint, outputMint, amount, 500);
    return { sig: await jupSwap(q, kp), outAmount: String(q.outAmount), via: "v1 fallback 500bps" };
  }
}
async function walletSol(pub: string): Promise<number | null> {
  try { return Number((await rpc("getBalance", [pub, { commitment: "confirmed" }]))?.value ?? 0) / 1e9; } catch { return null; }
}
async function tokenBalanceRaw(owner: string, mint: string): Promise<bigint> {
  const res = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  let total = 0n;
  for (const a of res?.value ?? []) total += BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0");
  return total;
}
async function liveSpentSol(): Promise<number> {
  const { data } = await db.from("sol_live_orders").select("sol_amount").eq("side", "buy").in("status", ["executing", "sent", "confirmed"]);
  return (data ?? []).reduce((s: number, r: any) => s + Number(r.sol_amount ?? 0), 0);
}
async function liveNotify(cfg: any, html: string) {
  if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, html).catch(() => {});
}

// Called once per newly recorded trade of a monitored wallet.
// Buys wait the same confirm-hold as paper (then skip fast flips); sells go immediately.
async function liveOnTrade(t: any, w: any, cfg: any) {
  if (!w.copy_live || (t.kind !== "buy" && t.kind !== "sell")) return;
  const hold = t.kind === "buy" ? copyRules(cfg).confirm_hold_seconds : 0;
  await db.from("sol_live_orders").upsert({
    source_signature: t.signature, wallet: t.wallet, mint: t.mint, symbol: t.token_symbol, side: t.kind, trade: t, status: "pending",
    due_at: new Date(Date.now() + hold * 1000).toISOString(),
  }, { onConflict: "source_signature,side", ignoreDuplicates: true });
}
async function liveRealizedSol(): Promise<number> {
  const { data } = await db.from("sol_live_positions").select("sol_in,sol_out").eq("status", "closed");
  return (data ?? []).reduce((s: number, r: any) => s + Number(r.sol_out ?? 0) - Number(r.sol_in ?? 0), 0);
}

async function liveConfirm(cfg: any) {
  const { data: sent } = await db.from("sol_live_orders").select("*").eq("status", "sent").limit(50);
  if (!sent?.length) return 0;
  const st = await rpc("getSignatureStatuses", [sent.map((o: any) => o.tx_signature), { searchTransactionHistory: true }]);
  const { data: labels } = await db.from("sol_wallets").select("address,label");
  const name = (a: string) => (labels ?? []).find((l: any) => l.address === a)?.label ?? a.slice(0, 6);
  let n = 0;
  for (let i = 0; i < sent.length; i++) {
    const o = sent[i], s = st?.value?.[i];
    const link = `<a href="https://solscan.io/tx/${esc(o.tx_signature)}">tx</a>`;
    if (s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      await db.from("sol_live_orders").update({ status: "confirmed", updated_at: new Date().toISOString() }).eq("id", o.id);
      if (o.side === "buy") {
        const dec = await mintDecimals(o.mint);
        const sol = await solUsd();
        const tokens = dec != null && o.token_amount ? Number(o.token_amount) / 10 ** dec : null;
        await db.from("sol_live_positions").upsert({ mint: o.mint, wallet: o.wallet, symbol: o.symbol, sol_in: o.sol_amount, sol_out: 0, status: "open",
          opened_at: new Date().toISOString(), closed_at: null, decimals: dec, token_raw: o.token_amount ?? null, tp_taken: false,
          entry_price_usd: tokens && sol ? (Number(o.sol_amount) * sol) / tokens : null });
        await liveNotify(cfg, `🟢 <b>LIVE BUY</b> ${esc(o.symbol ?? o.mint)}: ${fmt(o.sol_amount, 3)} SOL, copying <b>${esc(name(o.wallet))}</b> · ${link}`);
      } else {
        const { data: p } = await db.from("sol_live_positions").select("*").eq("mint", o.mint).maybeSingle();
        const out = Number(p?.sol_out ?? 0) + Number(o.sol_amount ?? 0);
        await db.from("sol_live_positions").update({ sol_out: out, ...(o.close ? { status: "closed", closed_at: new Date().toISOString() } : {}) }).eq("mint", o.mint);
        await liveNotify(cfg, `🔴 <b>LIVE SELL</b> ${esc(o.symbol ?? o.mint)}${o.close ? " (all)" : " (partial)"}: ~${fmt(o.sol_amount, 3)} SOL back, copying <b>${esc(name(o.wallet))}</b>` +
          (o.close && p ? ` · P/L ~${fmt(out - Number(p.sol_in), 3)} SOL` : "") + ` · ${link}`);
      }
      n++;
    } else if (s?.err) {
      await liveFail(cfg, o, `On-chain error: ${JSON.stringify(s.err).slice(0, 150)}`);
    } else if (Date.now() - Date.parse(o.updated_at) > 120_000) {
      await liveFail(cfg, o, "Not confirmed within 2 minutes (dropped)");
    }
  }
  return n;
}
// A failed buy is final (copying it later would be chasing). A failed sell is retried up to 3 times,
// then the owner is told loudly, because a stuck sell is a position we can no longer exit by copy.
async function liveFail(cfg: any, o: any, reason: string) {
  const attempts = Number(o.attempts ?? 0) + 1;
  const retry = o.side === "sell" && attempts < 3;
  await db.from("sol_live_orders").update({ status: retry ? "pending" : "failed", attempts, error: clean(reason), updated_at: new Date().toISOString() }).eq("id", o.id);
  await logEvent("live", `${o.side} ${o.symbol ?? o.mint} ${retry ? "retrying" : "failed"}: ${reason}`, retry ? "warn" : "error", o.wallet);
  if (!retry) await liveNotify(cfg, o.side === "sell"
    ? `🚨 <b>LIVE SELL FAILED</b> for ${esc(o.symbol ?? o.mint)} after 3 tries: ${esc(clean(reason))}. The position is still open; sell it manually or use Sell all.`
    : `⚠️ Live buy of ${esc(o.symbol ?? o.mint)} failed: ${esc(clean(reason))}`);
}

async function liveExecute(cfg: any) {
  const kp = liveKeypair();
  const lc = liveCfg(cfg);
  const cr = copyRules(cfg);
  const rules: LiveCfg = { ...lc, buy_sol: cr.buy_sol, max_open_positions: cr.max_open_positions };
  const { data: pending } = await db.from("sol_live_orders").select("*").eq("status", "pending")
    .lte("due_at", new Date().toISOString()).order("created_at").limit(5);
  let done = 0;
  for (const o of pending ?? []) {
    // Atomic claim: only one tick can move an order from pending to executing.
    const { data: claimed } = await db.from("sol_live_orders").update({ status: "executing", updated_at: new Date().toISOString() })
      .eq("id", o.id).eq("status", "pending").select("id");
    if (!claimed?.length) continue;
    const skip = async (reason: string) => {
      await db.from("sol_live_orders").update({ status: "skipped", error: reason, updated_at: new Date().toISOString() }).eq("id", o.id);
    };
    try {
      if (!kp) { await skip(LIVE_KEY_ERR ?? "No trading wallet key (LIVE_TRADER_KEY) is set"); continue; }
      const me = kp.publicKey.toBase58();
      const t = o.trade ?? {};
      if (o.side === "buy") {
        const [{ count: openN }, { data: held }, { count: inflight }, spent, bal] = await Promise.all([
          db.from("sol_live_positions").select("*", { count: "exact", head: true }).eq("status", "open"),
          db.from("sol_live_positions").select("mint").eq("mint", o.mint).eq("status", "open").maybeSingle(),
          db.from("sol_live_orders").select("*", { count: "exact", head: true }).eq("mint", o.mint).eq("side", "buy").in("status", ["sent"]),
          liveSpentSol(), walletSol(me),
        ]);
        const ec = await entryCheckFull(t.market, o.mint, cfg);
        if (!ec.pass) { await skip(`Entry filter: ${ec.reasons.join("; ")}`); continue; }
        if (cr.confirm_hold_seconds > 0 && (await tokenBalanceRaw(o.wallet, o.mint)) === 0n) {
          await skip(`Fast flip: trader had already sold within ${cr.confirm_hold_seconds}s, not copied`); continue;
        }
        const d = liveBuyDecision({
          cfg: rules, keySet: true, realizedPnlSol: await liveRealizedSol(), copyWallet: true, spentSol: spent, openPositions: openN ?? 0, holdingMint: !!held || (inflight ?? 0) > 0,
          walletSol: bal, liquidityUsd: t.market?.liquidityUsd ?? null,
          freezeAuthority: (t.risk ?? []).includes("Freeze authority active"),
          delaySeconds: t.block_time ? (Date.now() - Date.parse(t.block_time)) / 1000 : null, traderBuySol: t.sol_value ?? null,
        });
        if (!d.go) { await skip(d.reason); continue; }
        const lamports = BigInt(Math.round(rules.buy_sol * 1e9));
        // Reserve the spend before sending, so the cap holds even if this tick dies mid-flight.
        await db.from("sol_live_orders").update({ sol_amount: rules.buy_sol }).eq("id", o.id);
        const sw = await liveSwap(WSOL, o.mint, lamports, kp);
        await db.from("sol_live_orders").update({ status: "sent", tx_signature: sw.sig, token_amount: sw.outAmount, updated_at: new Date().toISOString() }).eq("id", o.id);
        await logEvent("live", `BUY sent (${sw.via}): ${rules.buy_sol} SOL -> ${o.symbol ?? o.mint}`, "info", o.wallet);
      } else {
        const { data: pos } = await db.from("sol_live_positions").select("*").eq("mint", o.mint).eq("status", "open").maybeSingle();
        if (!pos) { await skip("We hold no copied position in this token"); continue; }
        if (pos.wallet !== o.wallet && !o.trade?.panic && !o.trade?.risk) { await skip("Position was opened copying a different trader"); continue; }
        const heldRaw = await tokenBalanceRaw(me, o.mint);
        const amount = liveSellAmount(heldRaw, t.exit_type ?? null, t.exit_pct ?? null);
        if (amount <= 0n) {
          await db.from("sol_live_positions").update({ status: "closed", closed_at: new Date().toISOString() }).eq("mint", o.mint);
          await skip("Token balance is already zero");
          continue;
        }
        const sw = await liveSwap(o.mint, WSOL, amount, kp);
        await db.from("sol_live_orders").update({
          status: "sent", tx_signature: sw.sig, token_amount: amount.toString(), sol_amount: Number(sw.outAmount) / 1e9,
          close: amount === heldRaw, updated_at: new Date().toISOString(),
        }).eq("id", o.id);
        await logEvent("live", `SELL sent (${sw.via}): ${amount === heldRaw ? "all" : "part"} of ${o.symbol ?? o.mint}`, "info", o.wallet);
      }
      done++;
    } catch (e) {
      await liveFail(cfg, { ...o, updated_at: new Date().toISOString() }, String(e));
    }
  }
  return done;
}
// Our own exits on live positions: the SAME riskExit() rule paper uses, queued as ordinary sell orders.
async function liveRiskExits(cfg: any) {
  const cr = copyRules(cfg);
  const { data: open } = await db.from("sol_live_positions").select("*").eq("status", "open");
  if (!open?.length) return 0;
  const prices = await dexPairs(open.map((p: any) => p.mint));
  let n = 0;
  for (const pos of open) {
    const x = riskExit(Number(pos.entry_price_usd), prices[pos.mint]?.priceUsd ?? null, cr, !!pos.tp_taken);
    if (!x) continue;
    const { count: busy } = await db.from("sol_live_orders").select("*", { count: "exact", head: true })
      .eq("mint", pos.mint).eq("side", "sell").in("status", ["pending", "executing", "sent"]);
    if ((busy ?? 0) > 0) continue;
    await db.from("sol_live_orders").insert({ source_signature: `risk-${x.action}-${pos.mint}-${Date.now()}`, wallet: pos.wallet, mint: pos.mint,
      symbol: pos.symbol, side: "sell", status: "pending",
      trade: { exit_type: x.frac >= 1 ? "FULL" : "PARTIAL", exit_pct: x.frac * 100, risk: x.action } });
    if (x.action === "take") await db.from("sol_live_positions").update({ tp_taken: true }).eq("mint", pos.mint);
    await liveNotify(cfg, `${x.action === "stop" ? "🛑 Stop-loss" : "💰 Take-profit"} on <b>${esc(pos.symbol ?? pos.mint)}</b> (${x.movePct.toFixed(0)}%): selling ${Math.round(x.frac * 100)}%.`);
    n++;
  }
  return n;
}
// Once per 24h per kind, so a condition that persists does not repeat every minute.
async function liveAlertOnce(cfg: any, kind: string, html: string) {
  const a = await getRow("live_alerts");
  if (a[kind] && Date.now() - Date.parse(a[kind]) < 24 * 3600e3) return;
  await setRow("live_alerts", { ...a, [kind]: new Date().toISOString() });
  await liveNotify(cfg, html);
}
async function processLive(cfg: any) {
  const confirmed = await liveConfirm(cfg);
  const riskExits = await liveRiskExits(cfg);
  const lc = liveCfg(cfg);
  const realized = await liveRealizedSol();
  if (lc.enabled && realized <= -lc.max_loss_sol) {
    await setRow("config", { ...cfg, live: { ...lc, enabled: false } });
    await logEvent("live", `Loss limit hit (${realized.toFixed(3)} SOL realized): buying switched off`, "error");
    await liveNotify(cfg, `🛑 <b>Live buying stopped</b>: realized loss ${realized.toFixed(3)} SOL reached the ${lc.max_loss_sol} SOL limit. Open positions still follow their sells and stop-loss. Re-enable from the dashboard only after reviewing.`);
  }
  const kp = liveKeypair();
  if (kp && lc.enabled) {
    const bal = await walletSol(kp.publicKey.toBase58());
    const need = copyRules(cfg).buy_sol + lc.min_sol_reserve;
    if (bal != null && bal < need) await liveAlertOnce(cfg, "low_balance", `⚠️ Trading wallet has ${bal.toFixed(3)} SOL; each copy needs ${need.toFixed(3)}. Live buys are being skipped until it is topped up.`);
  }
  const executed = await liveExecute(cfg);
  return { executed, confirmed, riskExits, realized_sol: Math.round(realized * 1000) / 1000 };
}

// ---------- monitoring tick ----------
async function processWallet(w: any, cfg: any, budget: { left: number }) {
  if (!w.last_signature) {
    const sigs = await rpc("getSignaturesForAddress", [w.address, { limit: 1, commitment: "confirmed" }]);
    await db.from("sol_wallets").update({
      last_signature: sigs?.[0]?.signature ?? null, last_checked_at: new Date().toISOString(),
      consecutive_errors: 0, last_error: null,
    }).eq("address", w.address);
    await logEvent("baseline", `Baseline set; history before now is not alerted`, "info", w.address);
    return { processed: 0, backlog: 0 };
  }
  // Signatures come newest-first back to the cursor. If the wallet produced more than we can page
  // through in one tick, the oldest ones would be skipped silently — so detect and report that gap.
  let all: any[] = [];
  let before: string | undefined;
  let reachedCursor = false;
  for (let page = 0; page < 10; page++) {
    const opts: any = { limit: SIG_PAGE, until: w.last_signature, commitment: "confirmed" };
    if (before) opts.before = before;
    const sigs = await rpc("getSignaturesForAddress", [w.address, opts]);
    all = all.concat(sigs ?? []);
    if (!sigs || sigs.length < SIG_PAGE) { reachedCursor = true; break; }
    before = sigs[sigs.length - 1].signature;
  }
  if (!reachedCursor) {
    await logEvent("gap", `More than ${all.length} new transactions since the last check; older ones in between were not read. This wallet trades too often to monitor completely.`, "error", w.address);
  }
  all.reverse();
  let processed = 0;
  let cursor = w.last_signature;
  for (const s of all) {
    if (budget.left <= 0) break;
    if (!s.err) {
      budget.left--;
      const tx = await getTx(s.signature);
      if (!tx) break;
      const p = parseSwap(tx, w.address);
      if (p.kind !== "failed" && p.kind !== "unrelated" && p.kind !== "no_token_change") {
        await recordTrade(w, s.signature, p, cfg);
        // Save the cursor after every recorded trade; between trades it is saved in batches.
        // Re-reading a few signatures after a crash is harmless: trades are unique per (signature, wallet).
        await db.from("sol_wallets").update({ last_signature: s.signature }).eq("address", w.address);
      }
    }
    cursor = s.signature;
    processed++;
    if (processed % 50 === 0) await db.from("sol_wallets").update({ last_signature: cursor }).eq("address", w.address);
  }
  await db.from("sol_wallets").update({
    last_signature: cursor,
    last_checked_at: new Date().toISOString(), consecutive_errors: 0, last_error: null, health_alerted: false,
    ...(processed ? { last_activity_at: new Date().toISOString() } : {}),
  }).eq("address", w.address);
  return { processed, backlog: all.length - processed };
}

async function recordTrade(w: any, signature: string, p: any, cfg: any) {
  const blockIso = p.blockTime ? new Date(p.blockTime * 1000).toISOString() : null;
  const sol = await solUsd(); // cached for a minute, so normally instant
  let solValue: number | null = null;
  let quote = "SOL";
  let quoteAmount: number | null = null;
  if (Math.abs(p.stableDelta) > 0.01 && Math.abs(p.solDelta) < 0.01) {
    quote = p.stableMint === USDT ? "USDT" : "USDC";
    quoteAmount = Math.abs(p.stableDelta);
    solValue = sol ? quoteAmount / sol : null;
  } else {
    solValue = Math.abs(p.solDelta);
    quoteAmount = solValue;
  }
  let exitType: string | null = null;
  let exitPct: number | null = null;
  if (p.kind === "sell") {
    exitType = p.tokenPost <= p.tokenPre * 0.01 ? "FULL" : "PARTIAL";
    exitPct = p.tokenPre > 0 ? Math.min(100, (-p.tokenDelta / p.tokenPre) * 100) : null;
  }
  const isAlertable = p.kind === "buy" || p.kind === "sell";
  let mk: Market | undefined;
  let risk: string[] | null = null;
  if (isAlertable) {
    const [pairs, auth] = await Promise.all([dexPairs([p.mint]), mintAuthorities(p.mint)]); // in parallel, for speed
    mk = pairs[p.mint];
    risk = riskFlags(mk, auth, solValue, sol);
  }
  let alertStatus = "none";
  if (isAlertable) {
    if (w.status !== "active") alertStatus = "paused";
    else if (cfg.alerts_paused) alertStatus = "paused";
    else if (p.kind === "buy" && (solValue ?? 0) < cfg.min_buy_sol) alertStatus = "below_threshold";
    else alertStatus = "pending";
  }
  const row = {
    signature, wallet: w.address, kind: p.kind, mint: p.mint,
    token_name: mk?.name ?? null, token_symbol: mk?.symbol ?? null,
    sol_value: solValue, quote, quote_amount: quoteAmount, token_amount: p.tokenDelta,
    token_pre: p.tokenPre, token_post: p.tokenPost, exit_type: exitType, exit_pct: exitPct,
    block_time: blockIso, slot: p.slot, market: mk ?? null, risk, alert_status: alertStatus,
  };
  const { data, error } = await db.from("sol_trades").upsert(row, { onConflict: "signature,wallet", ignoreDuplicates: true }).select("signature");
  if (error) throw error;
  if (!data?.length) return;
  const qualifies = (p.kind === "buy" && (solValue ?? 0) >= cfg.min_buy_sol) || p.kind === "sell";
  if (isAlertable && qualifies && w.status === "active") {
    try { await paperOnTrade(row, cfg); } catch (e) { await logEvent("paper_error", clean(e), "warn", w.address); }
  }
  if (isAlertable && w.status === "active") {
    try { await liveOnTrade(row, w, cfg); } catch (e) { await logEvent("live_error", clean(e), "error", w.address); }
  }
}

async function deliverAlerts(cfg: any) {
  const { data: pend } = await db.from("sol_trades").select("*").eq("alert_status", "pending").order("block_time").limit(20);
  if (!pend?.length) return { sent: 0, failed: 0 };
  if (!TG_TOKEN || !cfg.telegram_chat_id) {
    for (const t of pend) {
      await db.from("sol_trades").update({ alert_error: "Telegram not configured yet" }).eq("signature", t.signature).eq("wallet", t.wallet);
    }
    return { sent: 0, failed: 0, waiting: pend.length };
  }
  const { data: wallets } = await db.from("sol_wallets").select("address,label");
  const labels = Object.fromEntries((wallets ?? []).map((w: any) => [w.address, w.label]));
  let sent = 0, failed = 0;
  for (const t of pend) {
    const ageMin = (Date.now() - Date.parse(t.block_time ?? t.detected_at)) / 60000;
    if (ageMin > ALERT_MAX_AGE_MIN) {
      await db.from("sol_trades").update({ alert_status: "expired", alert_error: `Older than ${ALERT_MAX_AGE_MIN} min when Telegram became available` })
        .eq("signature", t.signature).eq("wallet", t.wallet);
      continue;
    }
    try {
      const id = await tgSend(cfg.telegram_chat_id, alertText(t, labels[t.wallet] ?? t.wallet));
      await db.from("sol_trades").update({ alert_status: "sent", alerted_at: new Date().toISOString(), telegram_message_id: id, alert_error: null })
        .eq("signature", t.signature).eq("wallet", t.wallet);
      sent++;
    } catch (e) {
      const attempts = t.alert_attempts + 1;
      await db.from("sol_trades").update({ alert_attempts: attempts, alert_error: clean(e), alert_status: attempts >= 5 ? "failed" : "pending" })
        .eq("signature", t.signature).eq("wallet", t.wallet);
      failed++;
    }
  }
  return { sent, failed };
}

// One run at a time across all instances (minute cron + webhook-triggered runs).
async function withLock<T>(waitMs: number, fn: () => Promise<T>): Promise<T | { skipped: string }> {
  const until = Date.now() + waitMs;
  for (;;) {
    const { data } = await db.rpc("sol_try_lock", { lock_name: "tick", ttl_seconds: 55 });
    if (data === true) break;
    if (Date.now() >= until) return { skipped: "another run in progress" };
    await sleep(700);
  }
  try { return await fn(); } finally { await db.rpc("sol_unlock", { lock_name: "tick" }); }
}
const tick = () => withLock(0, tickInner);
let ticking = false;
// ---------- trader scorecard, one-tap approval, daily summary ----------
// watch -> eligible -> live. Research passing only earns a trader paper copies; real money needs the
// paper copies (same rules, real quotes) to have made money, and then the owner's tap in Telegram.
async function lastResetAt(): Promise<string> {
  const { data } = await db.from("sol_paper_ledger").select("at").eq("type", "reset").order("at", { ascending: false }).limit(1);
  return data?.[0]?.at ?? "1970-01-01T00:00:00Z";
}
async function tgApi(method: string, body: unknown): Promise<any> {
  if (!TG_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN secret is not set");
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
  return j.result;
}
async function scoreTraders(cfg: any) {
  const since = await lastResetAt();
  const [{ data: wallets }, { data: pos }] = await Promise.all([
    db.from("sol_wallets").select("address,label,status,stage,copy_live").or("status.eq.active,copy_live.eq.true"),
    db.from("sol_paper_positions").select("wallet,realized_usd,cost_usd,closed_at").eq("status", "closed").gte("opened_at", since),
  ]);
  const out: Record<string, unknown> = {};
  for (const w of wallets ?? []) {
    const rows = (pos ?? []).filter((p: any) => p.wallet === w.address && p.closed_at)
      .map((p: any) => ({ realized: Number(p.realized_usd), cost: Number(p.cost_usd), closedAt: p.closed_at }));
    const sc = { ...traderScore(rows), scored_at: new Date().toISOString(), since };
    let stage = w.stage ?? "watch";
    if (w.copy_live && sc.demote) {
      stage = "watch";
      await db.from("sol_wallets").update({ copy_live: false }).eq("address", w.address);
      await logEvent("scorecard", `${w.label} demoted from live: last copies net ${sc.recent_net} USD`, "warn", w.address);
      await liveNotify(cfg, `⬇️ <b>${esc(w.label)}</b> is no longer copied with real money: its last ${SCORE_RULES.recent_n} paper copies lost ${usd(-sc.recent_net)} in total.`);
    } else if (sc.eligible && !w.copy_live && stage === "watch") {
      stage = "eligible";
      await logEvent("scorecard", `${w.label} eligible for live: ${sc.n} paper copies, net ${sc.net} USD, avg ${sc.avg_pct}%`, "info", w.address);
      if (TG_TOKEN && cfg.telegram_chat_id) {
        await tgApi("sendMessage", {
          chat_id: cfg.telegram_chat_id, parse_mode: "HTML", disable_web_page_preview: true,
          text: [`🏁 <b>${esc(w.label)}</b> has earned live trading on paper`,
            `${sc.n} copied trades under the live rules: net ${usd(sc.net)}, ${sc.win_rate_pct}% wins, avg ${sc.avg_pct}% per trade.`,
            `Approve to copy it with real money (${copyRules(cfg).buy_sol} SOL a buy, inside your ${liveCfg(cfg).total_cap_sol} SOL cap).`].join("\n"),
          reply_markup: { inline_keyboard: [[{ text: "✅ Approve live", callback_data: `approve:${w.address}` }, { text: "Not now", callback_data: `decline:${w.address}` }]] },
        }).catch(() => {});
        const tp = await getRow("telegram_poll");
        await setRow("telegram_poll", { ...tp, awaiting: true });
      }
    }
    await db.from("sol_wallets").update({ score: sc, stage }).eq("address", w.address);
    out[w.label] = { n: sc.n, net: sc.net, stage, copy_live: w.copy_live && !(w.copy_live && sc.demote) };
  }
  return out;
}
// Telegram buttons arrive as callback queries. We poll only while an approval is outstanding, so the
// /start + "Link my Telegram chat" flow (which reads the same update stream) is left alone otherwise.
async function pollTelegram(cfg: any) {
  const tp = await getRow("telegram_poll");
  if (!tp.awaiting || !TG_TOKEN || !cfg.telegram_chat_id) return 0;
  const ups: any[] = await tgApi("getUpdates", { offset: tp.offset ?? 0, timeout: 0 }).catch(() => []);
  let handled = 0, offset = tp.offset ?? 0;
  for (const u of ups) {
    offset = Math.max(offset, u.update_id + 1);
    const cq = u.callback_query;
    if (!cq?.data) continue;
    if (String(cq.message?.chat?.id) !== String(cfg.telegram_chat_id)) continue; // only the owner's linked chat
    const [action, address] = String(cq.data).split(":");
    const { data: w } = await db.from("sol_wallets").select("address,label,stage").eq("address", address).maybeSingle();
    if (!w) continue;
    const lc = liveCfg(cfg);
    if (action === "approve") {
      await db.from("sol_wallets").update({ copy_live: true, stage: "live" }).eq("address", address);
      await logEvent("scorecard", `Owner approved ${w.label} for live copying (Telegram)`, "warn", address);
      const caveat = !liveKeypair() ? " No trading wallet is connected yet, so nothing will trade until LIVE_TRADER_KEY is set."
        : !lc.enabled ? " Live trading is switched off, so nothing will trade until it is switched on." : "";
      await tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Approved" }).catch(() => {});
      await liveNotify(cfg, `✅ <b>${esc(w.label)}</b> approved for real-money copying.${caveat}`);
    } else if (action === "decline") {
      await db.from("sol_wallets").update({ stage: "declined" }).eq("address", address);
      await tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Kept on paper" }).catch(() => {});
    }
    handled++;
  }
  const { count } = await db.from("sol_wallets").select("*", { count: "exact", head: true }).eq("stage", "eligible");
  await setRow("telegram_poll", { offset, awaiting: (count ?? 0) > 0 });
  return handled;
}
async function dailySummary(cfg: any, force = false) {
  const nyNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const date = `${nyNow.getFullYear()}-${String(nyNow.getMonth() + 1).padStart(2, "0")}-${String(nyNow.getDate()).padStart(2, "0")}`;
  const ds = await getRow("daily_summary");
  if (!force && (nyNow.getHours() < 21 || ds.date === date)) return null;
  const since = await lastResetAt();
  const dayAgo = new Date(Date.now() - 24 * 3600e3).toISOString();
  const [{ cash, open }, { data: closed }, { data: skips }, { data: wallets }, { data: research }] = await Promise.all([
    paperState(cfg),
    db.from("sol_paper_positions").select("realized_usd,closed_at").eq("status", "closed").gte("opened_at", since),
    db.from("sol_paper_ledger").select("note").eq("type", "skip").gte("at", dayAgo),
    db.from("sol_wallets").select("label,stage,copy_live,score").eq("status", "active"),
    db.from("sol_research").select("status,metrics,completed_at").gte("completed_at", dayAgo),
  ]);
  const realized = (closed ?? []).reduce((s: number, r: any) => s + Number(r.realized_usd), 0);
  const today = (closed ?? []).filter((r: any) => r.closed_at >= dayAgo);
  const openCost = open.reduce((s: number, o: any) => s + Number(o.cost_usd) * (Number(o.qty_open) / Number(o.qty)), 0);
  const skipBy: Record<string, number> = {};
  for (const k of skips ?? []) { const key = String(k.note ?? "").split(":")[0]; skipBy[key] = (skipBy[key] ?? 0) + 1; }
  const topSkips = Object.entries(skipBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${v}`).join(" · ");
  const lc = liveCfg(cfg);
  const kp = liveKeypair();
  const passed = (research ?? []).filter((r: any) => r.metrics?.assessment?.qualifies).length;
  const lines = [
    `📊 <b>Daily summary</b> (${date})`,
    `<b>Paper</b> since reset: realized ${usd(realized)} over ${closed?.length ?? 0} closed copies; cash ${usd(cash)} + ${usd(openCost)} in ${open.length} open.`,
    `Last 24h: ${today.length} closed, ${usd(today.reduce((s: number, r: any) => s + Number(r.realized_usd), 0))}.${topSkips ? ` Skipped: ${topSkips}.` : ""}`,
    `<b>Traders</b>: ${(wallets ?? []).map((w: any) => `${esc(w.label)} ${w.copy_live ? "LIVE" : w.stage ?? "watch"} ${w.score ? `${w.score.n} trades ${usd(w.score.net)}` : "unscored"}`).join(" · ") || "none active"}`,
    `<b>Research</b> last 24h: ${research?.length ?? 0} finished, ${passed} passed.`,
    `<b>Live</b>: ${lc.enabled ? "on" : "off"}, wallet ${kp ? "connected" : "not connected"}` +
      (kp ? `, balance ${fmt(await walletSol(kp.publicKey.toBase58()), 3)} SOL, spent ${fmt(await liveSpentSol(), 2)}/${lc.total_cap_sol} SOL, realized ${fmt(await liveRealizedSol(), 3)} SOL` : "") + ".",
  ];
  if (!force) await setRow("daily_summary", { date, sent_at: new Date().toISOString() });
  if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, lines.join("\n").slice(0, 3900));
  return lines;
}
async function hourlyMaintenance(cfg: any) {
  const m = await getRow("maintenance");
  if (m.scored_at && Date.now() - Date.parse(m.scored_at) < 3600e3) return null;
  await setRow("maintenance", { ...m, scored_at: new Date().toISOString() });
  return await scoreTraders(cfg);
}

async function tickInner() {
  if (ticking) return { skipped: "already running" };
  ticking = true;
  const started = new Date();
  const cfg = await getRow("config");
  const health = await getRow("health");
  try {
    if (health.last_tick_at && Date.now() - Date.parse(health.last_tick_at) > 10 * 60e3) {
      const mins = Math.round((Date.now() - Date.parse(health.last_tick_at)) / 60e3);
      await logEvent("recovered", `Monitoring resumed after a ${mins}-minute gap; missed trades are backfilled from the cursor`, "warn");
      if (TG_TOKEN && cfg.telegram_chat_id) {
        await tgSend(cfg.telegram_chat_id, `⚠️ Monitor resumed after a ${mins}-minute gap. Catching up now.`).catch(() => {});
      }
    }
    const { data: wallets } = await db.from("sol_wallets").select("*").eq("status", "active");
    const budget = { left: MAX_TX_PER_TICK };
    const results: Record<string, unknown> = {};
    for (const w of wallets ?? []) {
      try {
        results[w.label] = await processWallet(w, cfg, budget);
      } catch (e) {
        const n = w.consecutive_errors + 1;
        await db.from("sol_wallets").update({ consecutive_errors: n, last_error: clean(e), last_checked_at: new Date().toISOString() })
          .eq("address", w.address);
        await logEvent("wallet_error", clean(e), "error", w.address);
        if (n >= 5 && !w.health_alerted && TG_TOKEN && cfg.telegram_chat_id) {
          await tgSend(cfg.telegram_chat_id, `⚠️ Monitoring failing for ${esc(w.label)}: ${esc(clean(e))}`).catch(() => {});
          await db.from("sol_wallets").update({ health_alerted: true }).eq("address", w.address);
        }
        results[w.label] = { error: clean(e) };
      }
    }
    try { results["realtime"] = await syncHeliusWebhook((wallets ?? []).map((w: any) => w.address)); } catch (e) { results["realtime"] = { error: clean(e) }; }
    let paperFilled = 0;
    try { paperFilled = await processPaperOrders(cfg); } catch (e) { await logEvent("paper_error", clean(e), "warn"); }
    results["paper_orders_filled"] = paperFilled;
    try { results["paper_risk_exits"] = await paperRiskExits(cfg); } catch (e) { await logEvent("paper_error", clean(e), "warn"); }
    try { results["live"] = await processLive(cfg); } catch (e) { await logEvent("live_error", clean(e), "error"); results["live"] = { error: clean(e) }; }
    try { results["telegram_buttons"] = await pollTelegram(cfg); } catch (e) { await logEvent("telegram_error", clean(e), "warn"); }
    try { const sc = await hourlyMaintenance(cfg); if (sc) results["scorecard"] = sc; } catch (e) { await logEvent("scorecard_error", clean(e), "warn"); }
    try { if (await dailySummary(cfg)) results["daily_summary"] = "sent"; } catch (e) { await logEvent("summary_error", clean(e), "warn"); }
    const alerts = await deliverAlerts(cfg);
    await setRow("health", { last_tick_at: started.toISOString(), last_tick_ok: true, last_tick_error: null,
      last_tick_ms: Date.now() - started.getTime(), last_results: results, last_alerts: alerts, rpc: RPC_URL.replace(/api-key=[^&]+/, "api-key=***") });
    return { ok: true, results, alerts };
  } catch (e) {
    await setRow("health", { ...health, last_tick_at: started.toISOString(), last_tick_ok: false, last_tick_error: clean(e) });
    await logEvent("tick_error", clean(e), "error");
    return { ok: false, error: clean(e) };
  } finally {
    ticking = false;
  }
}

// ---------- research: wallet behaviour over recent transactions ----------
async function analyze(wallet: string, limit: number) {
  let sigs: any[] = [];
  let before: string | undefined;
  while (sigs.length < limit) {
    const page: any[] = await rpc("getSignaturesForAddress", [wallet, { limit: Math.min(100, limit - sigs.length), commitment: "confirmed", ...(before ? { before } : {}) }]);
    sigs = sigs.concat(page ?? []);
    if (!page || page.length < 100) break;
    before = page[page.length - 1].signature;
  }
  const ok = sigs.filter((s) => !s.err);
  const parsed: any[] = [];
  let rpcErrors = 0;
  let lastRpcError: string | null = null;
  for (let i = 0; i < ok.length; i += 2) {
    const batch = await Promise.all(ok.slice(i, i + 2).map((s) =>
      getTx(s.signature).catch((e) => { rpcErrors++; lastRpcError = clean(e); return null; })));
    batch.forEach((tx, j) => {
      const p = parseSwap(tx, wallet);
      if ("mint" in p) parsed.push({ sig: ok[i + j].signature, ...p });
    });
  }
  const buys = parsed.filter((p) => p.kind === "buy");
  const sells = parsed.filter((p) => p.kind === "sell");
  const buySol = buys.map((b) => Math.abs(b.solDelta)).sort((a, b) => a - b);
  const median = (a: number[]) => (a.length ? a[Math.floor(a.length / 2)] : null);
  const holds: number[] = [];
  const firstBuy: Record<string, number> = {};
  for (const p of [...parsed].sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0))) {
    if (p.kind === "buy" && firstBuy[p.mint] == null) firstBuy[p.mint] = p.blockTime;
    if (p.kind === "sell" && firstBuy[p.mint] != null) { holds.push(p.blockTime - firstBuy[p.mint]); delete firstBuy[p.mint]; }
  }
  holds.sort((a, b) => a - b);
  const times = parsed.map((p) => p.blockTime).filter(Boolean);
  const spanH = times.length ? (Math.max(...times) - Math.min(...times)) / 3600 : 0;
  const swapSolFlow = parsed.filter((p) => p.kind === "buy" || p.kind === "sell").reduce((s, p) => s + p.solDelta, 0);
  // Realized result per token: SOL out on buys vs SOL back on sells, only for tokens the wallet
  // both bought and exited (balance back under 1% of its peak) inside the scanned window.
  // Tokens that arrived by transfer (airdrop / insider allocation) are excluded and counted separately.
  const perMint: Record<string, { sol: number; bought: boolean; sold: boolean; transferIn: boolean; peak: number; last: number }> = {};
  for (const p of [...parsed].sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0))) {
    const m = (perMint[p.mint] ??= { sol: 0, bought: false, sold: false, transferIn: false, peak: 0, last: 0 });
    if (p.kind === "buy") { m.bought = true; m.sol += p.solDelta; }
    if (p.kind === "sell") { m.sold = true; m.sol += p.solDelta; }
    if (p.kind === "transfer_in") m.transferIn = true;
    m.peak = Math.max(m.peak, p.tokenPost ?? 0);
    m.last = p.tokenPost ?? m.last;
  }
  const closed = Object.values(perMint).filter((m) => m.bought && m.sold && !m.transferIn && m.last <= m.peak * 0.01);
  const closedWins = closed.filter((m) => m.sol > 0).length;
  const realized = closed.reduce((s, m) => s + m.sol, 0);
  const bestClosed = closed.reduce((b, m) => Math.max(b, m.sol), 0);
  return {
    realized_sol_closed_positions: Number(realized.toFixed(3)),
    closed_positions: closed.length,
    closed_win_rate_pct: closed.length ? Math.round((closedWins / closed.length) * 100) : null,
    best_closed_sol: Number(bestClosed.toFixed(3)),
    realized_share_from_best_trade_pct: realized > 0 ? Math.round((bestClosed / realized) * 100) : null,
    open_positions_in_window: Object.values(perMint).filter((m) => m.bought && m.last > m.peak * 0.01).length,
    tokens_received_by_transfer: Object.values(perMint).filter((m) => m.transferIn).length,
    wallet, checked_at: new Date().toISOString(), transactions_scanned: sigs.length, rpc_errors: rpcErrors, last_rpc_error: lastRpcError,
    first_tx_at: times.length ? new Date(Math.min(...times) * 1000).toISOString() : null,
    last_tx_at: times.length ? new Date(Math.max(...times) * 1000).toISOString() : null,
    window_hours: Number(spanH.toFixed(1)),
    buys: buys.length, sells: sells.length,
    transfers_in: parsed.filter((p) => p.kind === "transfer_in").length,
    transfers_out: parsed.filter((p) => p.kind === "transfer_out").length,
    token_swaps: parsed.filter((p) => p.kind === "token_swap").length,
    median_buy_sol: median(buySol), max_buy_sol: buySol.at(-1) ?? null,
    buys_at_least_0_5_sol: buySol.filter((x) => x >= 0.5).length,
    round_trips: holds.length, median_hold_seconds: median(holds),
    round_trips_under_60s: holds.filter((h) => h < 60).length,
    swap_sol_flow_in_window: Number(swapSolFlow.toFixed(3)),
    trades_per_hour: spanH ? Number(((buys.length + sells.length) / spanH).toFixed(1)) : null,
  };
}

// ---------- trader research (needs HELIUS_API_KEY) ----------
// Step 1 lists the wallet's SWAP transactions for the last 90 days via Helius' documented
// by-address history endpoint (only the `signature` and `timestamp` fields are used).
// Step 2 fetches each transaction over RPC and classifies it with the same parseSwap() the
// live monitor uses. Step 3 computes realized 30/60/90-day results in lib.ts.
// Work is saved after every step, so a timeout or restart resumes where it stopped.
const RESEARCH_DAYS = 90;
// A wallet with more swaps than this in 90 days trades too often to copy by hand or by alert;
// stop listing there (the coverage check then fails and says why) instead of burning credits.
const RESEARCH_SWAP_CAP = 2500;
async function heliusSwapPage(wallet: string, cutoff: number, before: string | null): Promise<{ txs: any[]; continueFrom?: string }> {
  const u = new URL(`https://mainnet.helius-rpc.com/v0/addresses/${wallet}/transactions`);
  u.searchParams.set("api-key", HELIUS_KEY);
  u.searchParams.set("type", "SWAP");
  u.searchParams.set("limit", "100");
  u.searchParams.set("gte-time", String(cutoff));
  if (before) u.searchParams.set("before-signature", before);
  let delay = 800;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(u);
      if (r.status === 429 || r.status >= 500) throw new Error(`Helius HTTP ${r.status}`);
      const j = await r.json();
      if (Array.isArray(j)) return { txs: j };
      // With a type filter, Helius scans a fixed slice of history per call. A slice with no swaps
      // returns an error naming the signature to continue from, which is not a failure.
      const m = /before-signature` parameter set to ([1-9A-HJ-NP-Za-km-z]{60,100})/.exec(String(j?.error ?? ""));
      if (m) return { txs: [], continueFrom: m[1] };
      throw new Error(`Helius: ${JSON.stringify(j).slice(0, 300)}`);
    } catch (e) {
      if (i === 3) throw new Error(clean(e));
      await sleep(delay); delay *= 2;
    }
  }
  return { txs: [] };
}

async function researchStep() {
  if (!HELIUS_KEY) return { skipped: "HELIUS_API_KEY not set" };
  const { data: r } = await db.from("sol_research").select("*").in("status", ["queued", "collecting", "parsing"])
    .order("requested_at").order("wallet").limit(1).maybeSingle();
  if (!r) return { idle: true };
  const started = Date.now();
  try {
    if (r.status !== "parsing") {
      const cutoff = Math.floor(Date.parse(r.requested_at) / 1000) - RESEARCH_DAYS * 86400;
      let cursor: string | null = r.sig_cursor;
      let pages = 0, done = false, listed = 0, capped = false;
      while (pages < 8 && Date.now() - started < 30_000) {
        const page = await heliusSwapPage(r.wallet, cutoff, cursor);
        pages++;
        if (page.continueFrom) { cursor = page.continueFrom; continue; }
        if (!page.txs.length) { done = true; break; }
        const rows = page.txs.filter((t: any) => t?.signature).map((t: any) => ({
          wallet: r.wallet, signature: t.signature,
          block_time: typeof t.timestamp === "number" ? new Date(t.timestamp * 1000).toISOString() : null,
        }));
        listed += rows.length;
        await db.from("sol_research_swaps").upsert(rows, { onConflict: "wallet,signature", ignoreDuplicates: true });
        cursor = page.txs[page.txs.length - 1].signature;
      }
      const { count: have } = await db.from("sol_research_swaps").select("*", { count: "exact", head: true }).eq("wallet", r.wallet);
      if (!done && (have ?? 0) >= RESEARCH_SWAP_CAP) { done = true; capped = true; }
      if (!done && (r.pages_fetched ?? 0) + pages >= 400) done = true; // hard stop on runaway paging
      await db.from("sol_research").update({
        status: done ? "parsing" : "collecting", sig_cursor: cursor, pages_fetched: (r.pages_fetched ?? 0) + pages,
        updated_at: new Date().toISOString(), error: null, ...(capped ? { capped: true } : {}),
      }).eq("wallet", r.wallet);
      return { wallet: r.label, phase: "collecting", listed, done, capped };
    }
    const { data: todo } = await db.from("sol_research_swaps").select("signature")
      .eq("wallet", r.wallet).eq("parsed", false).limit(240);
    let parsedN = 0;
    for (let i = 0; i < (todo ?? []).length && Date.now() - started < 40_000; i += 8) {
      const chunk = todo!.slice(i, i + 8);
      const txs = await Promise.all(chunk.map((c: any) => getTx(c.signature).catch(() => null)));
      const rows = chunk.map((c: any, j: number) => {
        const p = txs[j] ? parseSwap(txs[j], r.wallet) : { kind: "fetch_failed" };
        return {
          wallet: r.wallet, signature: c.signature, parsed: true, kind: p.kind, mint: p.mint ?? null,
          sol_delta: p.kind === "buy" || p.kind === "sell"
            ? (Math.abs(p.stableDelta ?? 0) > 0.01 && Math.abs(p.solDelta ?? 0) < 0.01 ? null : p.solDelta) : null,
          stable_delta: p.stableDelta ?? null, token_delta: p.tokenDelta ?? null,
          block_time: p.blockTime ? new Date(p.blockTime * 1000).toISOString() : undefined,
        };
      }).map((row: any) => { if (row.block_time === undefined) delete row.block_time; return row; });
      await db.from("sol_research_swaps").upsert(rows, { onConflict: "wallet,signature" });
      parsedN += rows.length;
    }
    const { count } = await db.from("sol_research_swaps").select("*", { count: "exact", head: true })
      .eq("wallet", r.wallet).eq("parsed", false);
    if ((count ?? 0) > 0) {
      await db.from("sol_research").update({ updated_at: new Date().toISOString() }).eq("wallet", r.wallet);
      return { wallet: r.label, phase: "parsing", parsed: parsedN, remaining: count };
    }
    // All parsed: compute metrics (page through rows; PostgREST returns 1000 per request).
    let all: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from("sol_research_swaps").select("signature,block_time,kind,mint,sol_delta,token_delta")
        .eq("wallet", r.wallet).range(from, from + 999);
      all = all.concat(data ?? []);
      if (!data || data.length < 1000) break;
    }
    const metrics: any = researchMetrics(all, Math.floor(Date.parse(r.requested_at) / 1000), RESEARCH_DAYS);
    // Sniper score: how many buys landed within an hour of the token's launch (DexScreener pair
    // creation time). Capped at the 300 most recently bought tokens to bound the lookups (10 calls).
    const buys = all.filter((x) => x.kind === "buy" && x.mint && x.block_time)
      .map((x) => ({ mint: x.mint, t: Math.floor(Date.parse(x.block_time) / 1000) })).sort((a, b) => b.t - a.t);
    const mints = [...new Set(buys.map((b) => b.mint))].slice(0, 300);
    const pairs = await dexPairs(mints);
    const created: Record<string, number | null> = {};
    for (const m of mints) created[m] = pairs[m]?.pairCreatedAt ? Math.floor(Date.parse(pairs[m].pairCreatedAt!) / 1000) : null;
    const eb = earlyBuyShare(buys.filter((b) => mints.includes(b.mint)), created);
    metrics.early_buy_pct = eb.pct;
    metrics.early_buy_known = eb.known;
    metrics.assessment = assess(metrics, RESEARCH_DAYS, Math.floor(Date.parse(r.requested_at) / 1000));
    const failed = all.filter((x) => x.kind === "fetch_failed").length;
    await db.from("sol_research").update({
      status: "done", metrics: { ...metrics, capped_at_swaps: r.capped ? RESEARCH_SWAP_CAP : null, swaps_listed: all.length, fetch_failed: failed, stablecoin_trades_excluded: all.filter((x) => (x.kind === "buy" || x.kind === "sell") && x.sol_delta == null).length },
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: null,
    }).eq("wallet", r.wallet);
    await logEvent("research", `${r.label}: ${metrics.assessment.passed}/${metrics.assessment.total} checks passed`, "info", r.wallet);
    let tracked = false;
    const { data: tw } = await db.from("sol_wallets").select("*").eq("address", r.wallet).maybeSingle();
    if (tw?.evidence?.provisional && tw.status === "active") tracked = await settleProvisional(r, metrics, tw);
    else if (metrics.assessment.watch) tracked = await autoTrack(r, metrics);
    await researchSummaryIfFinished();
    return { wallet: r.label, phase: "done", qualifies: metrics.assessment.qualifies, watch: metrics.assessment.watch, tracked };
  } catch (e) {
    const attempts = (r.attempts ?? 0) + 1;
    await db.from("sol_research").update({
      error: clean(e), attempts, status: attempts >= 8 ? "error" : r.status, updated_at: new Date().toISOString(),
    }).eq("wallet", r.wallet);
    return { wallet: r.label, error: clean(e) };
  }
}

// A wallet that passes every CORE research check goes onto the paper watch list (max 5 active), with
// its evidence stored on the wallet row, and the owner is told in Telegram. "verified" = every rule
// passed; "watch" = core rules passed, cautions listed. Neither tier copies with real money: that needs
// traderScore() eligibility from paper results plus the owner's Telegram approval (copy_live).
const solStr = (n: number | null | undefined) => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${Number(n).toFixed(2)} SOL`);
const tierOf = (m: any) => (m.assessment.qualifies ? "verified" : "watch");
const researchSummaryLine = (m: any) => `${m.assessment.passed}/${m.assessment.total} checks · 30d ${solStr(m.d30.realized_sol)} · 60d ${solStr(m.d60.realized_sol)} · 90d ${solStr(m.d90.realized_sol)} realized · win ${m.d90.win_rate_pct}% · median buy ${m.median_buy_sol} SOL`;
// Who gives up a slot for a new candidate: provisional (unresearched) first, then — only for a verified
// newcomer — a watch-tier wallet. A wallet copying with real money is never displaced automatically.
function displaceable(active: any[], newTier: string) {
  const free = active.filter((w) => !w.copy_live);
  return free.find((w) => w.evidence?.provisional) ??
    (newTier === "verified" ? free.find((w) => w.evidence?.tier === "watch") : undefined);
}
async function autoTrack(r: any, m: any): Promise<boolean> {
  const cfg = await getRow("config");
  const { data: existing } = await db.from("sol_wallets").select("address,status").eq("address", r.wallet).maybeSingle();
  if (existing && existing.status === "active") return false;
  const tier = tierOf(m);
  const { data: active } = await db.from("sol_wallets").select("address,label,evidence,copy_live").eq("status", "active");
  const summary = researchSummaryLine(m);
  if ((active ?? []).length >= 5) {
    const victim = displaceable(active ?? [], tier);
    if (victim) {
      await db.from("sol_wallets").update({ status: "paused", last_error: `Replaced by ${tier} trader ${r.label}` }).eq("address", victim.address);
      await logEvent("wallet", `Paused ${victim.label} to make room for ${tier} ${r.label}`, "info", victim.address);
      if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, `🔁 Swapped out <b>${esc(victim.label)}</b> for ${tier} <b>${esc(r.label)}</b>.`).catch(() => {});
      return await autoTrack(r, m);
    }
    await logEvent("research", `${r.label} qualifies (${tier}) but 5 wallets are already tracked`, "info", r.wallet);
    if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, `✅ <b>${esc(r.label)}</b> passed research (${tier}) but you already track 5 wallets. Swap it in from the dashboard if you want it.\n${esc(summary)}`).catch(() => {});
    return false;
  }
  const label = String(r.label).replace(/\s*\((provisional|watch)[^)]*\)$/i, "") + (tier === "watch" ? " (watch)" : "");
  await db.from("sol_wallets").upsert({
    address: r.wallet, label, status: "active", source: r.source ?? "research",
    evidence: { tier, summary, cautions: m.assessment.cautions, researched_at: new Date().toISOString(), source: r.source, source_snapshot: r.source_snapshot, metrics: m },
    last_signature: null, consecutive_errors: 0, last_error: null,
  });
  await logEvent("wallet", `Auto-tracked ${label} (${tier}) after research`, "info", r.wallet);
  if (TG_TOKEN && cfg.telegram_chat_id) {
    await tgSend(cfg.telegram_chat_id, [
      `👀 <b>Now paper-watching ${esc(label)}</b>${tier === "verified" ? " — passed every check" : ""}`,
      `<code>${esc(r.wallet)}</code>`,
      esc(summary),
      ...(m.assessment.cautions.length ? [`Cautions: ${esc(m.assessment.cautions.join("; "))}`] : []),
      `Max drawdown ${solStr(m.max_drawdown_sol)} · median hold ${m.median_hold_seconds ?? "n/a"}s · ${m.round_trips_under_60s_pct ?? "n/a"}% flips under 60s`,
      `<a href="https://gmgn.ai/sol/address/${esc(r.wallet)}">GMGN wallet</a>`,
      "<i>Paper copies start now. Real money only after 20+ profitable paper copies and your approval.</i>",
    ].join("\n")).catch(() => {});
  }
  return true;
}
// A provisional wallet was put on the watch list before its research finished.
// Pass: it becomes a verified wallet. Fail: it is paused and the owner is told which check it failed.
async function settleProvisional(r: any, m: any, w: any): Promise<boolean> {
  const cfg = await getRow("config");
  const summary = researchSummaryLine(m);
  const tier = tierOf(m);
  const label = String(w.label).replace(/\s*\((provisional|watch)[^)]*\)$/i, "") + (tier === "watch" ? " (watch)" : "");
  if (m.assessment.watch) {
    await db.from("sol_wallets").update({ label, evidence: { tier, summary, cautions: m.assessment.cautions, researched_at: new Date().toISOString(), source: r.source, source_snapshot: r.source_snapshot, metrics: m } }).eq("address", w.address);
    await logEvent("wallet", `${label} confirmed by research (${tier})`, "info", w.address);
    if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, `✅ <b>${esc(label)}</b> passed research (${tier}) and stays on the paper watch list.\n${esc(summary)}${m.assessment.cautions.length ? `\nCautions: ${esc(m.assessment.cautions.join("; "))}` : ""}`).catch(() => {});
    return true;
  }
  const fail = m.assessment.rules.find((x: any) => !x.pass && x.core);
  await db.from("sol_wallets").update({ status: "paused", last_error: `Failed research: ${fail?.rule ?? ""}`, evidence: { ...w.evidence, research_failed: true, summary, metrics: m } }).eq("address", w.address);
  await logEvent("wallet", `Paused provisional ${label}: failed "${fail?.rule}" (${fail?.detail})`, "warn", w.address);
  if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, `⏸ Stopped watching <b>${esc(label)}</b>. It failed research: ${esc(fail?.rule ?? "")} (${esc(fail?.detail ?? "")}).\n${esc(summary)}`).catch(() => {});
  return false;
}
async function researchSummaryIfFinished() {
  const { count } = await db.from("sol_research").select("*", { count: "exact", head: true }).in("status", ["queued", "collecting", "parsing"]);
  if ((count ?? 0) > 0) return;
  const { data: all } = await db.from("sol_research").select("wallet,label,status,metrics,requested_at").order("requested_at");
  if (!all?.length) return;
  const batch = all.map((x: any) => x.requested_at).sort().at(-1);
  const sent = await getRow("research_summary");
  if (sent.batch === batch) return;
  const cfg = await getRow("config");
  const passed = all.filter((x: any) => x.metrics?.assessment?.qualifies);
  const ranked = rankWatch(all);
  const { data: active } = await db.from("sol_wallets").select("label").eq("status", "active");
  const profitLine = (x: any) => `${esc(x.label)} (${x.metrics.assessment.passed}/${x.metrics.assessment.total}, 90d ${solStr(x.metrics.d90.realized_sol)})`;
  const lines = [
    `📋 <b>Trader research finished</b> — ${all.length} wallets checked on 90 days of on-chain swaps`,
    ranked.length
      ? `Profitable and copyable (core checks passed): ${ranked.map(profitLine).join(", ")}`
      : "No wallet passed the core checks (history, profit over 30/60/90 days, 20+ closed trades, copyable size, still active).",
    passed.length ? `Passed every check: ${passed.map((x: any) => esc(x.label)).join(", ")}` : "",
    `Now paper-watching: ${(active ?? []).map((w: any) => esc(w.label)).join(", ") || "none"}`,
    ...all.filter((x: any) => !x.metrics?.assessment?.watch).map((x: any) => {
      const a = x.metrics?.assessment;
      const firstFail = a?.rules?.find((rr: any) => !rr.pass && rr.core !== false);
      return `• ${esc(x.label)}: ${a ? `${a.passed}/${a.total}` : x.status}${firstFail ? ` — failed “${esc(firstFail.rule)}” (${esc(firstFail.detail)})` : ""}`;
    }),
  ];
  if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, lines.filter(Boolean).join("\n").slice(0, 3900)).catch(() => {});
  await setRow("research_summary", { batch, sent_at: new Date().toISOString(), passed: passed.map((x: any) => x.label) });
}

// ---------- discovery: find profitable, less-crowded wallets on-chain ----------
// 1. Trending Solana pools from GeckoTerminal's public API (big 24h move, real liquidity).
// 2. For each pool, read its most recent trades and keep wallets that BOUGHT and SOLD that token in the
//    window and came out >= 1 SOL ahead at a copyable size (discoveryVerdict in lib.ts).
// 3. Wallets that profited on several different winners rank highest; already-researched wallets are excluded.
// 4. One signature page per candidate skips wallets too new to pass the 90-day coverage check.
// 5. The top candidates are queued for the same 90-day research; passing ones are auto-tracked.
const DISC_MIN_SELL_SOL = 1;
const DISC_VET_MAX = 40;    // ranked candidates that get the one-call history check
const DISC_QUEUE_MAX = 10;  // research costs thousands of calls per wallet; queue the best few
const DISC_SIG_PAGE = 1000;
// Pools are restricted to ESTABLISHED coins that pass the same entry filter we buy with (market cap,
// 24h volume, at least a day old) and are up on the day. A wallet that took profit there is one whose
// trades we could copy a few seconds late; a sniper of minutes-old micro-caps is not (2026-11-23 finding).
// The $100M ceiling and SOL/stable quote keep it to meme coins: above that, and for tokenized stocks or
// wrapped BTC, the profitable sellers are market makers and arbitrage bots, not copyable traders.
const BIRDEYE_MAX_TOKENS = 6; // ~35 compute units per call; 6 coins x 4 scans a day fits the free 30k/month
async function birdeyeTopTraders(pools: any[]): Promise<{ wallets: Record<string, { mints: string[]; names: string[] }>; error?: string }> {
  const wallets: Record<string, { mints: string[]; names: string[] }> = {};
  if (!BIRDEYE_KEY) return { wallets };
  let error: string | undefined;
  for (const p of pools) {
    try {
      const u = new URL("https://public-api.birdeye.so/defi/v2/tokens/top_traders");
      u.searchParams.set("address", p.mint);
      u.searchParams.set("time_frame", "30d");
      u.searchParams.set("sort_by", "realized_pnl");
      u.searchParams.set("sort_type", "desc");
      u.searchParams.set("offset", "0");
      u.searchParams.set("limit", "10");
      const r = await fetch(u, { headers: { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana", accept: "application/json" } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) { error = `Birdeye HTTP ${r.status}: ${String(j.message ?? "").slice(0, 120)}`; if (r.status === 401 || r.status === 403) break; continue; }
      const items: any[] = j.data?.items ?? (Array.isArray(j.data) ? j.data : []);
      for (const it of items) {
        const owner = String(it.owner ?? "");
        const tags = (it.tags ?? []).map((t: any) => String(t?.name ?? t)).join(" ");
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner) || /bot|sniper|mev|arbitrage|market.?maker|insider|dev/i.test(tags)) continue;
        const w = (wallets[owner] ??= { mints: [], names: [] });
        w.mints.push(p.mint); w.names.push(p.name);
      }
    } catch (e) { error = clean(e); }
    await sleep(1100); // free tier: 1 request per second
  }
  return { wallets, error };
}
const DISC_POOL_MIN_AGE_H = 24, DISC_POOL_MIN_LIQ = 50_000, DISC_POOL_MAX_MCAP = 100_000_000;
async function geckoTrendingPools(rules: EntryRules = ENTRY_DEFAULTS): Promise<any[]> {
  const out: any[] = [];
  const paths = ["trending_pools?duration=24h&page=1", "trending_pools?duration=24h&page=2",
    "pools?sort=h24_volume_usd_desc&page=1", "pools?sort=h24_volume_usd_desc&page=2"];
  for (const path of paths) {
    try {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/${path}`, { headers: { accept: "application/json" } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const p of j.data ?? []) {
        const a = p.attributes ?? {};
        const base = String(p.relationships?.base_token?.data?.id ?? "").replace(/^solana_/, "");
        const ch24 = Number(a.price_change_percentage?.h24 ?? 0);
        const liq = Number(a.reserve_in_usd ?? 0);
        const mcap = Number(a.market_cap_usd ?? a.fdv_usd ?? 0);
        const vol = Number(a.volume_usd?.h24 ?? 0);
        const ageH = a.pool_created_at ? (Date.now() - Date.parse(a.pool_created_at)) / 3600e3 : 0;
        const quote = String(p.relationships?.quote_token?.data?.id ?? "").replace(/^solana_/, "");
        if (!a.address || !base || [WSOL, USDC, USDT].includes(base) || ![WSOL, USDC, USDT].includes(quote)) continue;
        if (liq < DISC_POOL_MIN_LIQ || mcap > DISC_POOL_MAX_MCAP || mcap < rules.min_mcap_usd || vol < rules.min_volume24h_usd || ageH < DISC_POOL_MIN_AGE_H || ch24 <= 0) continue;
        out.push({ pool: a.address, mint: base, name: a.name, change24h: ch24, liquidity: liq, mcap, volume24h: vol, age_hours: Math.round(ageH) });
      }
    } catch { /* best effort */ }
    await sleep(2100); // GeckoTerminal public limit is ~30 calls/min
  }
  const seen = new Set<string>();
  const top = out.filter((p) => (seen.has(p.mint) ? false : (seen.add(p.mint), true))).sort((a, b) => b.change24h - a.change24h).slice(0, 20);
  if (!needsRug(rules)) return top;
  // Same holder rule we buy with: no point hunting traders in coins we would refuse to buy.
  const kept: any[] = [];
  for (const p of top) {
    const ec = entryCheck({ fdvUsd: p.mcap, volume24hUsd: p.volume24h, hasWebsite: true, hasTwitter: true, pairCreatedAt: null, rug: await rugReport(p.mint) },
      { ...rules, require_website_or_twitter: false, min_pair_age_hours: 0 });
    if (ec.pass) kept.push({ ...p, holders: rugCache[p.mint]?.r?.totalHolders ?? null });
  }
  return kept;
}
async function discoverStep() {
  if (!HELIUS_KEY) return { skipped: "HELIUS_API_KEY not set" };
  const started = Date.now();
  let st = await getRow("discovery");
  if (!st.pools || st.done) {
    const pools = await geckoTrendingPools(entryRules(await getRow("config")));
    st = { started_at: new Date().toISOString(), pools, next: 0, done: false };
    await setRow("discovery", st);
    await logEvent("discovery", `Scanning ${pools.length} established coins (market cap, volume and age pass the entry filter) for profitable sellers`);
    return { phase: "pools", pools: pools.length };
  }
  while (st.next < st.pools.length && Date.now() - started < 38_000) {
    const p = st.pools[st.next];
    // Helius parsed swap history for the pool: 100 swaps per call, paged back up to ~1,500 swaps.
    // Each swap is attributed to its fee payer as a buy or a sell, so a wallet's round trip on
    // this coin inside the window (SOL in vs SOL out) is known before any research is spent on it.
    const agg: Record<string, PoolAgg> = {};
    let before: string | null = null;
    for (let page = 0; page < 15 && Date.now() - started < 38_000; page++) {
      let res: { txs: any[]; continueFrom?: string };
      try { res = await heliusSwapPage(p.pool, Math.floor(Date.now() / 1000) - 3 * 86400, before); } catch { break; }
      if (res.continueFrom) { before = res.continueFrom; continue; }
      if (!res.txs.length) break;
      for (const tx of res.txs) {
        const s = poolSwapSide(tx, p.mint);
        if (!s) continue;
        const a = (agg[s.payer] ??= { buys: 0, sells: 0, sol_in: 0, sol_out: 0 });
        if (s.side === "buy") { a.buys++; a.sol_in += s.sol; } else { a.sells++; a.sol_out += s.sol; }
      }
      before = res.txs[res.txs.length - 1].signature;
    }
    const foundAt = new Date().toISOString();
    const rows: any[] = [];
    st.reasons ??= {};
    for (const [wallet, a] of Object.entries(agg)) {
      if (a.sells < 1 || a.sol_out < DISC_MIN_SELL_SOL) continue; // only sellers of size are candidates
      const v = discoveryVerdict(a);
      st.reasons[v.reason] = (st.reasons[v.reason] ?? 0) + 1;
      rows.push({ wallet, mint: p.mint, pool: p.pool, token: p.name, found_at: foundAt, verdict: v.reason,
        buys: a.buys, sells: a.sells, sol_in: +a.sol_in.toFixed(4), sol_out: +a.sol_out.toFixed(4) });
    }
    if (rows.length) await db.from("sol_discovery_hits").upsert(rows, { onConflict: "wallet,mint" });
    st.next++;
    await setRow("discovery", st);
  }
  if (st.next < st.pools.length) return { phase: "scanning", scanned: st.next, of: st.pools.length };

  // Rank this scan's qualifying wallets: profit on several different winners beats one big one.
  if (!st.candidates) {
    const { data: hits } = await db.from("sol_discovery_hits").select("wallet,mint,token,sol_in,sol_out")
      .eq("verdict", "bought_and_profited").gte("found_at", st.started_at).limit(5000);
    const { data: known } = await db.from("sol_research").select("wallet");
    const skip = new Set((known ?? []).map((k: any) => k.wallet));
    const agg: Record<string, { tokens: Set<string>; names: string[]; profit: number }> = {};
    for (const h of hits ?? []) {
      if (skip.has(h.wallet)) continue;
      const a = (agg[h.wallet] ??= { tokens: new Set(), names: [], profit: 0 });
      if (!a.tokens.has(h.mint)) { a.tokens.add(h.mint); a.names.push(h.token); }
      a.profit += Number(h.sol_out) - Number(h.sol_in);
    }
    // Optional second source: Birdeye's ranking of the most profitable traders of each coin over 30 days.
    // It sees a whole month instead of our last ~1,500 swaps. Only the documented `owner` and `tags`
    // fields are used; profit itself is re-measured by our own 90-day research.
    const bird = await birdeyeTopTraders(st.pools.slice(0, BIRDEYE_MAX_TOKENS));
    st.birdeye = { used: !!BIRDEYE_KEY, found: Object.keys(bird.wallets).length, error: bird.error };
    for (const [wallet, b] of Object.entries(bird.wallets)) {
      if (skip.has(wallet)) continue;
      const a = (agg[wallet] ??= { tokens: new Set(), names: [], profit: 0 });
      for (let i = 0; i < b.mints.length; i++) if (!a.tokens.has(b.mints[i])) { a.tokens.add(b.mints[i]); a.names.push(`${b.names[i]} (Birdeye top 30d)`); }
    }
    st.candidates = Object.entries(agg)
      .map(([wallet, a]) => ({ wallet, n: a.tokens.size, profit: +a.profit.toFixed(3), names: a.names }))
      .sort((x, y) => y.n - x.n || y.profit - x.profit).slice(0, DISC_VET_MAX);
    st.vet_next = 0; st.vetted = []; st.too_new = 0;
    await setRow("discovery", st);
    return { phase: "ranked", candidates: st.candidates.length };
  }

  // Vet: one signature page per wallet. A wallet whose whole history is younger than the research
  // window fails the coverage check for certain, so it is skipped here instead of researched.
  const nowSec = Math.floor(Date.now() / 1000);
  while (st.vet_next < st.candidates.length && st.vetted.length < DISC_QUEUE_MAX && Date.now() - started < 38_000) {
    const chunk = st.candidates.slice(st.vet_next, st.vet_next + 8);
    const pages = await Promise.all(chunk.map((c: any) =>
      rpc("getSignaturesForAddress", [c.wallet, { limit: DISC_SIG_PAGE }]).catch(() => null)));
    chunk.forEach((c: any, i: number) => {
      const sigs = pages[i];
      if (sigs && historyTooShort(sigs, DISC_SIG_PAGE, nowSec, RESEARCH_DAYS * 0.8)) { st.too_new++; return; }
      if (st.vetted.length < DISC_QUEUE_MAX) st.vetted.push(c); // lookup failure: let research decide
    });
    st.vet_next += chunk.length;
    await setRow("discovery", st);
  }
  if (st.vet_next < st.candidates.length && st.vetted.length < DISC_QUEUE_MAX) {
    return { phase: "vetting", vetted: st.vet_next, of: st.candidates.length };
  }

  const now = new Date().toISOString();
  const rows = st.vetted.map((c: any) => ({
    wallet: c.wallet, label: `${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)}`,
    source: "On-chain discovery: bought and sold established Solana coins at a profit (GeckoTerminal pools passing the entry filter)",
    source_snapshot: { views: `Round-trip profit ${c.profit.toFixed(2)} SOL on ${c.n} established coin(s): ${c.names.slice(0, 4).join(", ")}`, found_at: now },
    status: "queued", sig_cursor: null, pages_fetched: 0, attempts: 0, metrics: null, error: null, requested_at: now, completed_at: null,
  }));
  if (rows.length) await db.from("sol_research").upsert(rows);
  const r = st.reasons ?? {};
  const sellers = Object.values(r).reduce((x: number, y: any) => x + Number(y), 0);
  const funnel = `${sellers} sellers of 1+ SOL on ${st.pools.length} established coins · ${r.sold_without_buying ?? 0} sold without buying · ` +
    `${r.not_profitable ?? 0} not profitable · ${(r.uncopyable_size ?? 0) + (r.bot_frequency ?? 0)} bot-like or uncopyable size · ` +
    `${st.candidates.length} candidates (incl. ${st.birdeye?.found ?? 0} from Birdeye${st.birdeye?.used ? "" : ", no key"}${st.birdeye?.error ? ", " + st.birdeye.error : ""}) · ${st.too_new} wallets too new · ${rows.length} queued`;
  st.done = true; st.queued = rows.length; st.finished_at = now; st.funnel = funnel;
  await setRow("discovery", st);
  await logEvent("discovery", funnel);
  const cfg = await getRow("config");
  if (TG_TOKEN && cfg.telegram_chat_id && rows.length) {
    await tgSend(cfg.telegram_chat_id, `🔎 <b>Found ${rows.length} new wallets</b> that bought and sold established coins (passing the entry filter) at a profit (none from the public leaderboards). Each now gets the 90-day check, and any that pass go on the watch list automatically.\n<i>${esc(funnel)}</i>`).catch(() => {});
  }
  return { phase: "done", queued: rows.length, funnel };
}

// ---------- realtime: Helius webhook ----------
// Helius calls /webhook/helius the moment a tracked wallet appears in a confirmed transaction.
// The payload is only a trigger: the normal cursor-based run then reads and classifies the
// transactions, so trades are still deduped and the minute cron remains the backup.
// The webhook's address list is kept equal to the active wallets automatically.
async function syncHeliusWebhook(addresses: string[]) {
  if (!HELIUS_KEY) return { skipped: "no Helius key" };
  const want = [...new Set(addresses)].sort();
  const st = await getRow("helius_webhook");
  if (want.length === 0) return { skipped: "no active wallets", id: st.id ?? null };
  if (st.id && JSON.stringify(st.addresses ?? []) === JSON.stringify(want)) return { ok: true, id: st.id, wallets: want.length };
  const secrets = await getRow("secrets");
  let auth = secrets.helius_webhook_secret;
  if (!auth) {
    auth = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    await setRow("secrets", { ...secrets, helius_webhook_secret: auth });
  }
  const body = JSON.stringify({ webhookURL: `${SB_URL}/functions/v1/sol-tracker/webhook/helius`, transactionTypes: ["ANY"],
    accountAddresses: want, webhookType: "raw", authHeader: auth, txnStatus: "success" });
  const base = "https://mainnet.helius-rpc.com/v0/webhooks";
  let r = st.id
    ? await fetch(`${base}/${st.id}?api-key=${HELIUS_KEY}`, { method: "PUT", headers: { "content-type": "application/json" }, body })
    : await fetch(`${base}?api-key=${HELIUS_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (st.id && r.status === 404) r = await fetch(`${base}?api-key=${HELIUS_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.webhookID) throw new Error(`Helius webhook ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  await setRow("helius_webhook", { id: j.webhookID, addresses: want, synced_at: new Date().toISOString() });
  await logEvent("realtime", `Helius instant trigger now watching ${want.length} wallet(s)`);
  return { ok: true, id: j.webhookID, wallets: want.length, updated: true };
}
// Fast path: the raw webhook body already holds the full confirmed transaction(s), so a copy is
// recorded straight from it, without first re-reading every wallet's history over RPC. That saves
// roughly a second per copy. recordTrade() is idempotent per (signature, wallet), so the cursor run
// that follows only confirms what was already recorded, and remains the backup if this path fails.
async function fastPathFromWebhook(payload: any): Promise<number> {
  const txs: any[] = Array.isArray(payload) ? payload : payload ? [payload] : [];
  if (!txs.length) return 0;
  const [cfg, { data: wallets }] = await Promise.all([
    getRow("config"), db.from("sol_wallets").select("*").eq("status", "active"),
  ]);
  const byAddr = new Map((wallets ?? []).map((w: any) => [w.address, w]));
  let n = 0;
  await Promise.all(txs.map(async (tx) => {
    const sig = tx?.transaction?.signatures?.[0];
    if (!sig || !tx.meta || tx.meta.err) return;
    const keys: string[] = (tx.transaction.message?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k?.pubkey));
    for (const addr of keys) {
      const w = byAddr.get(addr);
      if (!w) continue;
      const p = parseSwap(tx, addr);
      if (p.kind !== "buy" && p.kind !== "sell") continue;
      if (p.kind === "buy" && Math.abs(p.solDelta) >= cfg.min_buy_sol) prefetchBuy(p.mint, cfg);
      await recordTrade(w, sig, p, cfg);
      n++;
    }
  }));
  return n;
}
// Runs after a webhook: one full run now, then fills paper orders as soon as each is due
// (sell copies after exec_delay_seconds, buys after the confirm-hold check), for up to ~2 minutes.
async function realtimeRun(received: number) {
  const started = Date.now();
  const r: any = await withLock(20_000, tickInner);
  const rt = await getRow("realtime");
  await setRow("realtime", { ...rt, last_webhook_at: new Date(received).toISOString(), last_run_ms: Date.now() - started,
    last_run: r?.skipped ? r.skipped : "ok", webhooks_received: (rt.webhooks_received ?? 0) + 1 });
  while (Date.now() - started < 120_000) {
    const { data: next } = await db.from("sol_paper_orders").select("due_at").eq("status", "queued").order("due_at").limit(1).maybeSingle();
    if (!next) break;
    const wait = Date.parse(next.due_at) - Date.now();
    if (wait > 120_000 - (Date.now() - started)) break;
    if (wait > 0) await sleep(wait + 300);
    await withLock(10_000, async () => {
      const cfg = await getRow("config");
      await processPaperOrders(cfg);
      await deliverAlerts(cfg);
    });
  }
}

// The secrets row changes rarely; a warm worker reuses it for 30 s instead of a DB read per request.
let secretsCache: { at: number; v: any } | null = null;
async function secretsCached() {
  if (secretsCache && Date.now() - secretsCache.at < 30_000) return secretsCache.v;
  const v = await getRow("secrets");
  secretsCache = { at: Date.now(), v };
  return v;
}
// ---------- HTTP ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/sol-tracker/, "") || "/";
  try {
    const secrets = await secretsCached();
    applyKeys(secrets);
    if (path === "/research/step") {
      if (req.headers.get("x-cron-secret") !== secrets.cron_secret) return json({ error: "unauthorized" }, 401);
      return json(await researchStep());
    }
    if (path === "/discover/step") {
      if (req.headers.get("x-cron-secret") !== secrets.cron_secret) return json({ error: "unauthorized" }, 401);
      return json(await discoverStep());
    }
    if (path === "/webhook/helius" && req.method === "POST") {
      if (!secrets.helius_webhook_secret || req.headers.get("authorization") !== secrets.helius_webhook_secret) return json({ error: "unauthorized" }, 401);
      const received = Date.now();
      const payload = await req.json().catch(() => null);
      const job = fastPathFromWebhook(payload)
        .catch((e) => logEvent("realtime_error", `fast path: ${clean(e)}`, "warn"))
        .then(() => realtimeRun(received))
        .catch((e) => logEvent("realtime_error", clean(e), "error"));
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(job); else await job;
      return json({ ok: true });
    }
    if (path === "/tick") {
      if (req.headers.get("x-cron-secret") !== secrets.cron_secret) return json({ error: "unauthorized" }, 401);
      return json(await tick());
    }
    if (req.headers.get("x-dashboard-token") !== secrets.dashboard_token) return json({ error: "unauthorized" }, 401);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const cfg = await getRow("config");

    if (path === "/state") {
      const [{ data: wallets }, { data: trades }, { data: events }, { data: ledger }] = await Promise.all([
        db.from("sol_wallets").select("*").neq("status", "removed").order("added_at"),
        db.from("sol_trades").select("*").in("kind", ["buy", "sell"]).order("block_time", { ascending: false }).limit(60),
        db.from("sol_events").select("*").order("at", { ascending: false }).limit(25),
        db.from("sol_paper_ledger").select("*").order("at", { ascending: false }).limit(40),
      ]);
      const health = await getRow("health");
      const { cash, open } = await paperState(cfg);
      const prices = await dexPairs(open.map((o: any) => o.mint));
      const { data: rs } = await db.from("sol_paper_ledger").select("at").eq("type", "reset").order("at", { ascending: false }).limit(1);
      const since = rs?.[0]?.at ?? "1970-01-01T00:00:00Z";
      const { data: closed } = await db.from("sol_paper_positions").select("realized_usd").gte("opened_at", since);
      const realized = (closed ?? []).reduce((s: number, r: any) => s + Number(r.realized_usd), 0);
      const positions = open.map((o: any) => {
        const px = prices[o.mint]?.priceUsd ?? null;
        const value = px != null ? Number(o.qty_open) * px : null;
        const cost = Number(o.cost_usd) * (Number(o.qty_open) / Number(o.qty));
        return { ...o, price_usd: px, value_usd: value, unrealized_usd: value != null ? value - cost : null };
      });
      const openValue = positions.reduce((s: number, p: any) => s + (p.value_usd ?? 0), 0);
      const stale = !health.last_tick_at || Date.now() - Date.parse(health.last_tick_at) > 5 * 60e3;
      const { telegram_chat_id, ...pub } = cfg;
      return json({
        now: new Date().toISOString(), config: pub, telegram: { bot_token_set: !!TG_TOKEN, chat_linked: !!telegram_chat_id },
        data_provider: { helius_key_set: !!HELIUS_KEY, keyed_rpc: KEYED_RPC },
        research: (await db.from("sol_research").select("wallet,label,source,source_snapshot,status,metrics,error,requested_at,completed_at,pages_fetched").order("requested_at")).data ?? [],
        health: { ...health, stale }, wallets, trades, events,
        paper: { cash, equity: cash + openValue, realized, starting: cfg.paper.starting_usd, positions, ledger },
      });
    }
    // "Would we buy this coin right now, and if not, why?" Same entry filter paper and live use.
    if (path === "/entry-check" && req.method === "GET") {
      const mint = String(url.searchParams.get("mint") ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: "mint required" }, 400);
      const mk = (await dexPairs([mint]))[mint] ?? null;
      const ec = await entryCheckFull(mk, mint, cfg);
      return json({ mint, symbol: mk?.symbol ?? null, pass: ec.pass, reasons: ec.reasons, rules: entryRules(cfg),
        market: mk && { fdvUsd: mk.fdvUsd, volume24hUsd: mk.volume24hUsd, liquidityUsd: mk.liquidityUsd, pairCreatedAt: mk.pairCreatedAt, hasWebsite: mk.hasWebsite, hasTwitter: mk.hasTwitter },
        rugcheck: rugCache[mint]?.r ?? null });
    }
    if (path === "/scorecard" && req.method === "GET") {
      const scores = await scoreTraders(cfg);
      return json({ rules: { ...SCORE_RULES }, copy_rules: copyRules(cfg), since: await lastResetAt(), traders: scores });
    }
    if (path === "/summary" && req.method === "POST") {
      return json({ ok: true, lines: await dailySummary(cfg, true) });
    }
    if (path === "/live" && req.method === "GET") {
      const kp = liveKeypair();
      const lc = liveCfg(cfg);
      const me = kp?.publicKey.toBase58() ?? null;
      const [{ data: positions }, { data: orders }, { data: copied }] = await Promise.all([
        db.from("sol_live_positions").select("*").order("opened_at", { ascending: false }).limit(50),
        db.from("sol_live_orders").select("id,created_at,updated_at,wallet,mint,symbol,side,status,sol_amount,tx_signature,error,attempts").order("created_at", { ascending: false }).limit(50),
        db.from("sol_wallets").select("address,label,status").eq("copy_live", true),
      ]);
      return json({
        config: lc, key_set: !!kp, key_error: LIVE_KEY_ERR, trading_wallet: me, balance_sol: me ? await walletSol(me) : null,
        spent_sol: await liveSpentSol(), copied_wallets: copied ?? [], positions: positions ?? [], orders: orders ?? [],
      });
    }
    if (path === "/live/config" && req.method === "POST") {
      const cur = liveCfg(cfg);
      const next: any = { ...cur };
      for (const k of Object.keys(LIVE_DEFAULTS) as (keyof LiveCfg)[]) {
        if (body[k] == null) continue;
        next[k] = typeof LIVE_DEFAULTS[k] === "boolean" ? !!body[k] : Math.max(0, Number(body[k]));
      }
      await setRow("config", { ...cfg, live: next });
      await logEvent("live", `Live settings changed: ${JSON.stringify(body)}`, "warn");
      await liveNotify(cfg, `⚙️ Live trading settings changed: ${esc(JSON.stringify(body))}`);
      return json({ ok: true, config: next });
    }
    // Emergency exit: stop buying and queue a full sell of every open position.
    if (path === "/live/sell-all" && req.method === "POST") {
      await setRow("config", { ...cfg, live: { ...liveCfg(cfg), enabled: false } });
      const { data: open } = await db.from("sol_live_positions").select("*").eq("status", "open");
      const stamp = Date.now();
      for (const p of open ?? []) {
        await db.from("sol_live_orders").insert({ source_signature: `sell-all-${stamp}-${p.mint}`, wallet: p.wallet, mint: p.mint, symbol: p.symbol,
          side: "sell", status: "pending", trade: { exit_type: "FULL", exit_pct: 100, panic: true } });
      }
      await logEvent("live", `Sell all: buying switched off, ${open?.length ?? 0} position(s) queued to sell`, "warn");
      await liveNotify(cfg, `🛑 <b>Sell all</b>: live buying switched off; selling ${open?.length ?? 0} open position(s) on the next tick.`);
      return json({ ok: true, queued: open?.length ?? 0 });
    }
    // Builds (and signs, if a key is set) a real Jupiter swap for a tiny amount, but never sends it.
    // Builds and signs the exact Jupiter Ultra order live would execute, but never sends it.
    if (path === "/live/dry-run" && req.method === "POST") {
      const kp = liveKeypair() ?? Keypair.generate();
      const mint = String(body.mint || USDC);
      const taker = String(body.taker || kp.publicKey.toBase58());
      const o = await ultraOrder(WSOL, mint, BigInt(Math.round(Number(body.sol ?? 0.01) * 1e9)), taker).catch((e) => ({ error: clean(e) }));
      if ((o as any).error) return json({ ok: false, error: (o as any).error }, 502);
      const tx = VersionedTransaction.deserialize(b64ToBytes((o as any).transaction));
      if (taker === kp.publicKey.toBase58()) tx.sign([kp]);
      return json({ ok: true, real_key: !!liveKeypair(), via: "ultra", out_amount: (o as any).outAmount, slippage_bps: (o as any).slippageBps,
        fee_bps: (o as any).feeBps, priority_fee_lamports: (o as any).prioritizationFeeLamports,
        route: (o as any).routePlan?.map((x: any) => x.swapInfo?.label), signed: taker === kp.publicKey.toBase58(),
        tx_bytes: tx.serialize().length, sent: false });
    }
    if (path === "/settings" && req.method === "POST") {
      const next = { ...cfg };
      if (body.min_buy_sol != null) next.min_buy_sol = Math.max(0, Number(body.min_buy_sol));
      if (body.alerts_paused != null) next.alerts_paused = !!body.alerts_paused;
      if (body.paper) next.paper = { ...cfg.paper, ...body.paper };
      if (body.entry) next.entry = { ...entryRules(cfg), ...body.entry };
      await setRow("config", next);
      await logEvent("settings", `Settings updated: ${JSON.stringify(body)}`);
      return json({ ok: true });
    }
    if (path === "/wallets" && req.method === "POST") {
      const address = String(body.address ?? "").trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return json({ error: "Not a valid Solana address" }, 400);
      const { count } = await db.from("sol_wallets").select("*", { count: "exact", head: true }).eq("status", "active");
      if ((count ?? 0) >= 5 && !body.replace) return json({ error: "Already tracking 5 wallets; replace one instead" }, 400);
      if (body.replace) await db.from("sol_wallets").update({ status: "removed" }).eq("address", body.replace);
      const { error } = await db.from("sol_wallets").upsert({
        address, label: String(body.label || address.slice(0, 6)), status: "active",
        evidence: body.evidence ?? {}, source: body.source ?? "dashboard", last_signature: null, consecutive_errors: 0,
      });
      if (error) throw error;
      await logEvent("wallet", body.replace ? `Replaced ${body.replace} with ${address}` : `Added ${address}`);
      return json({ ok: true });
    }
    if (path === "/wallets/status" && req.method === "POST") {
      await db.from("sol_wallets").update({ status: body.status }).eq("address", body.address);
      await logEvent("wallet", `Set ${body.address} to ${body.status}`);
      return json({ ok: true });
    }
    if (path === "/telegram/link" && req.method === "POST") {
      if (!TG_TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN secret is not set in Supabase" }, 400);
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`);
      const j = await r.json();
      const msgs = (j.result ?? []).map((u: any) => u.message ?? u.channel_post).filter(Boolean);
      const last = msgs.at(-1);
      if (!last) return json({ error: "No messages found. Send /start to your bot in Telegram, then try again." }, 400);
      await setRow("config", { ...cfg, telegram_chat_id: last.chat.id });
      await tgSend(last.chat.id, "✅ Linked. Trade alerts from your Solana monitor will arrive in this chat.");
      await logEvent("telegram", `Linked Telegram chat ${last.chat.type}`);
      return json({ ok: true, chat_type: last.chat.type });
    }
    if (path === "/telegram/test" && req.method === "POST") {
      if (!cfg.telegram_chat_id) return json({ error: "Telegram chat not linked yet" }, 400);
      const fake = {
        kind: "buy", wallet: "TEST", mint: WSOL, signature: "TEST", token_name: "Test Token", token_symbol: "TEST",
        sol_value: 0.75, quote: "SOL", quote_amount: 0.75, token_amount: 12345, block_time: new Date().toISOString(),
        market: { liquidityUsd: 50000, fdvUsd: 400000, priceUsd: 0.0012 }, risk: ["Example flag"],
      };
      const id = await tgSend(cfg.telegram_chat_id, alertText(fake, "Test trader", true));
      await logEvent("telegram", `Test alert delivered (message ${id})`);
      return json({ ok: true, message_id: id });
    }
    if (path === "/tick-now" && req.method === "POST") return json(await tick());
    if (path === "/analyze") {
      const w = url.searchParams.get("wallet") ?? body.wallet;
      return json(await analyze(w, Math.min(250, Number(url.searchParams.get("limit") ?? body.limit ?? 60))));
    }
    if (path === "/parse") {
      const sig = url.searchParams.get("signature") ?? body.signature;
      const w = url.searchParams.get("wallet") ?? body.wallet;
      return json(parseSwap(await getTx(sig), w));
    }
    if (path === "/research" && req.method === "POST") {
      const list = Array.isArray(body.wallets) ? body.wallets : [];
      const rows = list.filter((w: any) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(w.address ?? "")))
        .map((w: any) => ({ wallet: w.address, label: String(w.label || w.address.slice(0, 6)), source: w.source ?? null,
          source_snapshot: w.snapshot ?? null, status: "queued", sig_cursor: null, pages_fetched: 0, attempts: 0,
          metrics: null, error: null, requested_at: new Date().toISOString(), completed_at: null }));
      if (!rows.length) return json({ error: "No valid wallets" }, 400);
      for (const r of rows) await db.from("sol_research_swaps").delete().eq("wallet", r.wallet);
      const { error } = await db.from("sol_research").upsert(rows);
      if (error) throw error;
      await logEvent("research", `Queued ${rows.length} wallet(s) for 90-day research`);
      return json({ ok: true, queued: rows.length, helius_key_set: !!HELIUS_KEY });
    }
    if (path === "/research/promote" && req.method === "POST") {
      // Re-assess finished research with the current rules and fill the paper watch list, best first.
      const { data: done } = await db.from("sol_research").select("*").eq("status", "done");
      for (const r of done ?? []) {
        if (!r.metrics?.d90) continue;
        r.metrics.assessment = assess(r.metrics, RESEARCH_DAYS, Math.floor(Date.parse(r.requested_at) / 1000));
        await db.from("sol_research").update({ metrics: r.metrics }).eq("wallet", r.wallet);
      }
      const out: any[] = [];
      for (const r of rankWatch(done ?? [])) {
        const { data: w } = await db.from("sol_wallets").select("*").eq("address", r.wallet).maybeSingle();
        const tracked = w?.evidence?.provisional && w.status === "active" ? await settleProvisional(r, r.metrics, w) : await autoTrack(r, r.metrics);
        out.push({ wallet: r.wallet, label: r.label, tier: tierOf(r.metrics), passed: r.metrics.assessment.passed, d90: r.metrics.d90.realized_sol, tracked });
      }
      return json({ ok: true, candidates: out });
    }
    if (path === "/research" && req.method === "GET") {
      const { data } = await db.from("sol_research").select("*").order("requested_at");
      return json({ helius_key_set: !!HELIUS_KEY, research: data ?? [] });
    }
    if (path === "/paper/reset" && req.method === "POST") {
      // History is kept (it is how the 2026-11-23 entry filter was found): open positions are closed
      // as abandoned, not deleted, and results are counted from the latest reset marker onward.
      await db.from("sol_paper_positions").update({ status: "closed", closed_at: new Date().toISOString() }).eq("status", "open");
      await db.from("sol_paper_orders").update({ status: "cancelled" }).eq("status", "queued");
      await db.from("sol_paper_ledger").insert({ type: "reset", note: String(body.note ?? "Simulation reset") });
      return json({ ok: true });
    }
    return json({ error: "not found", path }, 404);
  } catch (e) {
    return json({ error: clean(e) }, 500);
  }
});
