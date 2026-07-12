# Cross Reference Engine v1

This module verifies and enriches public business records.

## Components
- Discovery Service
- Identity Resolution
- Website Crawler
- Business Profile Extractor
- Confidence Scoring
- Deduplication
- Verification History
- CRM Sync

## Workflow
1. Discover public business records.
2. Normalize names, domains, and addresses.
3. Compare across multiple public business sources.
4. Crawl the official website.
5. Extract business metadata.
6. Calculate confidence score.
7. Save versioned record.
8. Sync to CRM.

## Data Model
- business_name
- website
- business_email
- business_phone
- address
- city
- state
- social_profiles
- services
- ai_summary
- confidence_score
- verification_sources
- last_verified
