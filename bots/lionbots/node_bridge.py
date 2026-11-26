"""Call a function exported by one of the repo's own JS modules.

Bots reuse the repo's tested rules (RUO compliance, funnel validation) instead
of re-implementing them in Python, where the two copies would drift.
"""

from __future__ import annotations

import json
import shutil
import subprocess

from .paths import REPO_ROOT

_SCRIPT = (
    "const m=require(process.argv[1]);let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{"
    "const a=JSON.parse(s);try{const r=m[process.argv[2]](...a);process.stdout.write(JSON.stringify({ok:true,value:r===undefined?null:r}))}"
    "catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e&&e.message||e),code:e&&e.code||null}))}})"
)


class NodeUnavailable(Exception):
    pass


def call(module_rel: str, fn: str, *args):
    """Returns {'ok': True, 'value': ...} or {'ok': False, 'error': ..., 'code': ...}."""
    node = shutil.which("node")
    module = REPO_ROOT / module_rel
    if not node:
        raise NodeUnavailable("node is not on PATH")
    if not module.exists():
        raise NodeUnavailable(f"{module_rel} not found")
    proc = subprocess.run([node, "-e", _SCRIPT, str(module), fn], input=json.dumps(list(args)),
                          capture_output=True, text=True, timeout=60, cwd=REPO_ROOT)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[:500])
    return json.loads(proc.stdout)


def compliance(text: str, mode: str, require_disclaimer: bool = False) -> dict:
    """The repo's RUO / coaching validator. Raises NodeUnavailable if it can't run."""
    res = call("lib/social/social-compliance.js", "validateContent",
               {"text": text, "complianceMode": mode, "requireDisclaimer": require_disclaimer})
    if not res["ok"]:
        raise RuntimeError(res["error"])
    return res["value"]
