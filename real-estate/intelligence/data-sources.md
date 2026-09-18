# Lion Elite Real Estate Intelligence — Cleveland + Miami Data Sources

Last researched: 2026-07-22

## Objective

Build a lawful, source-attributed distressed-property lead engine for Cleveland/Cuyahoga County and Miami-Dade that prioritizes:

- pre-foreclosure / lis pendens
- vacant properties
- code violations / unsafe structures
- tax delinquency
- absentee ownership
- liens / judgments
- high-equity ownership

Every fact ingested should retain `source_name`, `source_url`, `source_record_id`, `captured_at`, `confidence`, and `verification_status`.

## Cleveland / Cuyahoga County — source of truth

### City of Cleveland Building & Housing — violations + vacancy

Use Cleveland Building & Housing / Accela as the municipal source of truth for active code violations, condemnations, zoning violations, and vacant-building registration. Cleveland states that Accela Citizen Access can be searched by property address or parcel number. Vacant-building registration remains required for vacant structures.

Primary pages:
- https://www.clevelandohio.gov/city-hall/departments/building-housing/divisions/records-administration
- https://www.clevelandohio.gov/residents/codes-ordinances/residents-first/vacant-properties
- https://aca-prod.accela.com/COC/Default.aspx

Lead signals:
- active/open violation
- condemnation
- vacant-building registration
- repeated violations
- rental/non-owner-occupied registration

### Cuyahoga County MyPlace — ownership + parcel + taxes

Use MyPlace for parcel identity, ownership, mailing address, transfer history, values, building details, permits, and tax history. The county states parcel transfer/ownership data is updated daily and supports CSV address downloads.

Primary page:
- https://myplace.cuyahogacounty.gov/MainPage

Lead signals:
- owner mailing address differs from property address
- long hold period
- low assessed/value basis versus estimated market value
- delinquent taxes
- entity/trust ownership

### Cuyahoga County Foreclosure Search / Sheriff Sale

Use the Cuyahoga foreclosure search as a foreclosure-stage source. It supports search by case number, property street, defendant, ZIP, city, parcel, and sale date.

Primary page:
- https://cpdocket.cp.cuyahogacounty.gov/sheriffsearch/search.aspx/search.aspx

Important: sheriff-sale data is later in the distress cycle than initial filing. Prioritize earlier court/public-record signals when available.

### Cuyahoga delinquent-tax publication

The county publishes a delinquent-tax list. Parcels unpaid for one year after delinquency certification may become subject to tax certificate sale, foreclosure, forfeiture, or land-bank assignment.

Primary page:
- https://cuyahogacounty.gov/fiscal-officer/departments/real-property/delinquent-publication

## Miami / Miami-Dade — source of truth

### Miami-Dade Property Appraiser — owner + folio + property characteristics

Use the Property Appraiser as the primary owner/folio/property source. Search supports address, owner name, and folio.

Primary page:
- https://apps.miamidadepa.gov/PropertySearch/

Join key: 13-digit folio number.

Lead signals:
- absentee owner / mailing mismatch
- ownership duration
- assessed and market values
- sales history
- property characteristics

### Miami-Dade Regulation Cases — building violations

The Regulation Cases system exposes enforcement cases in the County regulatory jurisdiction including work without permit, expired permits, unsafe structures, and other building-code violations. It can be searched by address, folio, permit, owner, or violator, and the site exposes reports of active enforcement cases by date.

Primary page:
- https://www.miamidade.gov/Apps/RER/RegulationSupportWebViewer/

Lead signals:
- unsafe structure
- work without permit
- expired permit
- open building-code case
- repeated/open enforcement

### Miami-Dade Code Enforcement Citation Search

Search by citation number, name, folio, or address and filter to open citations.

Primary page:
- https://www.miamidade.gov/apps/finance/codeenfwebcitations/Cefsearch.aspx

### Miami-Dade Clerk — lis pendens / foreclosure

Foreclosure proceedings begin with a civil complaint and recording of a Lis Pendens. This is the preferred public distress trigger before auction.

Primary pages:
- https://www.miamidadeclerk.gov/clerk/mortgage-foreclosures.page
- https://onlineservices.miamidadeclerk.gov/officialrecords

