# content/

Output directory for the daily social content pipeline
(`scripts/generate-social-content.js`, run by
`.github/workflows/daily-social-content.yml`).

Generated output is **not** committed to `main` — it accumulates on the
unprotected `automation/social-content` branch:

- `generated/YYYY-MM-DD/` — structured JSON, daily Metricool CSV, media
  prompts, and the generation log for each day.
- `metricool-import/` — Mon–Sun combined `week-of-YYYY-MM-DD.csv` files
  ready for Metricool's CSV batch import.

See `docs/social-content-pipeline.md` for the full pipeline documentation.
