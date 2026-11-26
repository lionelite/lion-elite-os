"""Public, keyless data sources: PubMed, ClinicalTrials.gov, DexScreener.

Reads only. If a host is unreachable from where the bot runs (this dev
sandbox's proxy refuses all three), the caller gets SourceUnavailable and
reports `blocked` with the host, rather than an empty result that looks like
"nothing found".
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from .bot import BotError

USER_AGENT = "lionbots/0.1 (research tooling)"


class SourceUnavailable(Exception):
    def __init__(self, host: str, detail: str):
        super().__init__(f"{host}: {detail}")
        self.host, self.detail = host, detail


def get_json(url: str, params: dict | None = None, timeout: int = 20, opener=None):
    full = url + ("?" + urllib.parse.urlencode(params, doseq=True) if params else "")
    host = urllib.parse.urlparse(url).hostname or url
    req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 429 or exc.code >= 500:
            raise BotError(f"{host} returned {exc.code}; will retry") from exc
        raise SourceUnavailable(host, f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceUnavailable(host, str(getattr(exc, "reason", exc))) from exc


EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


def pubmed_search(term: str, retmax: int = 10, clinical_only: bool = False, opener=None) -> list[dict]:
    if clinical_only:
        term = f"({term}) AND (clinical trial[pt] OR randomized controlled trial[pt] OR meta-analysis[pt])"
    ids = get_json(f"{EUTILS}/esearch.fcgi", {"db": "pubmed", "term": term, "retmode": "json",
                                               "retmax": retmax, "sort": "relevance"}, opener=opener)
    pmids = ids.get("esearchresult", {}).get("idlist", [])
    if not pmids:
        return []
    summary = get_json(f"{EUTILS}/esummary.fcgi", {"db": "pubmed", "id": ",".join(pmids), "retmode": "json"},
                       opener=opener).get("result", {})
    out = []
    for pmid in pmids:
        s = summary.get(pmid, {})
        out.append({
            "pmid": pmid,
            "title": s.get("title"),
            "journal": s.get("fulljournalname") or s.get("source"),
            "year": (s.get("pubdate") or "")[:4],
            "publication_types": s.get("pubtype", []),
            "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        })
    return out


CTGOV = "https://clinicaltrials.gov/api/v2/studies"


def trials_search(intervention: str, condition: str | None = None, status: list[str] | None = None,
                  page_size: int = 10, opener=None) -> list[dict]:
    params = {"query.intr": intervention, "pageSize": page_size, "format": "json"}
    if condition:
        params["query.cond"] = condition
    if status:
        params["filter.overallStatus"] = ",".join(status)
    data = get_json(CTGOV, params, opener=opener)
    out = []
    for st in data.get("studies", []):
        p = st.get("protocolSection", {})
        ident, stat, design = p.get("identificationModule", {}), p.get("statusModule", {}), p.get("designModule", {})
        nct = ident.get("nctId")
        out.append({
            "nct_id": nct,
            "title": ident.get("briefTitle"),
            "status": stat.get("overallStatus"),
            "phases": design.get("phases", []),
            "enrollment": design.get("enrollmentInfo", {}).get("count"),
            "conditions": p.get("conditionsModule", {}).get("conditions", []),
            "sponsor": p.get("sponsorCollaboratorsModule", {}).get("leadSponsor", {}).get("name"),
            "has_results": st.get("hasResults", False),
            "url": f"https://clinicaltrials.gov/study/{nct}" if nct else None,
        })
    return out


DEXSCREENER = "https://api.dexscreener.com/latest/dex/search"


def dex_search(query: str, opener=None) -> list[dict]:
    data = get_json(DEXSCREENER, {"q": query}, opener=opener)
    out = []
    for pair in data.get("pairs") or []:
        created = pair.get("pairCreatedAt")
        age_h = None
        if created:
            age_h = round((datetime.now(timezone.utc).timestamp() * 1000 - created) / 3_600_000, 1)
        out.append({
            "chain": pair.get("chainId"),
            "dex": pair.get("dexId"),
            "pair_address": pair.get("pairAddress"),
            "symbol": (pair.get("baseToken") or {}).get("symbol"),
            "token_address": (pair.get("baseToken") or {}).get("address"),
            "price_usd": pair.get("priceUsd"),
            "liquidity_usd": (pair.get("liquidity") or {}).get("usd"),
            "market_cap_usd": pair.get("marketCap") or pair.get("fdv"),
            "volume_24h_usd": (pair.get("volume") or {}).get("h24"),
            "age_hours": age_h,
            "url": pair.get("url"),
        })
    return sorted(out, key=lambda p: p.get("liquidity_usd") or 0, reverse=True)


# --- Lion Elite OS's own systems (read-only) ------------------------------------

OUTREACH_HEALTH_URL = "https://lion-elite-os.onrender.com/health/outreach"


def supabase_get(table: str, params: dict | None = None, *, count: bool = False, env=None, opener=None):
    """Read one Supabase table over PostgREST. GET/HEAD only: this helper cannot write.

    count=True returns the exact row count for the filter instead of rows.
    Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; the caller checks for them.
    """
    import os

    env = env if env is not None else os.environ
    base = env["SUPABASE_URL"].rstrip("/")
    key = env["SUPABASE_SERVICE_ROLE_KEY"]
    url = f"{base}/rest/v1/{table}"
    full = url + ("?" + urllib.parse.urlencode(params or {}) if params else "")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "User-Agent": USER_AGENT, "Accept": "application/json"}
    if count:
        headers["Prefer"] = "count=exact"
        headers["Range"] = "0-0"
    req = urllib.request.Request(full, headers=headers, method="GET")
    host = urllib.parse.urlparse(url).hostname or url
    try:
        with (opener or urllib.request.urlopen)(req, timeout=30) as resp:
            if count:
                rng = (getattr(resp, "headers", None) or {}).get("Content-Range", "*/0")
                return int(str(rng).rsplit("/", 1)[-1] or 0)
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 429 or exc.code >= 500:
            raise BotError(f"{host} returned {exc.code}; will retry") from exc
        # Never echo the request (it carries the key); the table name is enough.
        raise SourceUnavailable(host, f"HTTP {exc.code} reading {table}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceUnavailable(host, str(getattr(exc, "reason", exc))) from exc


def post_json(url: str, body, timeout: int = 20, opener=None, headers: dict | None = None):
    host = urllib.parse.urlparse(url).hostname or url
    data = json.dumps(body).encode("utf-8")
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json", "Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    try:
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 429 or exc.code >= 500:
            raise BotError(f"{host} returned {exc.code}; will retry") from exc
        raise SourceUnavailable(host, f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceUnavailable(host, str(getattr(exc, "reason", exc))) from exc


# --- Solana (public JSON-RPC, read-only) ----------------------------------------

SOLANA_RPC = "https://api.mainnet-beta.solana.com"
WSOL = "So11111111111111111111111111111111111111112"


def solana_rpc(method: str, params: list, *, url: str | None = None, opener=None):
    import os

    rpc = url or os.environ.get("SOLANA_RPC_URL") or SOLANA_RPC
    out = post_json(rpc, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, opener=opener)
    if isinstance(out, dict) and out.get("error"):
        err = out["error"]
        if isinstance(err, dict) and err.get("code") in (429, -32005):
            raise BotError(f"Solana RPC rate limited: {err.get('message')}")
        raise SourceUnavailable(urllib.parse.urlparse(rpc).hostname or rpc, f"RPC error {err}")
    return out.get("result")


DEX_TOKENS = "https://api.dexscreener.com/tokens/v1/solana/"


def dex_token_prices(mints: list[str], opener=None) -> dict[str, dict]:
    """Best (deepest) pair per mint: {mint: {price_usd, liquidity_usd, symbol}}. Up to 30 mints a call."""
    out: dict[str, dict] = {}
    mints = [m for m in dict.fromkeys(mints) if m]
    for i in range(0, len(mints), 30):
        chunk = mints[i:i + 30]
        pairs = get_json(DEX_TOKENS + ",".join(chunk), opener=opener) or []
        for p in pairs if isinstance(pairs, list) else []:
            mint = (p.get("baseToken") or {}).get("address")
            if mint not in chunk:
                continue
            liq = (p.get("liquidity") or {}).get("usd") or 0
            if mint in out and out[mint]["liquidity_usd"] >= liq:
                continue
            try:
                price = float(p.get("priceUsd"))
            except (TypeError, ValueError):
                continue
            out[mint] = {"price_usd": price, "liquidity_usd": liq,
                         "symbol": (p.get("baseToken") or {}).get("symbol"), "url": p.get("url")}
    return out