Automation note: the public Official Records website restricts reproduction/storage beyond limited personal/public non-commercial use and points developers to its paid Web API Services. Do not scrape or persist bulk Clerk data without permission/API access.

Official developer API:
- https://www2.miamidadeclerk.gov/Developers/Help

### Miami-Dade delinquent property tax / tax certificate sale

Miami-Dade publishes delinquent real-estate tax notices and conducts tax-certificate sales. Use this as a tax-distress signal, not as proof the owner wants to sell.

Primary source:
- https://www.miamidade.gov/taxcollector/

### Miami-Dade parcel GIS

Miami-Dade Open Data exposes ArcGIS parcel services that support JSON queries. Use this for geospatial joins and parcel boundaries, but prefer the Property Appraiser for current ownership/value verification.

Example service:
- https://arcgis.gdsc.miami.edu/arcgis/rest/services/mdc_parcels/FeatureServer

## Best production data stack

### Tier 1 — official public records (truth layer)

Use official city/county records for the legal/status facts:

- Cleveland Building & Housing / Accela
- Cuyahoga MyPlace
- Cuyahoga foreclosure and delinquent-tax records
- Miami-Dade Property Appraiser
- Miami-Dade Regulation Cases / citation search
- Miami-Dade Clerk API for lis pendens / civil case data
- Miami-Dade Tax Collector

### Tier 2 — licensed property/foreclosure API (speed + normalization)

Recommended first evaluation: **ATTOM**.

Why:
- Property API includes ownership, mortgage, AVM, foreclosure and property detail data.
- ATTOM states foreclosure data includes default notices such as Lis Pendens, auction stages, lender/servicer details and REO.
- Property/recorder/foreclosure feeds are updated on business days.

Docs:
- https://api.developer.attomdata.com/docs
- https://www.attomdata.com/data/foreclosure-data/

Use ATTOM as an acceleration/normalization layer, not as the sole legal source of truth.

### Tier 3 — owner/contact enrichment

Recommended first evaluation: **BatchData**.

Why:
- property, owner, mortgage/lien, tax, permit and foreclosure filters
- contact discovery / skip tracing for phone, email and alternate addresses
- property monitoring notifications

Docs:
- https://developer.batchdata.com/

Only enrich high-scoring leads to control cost. Store source, confidence, timestamp, phone type, and suppression status for every contact point.

## Distress scoring

Suggested acquisition-intelligence points before economics:

- new lis pendens / initial foreclosure filing: +30
- active foreclosure with future sale date: +20
- condemned / unsafe structure: +25
- registered vacant: +20
- multiple open code violations: +15
- delinquent property tax: +15
- code lien / recorded municipal lien: +10
- absentee owner: +10
- owner held 10+ years: +8
- high estimated equity: +15
- out-of-state owner: +5

Do not double-count the same underlying event across multiple data providers.

## Pipeline

1. Collect newly changed public-record events.
2. Normalize address and parcel/folio.
3. Resolve current owner from county source of truth.
4. Join distress events to parcel.
5. Estimate value/equity from licensed data + public records.
6. Calculate motivation and confidence score.
7. Enrich contact data only above score threshold.
8. Run suppression/compliance checks before outreach.
9. Human reviews owner, property, source evidence and outreach draft.
10. Track call/text/mail/email outcome in CRM.
11. Interested sellers move to acquisition underwriting, title review, inspection and contract workflow.

## Data quality rules

- Never treat a mailing mismatch alone as proof of vacancy.
- Never treat a foreclosure filing as proof the current owner still controls title; re-check ownership before outreach.
- Never present AVM/equity estimates as verified facts.
- Always re-check title, liens and seller authority before contract execution.
- Capture the exact source record and timestamp for each distress signal.
- Do not automate around CAPTCHAs, bot controls, terms-of-use restrictions or access controls.

## Outreach safety

Do not open with sensitive framing such as “I saw you are in foreclosure.” Use a neutral purchase inquiry. Keep a do-not-contact/suppression list, honor opt-outs, and route bulk calling/texting campaigns through counsel-reviewed TCPA/telemarketing rules and channel-specific consent requirements.
