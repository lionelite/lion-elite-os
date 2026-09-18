#!/usr/bin/env python3
"""Resolve an approved Lion Elite vial by product name and extract it from the canonical repo archive.

Usage:
  python scripts/vial-asset.py "RETATRUTIDE"
  python scripts/vial-asset.py "CJC IPAMORELIN" --output /tmp/cjc.webp

Fails closed when the requested product is not exactly mapped/approved.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "assets" / "vials" / "manifest.json"


def normalize(value: str) -> str:
    return " ".join(value.strip().upper().split())


def resolve(product_name: str):
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    wanted = normalize(product_name)
    matches = [
        a for a in data.get("assets", [])
        if a.get("approved") is True and normalize(a.get("product_name", "")) == wanted
    ]
    if len(matches) != 1:
        raise SystemExit(f"BLOCKED: exact approved vial asset not found for {product_name!r}")
    return data, matches[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("product_name")
    parser.add_argument("--output")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    data, asset = resolve(args.product_name)
    archive = ROOT / data["archive_path"]
    if not archive.exists():
        raise SystemExit(f"BLOCKED: canonical vial archive missing: {archive}")

    output = pathlib.Path(args.output) if args.output else pathlib.Path("/tmp/lion-elite-vials") / f"{asset['slug']}.webp"
    output.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(archive) as zf:
        member = asset["archive_member"]
        if member not in zf.namelist():
            raise SystemExit(f"BLOCKED: mapped vial file missing from archive: {member}")
        with zf.open(member) as src, output.open("wb") as dst:
            shutil.copyfileobj(src, dst)

    result = {**asset, "resolved_path": str(output)}
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
