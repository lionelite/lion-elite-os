# Lion Elite Wellness — Canonical Vial Library

This directory is the source of truth for product-specific vial imagery used by Lion Elite marketing/content automation.

## Source

The assets came from the user-confirmed canonical Gmail vial-image email and were mapped to exact products before inclusion.

## Files

- `manifest.json` — exact product/quantity → approved asset mapping.
- `canonical/canonical-vials-200.zip` — compact repository bundle containing all 20 approved WebP vial images.
- `../../scripts/vial-asset.py` — fail-closed resolver/extractor for Claude Code, Render workers, and local content tooling.

## Required workflow

1. Determine the exact product being discussed.
2. Resolve it through `manifest.json` / `scripts/vial-asset.py`.
3. Use only the returned approved vial image.
4. Verify product name, vial label, quantity, headline, and caption agree.
5. If no exact approved mapping exists, block publication.

Example:

```bash
python scripts/vial-asset.py "RETATRUTIDE" --output /tmp/retatrutide.webp
python scripts/vial-asset.py "CJC IPAMORELIN" --json
```

## Hard rule

Never substitute one peptide vial for another. A CJC/Ipamorelin creative showing a Selank vial is a mandatory Product Accuracy failure and must not publish.
