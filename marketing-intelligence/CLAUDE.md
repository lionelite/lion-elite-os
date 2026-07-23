# Marketing Intelligence — Claude Code Rules

## Vial asset source of truth

Before creating ANY Lion Elite Wellness product-specific creative, use the repository asset library instead of inventing or substituting a vial.

Primary manifest:

`../assets/vials/manifest.json`

Gmail source registry:

`vial_asset_sources.json`

Sync worker:

`vial_asset_sync.py`

## Mandatory workflow

1. Determine the exact peptide/product being discussed.
2. Read `../assets/vials/manifest.json`.
3. Select only an asset with `approved: true` and an exact `product_name` match.
4. Match the correct quantity/SKU when quantity matters.
5. Use that real Lion Elite vial photo as the source/reference for the creative.
6. Verify headline, vial label, quantity, caption and product name all agree.
7. Run Marketing Intelligence checkpoints before publishing.
8. If an exact approved vial asset is unavailable, BLOCK publication rather than substitute another product.

## Never do this

- Never use a Selank vial in CJC-1295/Ipamorelin content.
- Never use a generic peptide vial when an approved Lion Elite vial exists.
- Never redesign the label inside a generated scene.
- Never infer a quantity that is not mapped in the manifest.
- Never publish an unmapped asset.

## Ingestion

`vial_asset_sync.py` is designed to copy media from the approved Gmail source messages into GitHub under:

`assets/vials/inbox/<gmail-message-id>/`

New files enter the manifest as `approved: false` and `needs_product_mapping: true`. Product mapping/approval must happen before use.
