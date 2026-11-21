// Solana trader monitor: polls tracked wallets, detects swaps, sends Telegram alerts,
// runs a paper-trading simulation, and serves a JSON API for the dashboard.
// Monitoring + paper trading only. This code never holds keys and never signs transactions.
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseSwap, researchMetrics, WSOL, USDC, USDT } from "./lib.ts";

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
let TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
let RPC_URL = "", KEYED_RPC = false, MAX_TX_PER_TICK = 40, SIG_PAGE = 100;
function applyKeys(secrets: any = {}) {
  HELIUS_KEY = Deno.env.get("HELIUS_API_KEY") || secrets.helius_api_key || "";
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
// A copied trade is queued and filled `exec_delay_seconds` after detection at the price *then*,
// so the simulation pays for being late instead of filling at the moment it noticed the trade.
async function paperOnTrade(t: any, cfg: any) {
  const extra = Number(cfg.paper.exec_delay_seconds ?? 0);
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
  for (const o of due) {
    try {
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
  const sol = await solUsd();
  const delay = t.block_time ? (Date.now() - Date.parse(t.block_time)) / 1000 : null;
  const prio = sol ? p.priority_fee_sol * sol : 0;
  const base = { wallet: t.wallet, mint: t.mint, symbol: t.token_symbol, source_signature: t.signature, delay_seconds: delay };
  if (!price) {
    await db.from("sol_paper_ledger").insert({ ...base, type: "skip", note: "No price available at detection" });
    return;
  }
  const { cash, open } = await paperState(cfg);
  if (t.kind === "buy") {
    if (open.find((o: any) => o.mint === t.mint)) {
      await db.from("sol_paper_ledger").insert({ ...base, type: "skip", note: "Already holding this token" });
      return;
    }
    if (open.length >= p.max_open_positions) {
      await db.from("sol_paper_ledger").insert({ ...base, type: "skip", note: "Max open positions reached" });
      return;
    }
    const equityGuess = cash + open.reduce((s: number, o: any) => s + Number(o.cost_usd), 0);
    const size = Math.min(equityGuess * p.position_pct / 100, p.max_position_usd, cash);
    if (size < 2) {
      await db.from("sol_paper_ledger").insert({ ...base, type: "skip", note: "Not enough simulated cash" });
      return;
    }
    const fill = price * (1 + p.slippage_pct / 100);
    const net = size * (1 - p.fee_pct / 100) - prio;
    const qty = net / fill;
    await db.from("sol_paper_positions").insert({
      wallet: t.wallet, mint: t.mint, symbol: t.token_symbol, source_signature: t.signature,
      entry_price_usd: fill, qty, qty_open: qty, cost_usd: size,
    });
    await db.from("sol_paper_ledger").insert({ ...base, type: "buy", usd: size, price_usd: fill,
      note: `SIMULATED buy ${fmt(qty, 0)} @ ${usd(fill)} (incl. ${p.slippage_pct}% slippage, ${p.fee_pct}% fee, priority fee)` });
  } else if (t.kind === "sell" && p.copy_sells) {
    const pos = open.find((o: any) => o.mint === t.mint && o.wallet === t.wallet);
    if (!pos) return;
    const frac = t.exit_type === "FULL" ? 1 : Math.min(1, Math.max(0, (t.exit_pct ?? 100) / 100));
    const q = Number(pos.qty_open) * frac;
    const fill = price * (1 - p.slippage_pct / 100);
    const proceeds = Math.max(0, q * fill * (1 - p.fee_pct / 100) - prio);
    const costPart = Number(pos.cost_usd) * (q / Number(pos.qty));
    const left = Number(pos.qty_open) - q;
    await db.from("sol_paper_positions").update({
      qty_open: left, realized_usd: Number(pos.realized_usd) + proceeds - costPart,
      status: left <= Number(pos.qty) * 0.001 ? "closed" : "open",
      closed_at: left <= Number(pos.qty) * 0.001 ? new Date().toISOString() : null,
    }).eq("id", pos.id);
    await db.from("sol_paper_ledger").insert({ ...base, type: "sell", usd: proceeds, price_usd: fill,
      note: `SIMULATED ${t.exit_type ?? ""} sell ${Math.round(frac * 100)}% @ ${usd(fill)}, P/L ${usd(proceeds - costPart)}` });
  }
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
  const sol = await solUsd();
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
    mk = (await dexPairs([p.mint]))[p.mint];
    risk = riskFlags(mk, await mintAuthorities(p.mint), solValue, sol);
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

let ticking = false;
async function tick() {
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
    let paperFilled = 0;
    try { paperFilled = await processPaperOrders(cfg); } catch (e) { await logEvent("paper_error", clean(e), "warn"); }
    results["paper_orders_filled"] = paperFilled;
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
    const metrics = researchMetrics(all, Math.floor(Date.parse(r.requested_at) / 1000), RESEARCH_DAYS);
    const failed = all.filter((x) => x.kind === "fetch_failed").length;
    await db.from("sol_research").update({
      status: "done", metrics: { ...metrics, capped_at_swaps: r.capped ? RESEARCH_SWAP_CAP : null, swaps_listed: all.length, fetch_failed: failed, stablecoin_trades_excluded: all.filter((x) => (x.kind === "buy" || x.kind === "sell") && x.sol_delta == null).length },
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: null,
    }).eq("wallet", r.wallet);
    await logEvent("research", `${r.label}: ${metrics.assessment.passed}/${metrics.assessment.total} checks passed`, "info", r.wallet);
    let tracked = false;
    const { data: tw } = await db.from("sol_wallets").select("*").eq("address", r.wallet).maybeSingle();
    if (tw?.evidence?.provisional && tw.status === "active") tracked = await settleProvisional(r, metrics, tw);
    else if (metrics.assessment.qualifies) tracked = await autoTrack(r, metrics);
    await researchSummaryIfFinished();
    return { wallet: r.label, phase: "done", qualifies: metrics.assessment.qualifies, tracked };
  } catch (e) {
    const attempts = (r.attempts ?? 0) + 1;
    await db.from("sol_research").update({
      error: clean(e), attempts, status: attempts >= 8 ? "error" : r.status, updated_at: new Date().toISOString(),
    }).eq("wallet", r.wallet);
    return { wallet: r.label, error: clean(e) };
  }
}

// A trader that passes every research check goes straight onto the watch list (max 5 active),
// with its evidence stored on the wallet row, and the owner is told in Telegram.
const solStr = (n: number | null | undefined) => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${Number(n).toFixed(2)} SOL`);
async function autoTrack(r: any, m: any): Promise<boolean> {
  const cfg = await getRow("config");
  const { data: existing } = await db.from("sol_wallets").select("address,status").eq("address", r.wallet).maybeSingle();
  if (existing && existing.status === "active") return false;
  const { count } = await db.from("sol_wallets").select("*", { count: "exact", head: true }).eq("status", "active");
  const summary = `${m.assessment.passed}/${m.assessment.total} checks · 30d ${solStr(m.d30.realized_sol)} · 60d ${solStr(m.d60.realized_sol)} · 90d ${solStr(m.d90.realized_sol)} realized · win ${m.d90.win_rate_pct}% · median buy ${m.median_buy_sol} SOL`;
  if ((count ?? 0) >= 5) {
    // Full: a verified trader takes the place of a provisional one (one whose research is not done first).
    const { data: prov } = await db.from("sol_wallets").select("address,label,evidence").eq("status", "active");
    const provisional = (prov ?? []).filter((w: any) => w.evidence?.provisional);
    if (provisional.length) {
      const victim = provisional[0];
      await db.from("sol_wallets").update({ status: "paused", last_error: `Replaced by verified trader ${r.label}` }).eq("address", victim.address);
      await logEvent("wallet", `Paused provisional ${victim.label} to make room for verified ${r.label}`, "info", victim.address);
      if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, `🔁 Swapped out provisional <b>${esc(victim.label)}</b> for verified <b>${esc(r.label)}</b>.`).catch(() => {});
      return await autoTrack(r, m);
    }
    await logEvent("research", `${r.label} qualifies but 5 wallets are already tracked`, "info", r.wallet);
    if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, `✅ <b>${esc(r.label)}</b> passed research but you already track 5 wallets. Swap it in from the dashboard if you want it.\n${esc(summary)}`).catch(() => {});
    return false;
  }
  await db.from("sol_wallets").upsert({
    address: r.wallet, label: r.label, status: "active", source: r.source ?? "research",
    evidence: { summary, researched_at: new Date().toISOString(), source: r.source, source_snapshot: r.source_snapshot, metrics: m },
    last_signature: null, consecutive_errors: 0, last_error: null,
  });
  await logEvent("wallet", `Auto-tracked ${r.label} after passing all research checks`, "info", r.wallet);
  if (TG_TOKEN && cfg.telegram_chat_id) {
    await tgSend(cfg.telegram_chat_id, [
      `👀 <b>Now tracking ${esc(r.label)}</b>`,
      `<code>${esc(r.wallet)}</code>`,
      esc(summary),
      `Max drawdown ${solStr(m.max_drawdown_sol)} · median hold ${m.median_hold_seconds ?? "n/a"}s · ${m.round_trips_under_60s_pct ?? "n/a"}% flips under 60s`,
      `<a href="https://gmgn.ai/sol/address/${esc(r.wallet)}">GMGN wallet</a>`,
      "<i>Alerts on its buys (0.5 SOL+) and sells start now. Monitoring only.</i>",
    ].join("\n")).catch(() => {});
  }
  return true;
}
// A provisional wallet was put on the watch list before its research finished.
// Pass: it becomes a verified wallet. Fail: it is paused and the owner is told which check it failed.
async function settleProvisional(r: any, m: any, w: any): Promise<boolean> {
  const cfg = await getRow("config");
  const summary = `${m.assessment.passed}/${m.assessment.total} checks · 30d ${solStr(m.d30.realized_sol)} · 60d ${solStr(m.d60.realized_sol)} · 90d ${solStr(m.d90.realized_sol)} realized · win ${m.d90.win_rate_pct}% · median buy ${m.median_buy_sol} SOL`;
  const label = String(w.label).replace(/\s*\(provisional\)$/i, "");
  if (m.assessment.qualifies) {
    await db.from("sol_wallets").update({ label, evidence: { summary, researched_at: new Date().toISOString(), source: r.source, source_snapshot: r.source_snapshot, metrics: m } }).eq("address", w.address);
    await logEvent("wallet", `${label} confirmed by research`, "info", w.address);
    if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, `✅ <b>${esc(label)}</b> passed research and stays on the watch list.\n${esc(summary)}`).catch(() => {});
    return true;
  }
  const fail = m.assessment.rules.find((x: any) => !x.pass);
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
  const { data: active } = await db.from("sol_wallets").select("label").eq("status", "active");
  const lines = [
    `📋 <b>Trader research finished</b> — ${all.length} wallets checked on 90 days of on-chain swaps`,
    passed.length ? `Passed all checks: ${passed.map((x: any) => esc(x.label)).join(", ")}` : "No wallet passed every check, so none were added. I'd rather track nobody than an unproven trader.",
    `Now tracking: ${(active ?? []).map((w: any) => esc(w.label)).join(", ") || "none"}`,
    ...all.filter((x: any) => !x.metrics?.assessment?.qualifies).map((x: any) => {
      const a = x.metrics?.assessment;
      const firstFail = a?.rules?.find((rr: any) => !rr.pass);
      return `• ${esc(x.label)}: ${a ? `${a.passed}/${a.total}` : x.status}${firstFail ? ` — failed “${esc(firstFail.rule)}” (${esc(firstFail.detail)})` : ""}`;
    }),
  ];
  if (TG_TOKEN && cfg.telegram_chat_id) await tgSend(cfg.telegram_chat_id, lines.join("\n").slice(0, 3900)).catch(() => {});
  await setRow("research_summary", { batch, sent_at: new Date().toISOString(), passed: passed.map((x: any) => x.label) });
}

// ---------- HTTP ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/sol-tracker/, "") || "/";
  try {
    const secrets = await getRow("secrets");
    applyKeys(secrets);
    if (path === "/research/step") {
      if (req.headers.get("x-cron-secret") !== secrets.cron_secret) return json({ error: "unauthorized" }, 401);
      return json(await researchStep());
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
      const { data: closed } = await db.from("sol_paper_positions").select("realized_usd");
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
    if (path === "/settings" && req.method === "POST") {
      const next = { ...cfg };
      if (body.min_buy_sol != null) next.min_buy_sol = Math.max(0, Number(body.min_buy_sol));
      if (body.alerts_paused != null) next.alerts_paused = !!body.alerts_paused;
      if (body.paper) next.paper = { ...cfg.paper, ...body.paper };
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
    if (path === "/research" && req.method === "GET") {
      const { data } = await db.from("sol_research").select("*").order("requested_at");
      return json({ helius_key_set: !!HELIUS_KEY, research: data ?? [] });
    }
    if (path === "/paper/reset" && req.method === "POST") {
      await db.from("sol_paper_positions").delete().gte("id", 0);
      await db.from("sol_paper_orders").update({ status: "cancelled" }).eq("status", "queued");
      await db.from("sol_paper_ledger").insert({ type: "reset", note: "Simulation reset" });
      return json({ ok: true });
    }
    return json({ error: "not found", path }, 404);
  } catch (e) {
    return json({ error: clean(e) }, 500);
  }
});
