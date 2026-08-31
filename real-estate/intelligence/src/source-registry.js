'use strict';

/**
 * Source registry for Lion Elite Real Estate Intelligence.
 *
 * This file is intentionally configuration-first. It tells ingestion workers
 * which systems are authoritative, which joins to prefer, and what not to
 * automate without a licensed API or explicit permission.
 */

const SOURCES = Object.freeze({
  cleveland: {
    market: 'Cleveland / Cuyahoga County, Ohio',
    parcelKey: 'parcel_number',
    sources: [
      {
        id: 'cleveland_accela',
        role: 'municipal_distress',
        authority: 'official',
        url: 'https://aca-prod.accela.com/COC/Default.aspx',
        signals: ['code_violation', 'condemnation', 'vacant_registration', 'rental_registration'],
        automation: 'permitted_integration_only',
        notes: 'Search by property address or parcel number. Do not bypass access controls.'
      },
      {
        id: 'cuyahoga_myplace',
        role: 'parcel_owner_tax',
        authority: 'official',
        url: 'https://myplace.cuyahogacounty.gov/MainPage',
        signals: ['current_owner', 'mailing_address', 'transfer_history', 'tax_history', 'property_characteristics'],
        automation: 'csv_or_permitted_access',
        notes: 'Use as the primary parcel/ownership join. County states transfer ownership is updated daily.'
      },
      {
        id: 'cuyahoga_foreclosure',
        role: 'foreclosure',
        authority: 'official',
        url: 'https://cpdocket.cp.cuyahogacounty.gov/sheriffsearch/search.aspx/search.aspx',
        signals: ['foreclosure_case', 'sheriff_sale'],
        automation: 'permitted_access',
        notes: 'Later-stage distress; seek earlier court/public filing feeds when available.'
      },
      {
        id: 'cuyahoga_delinquent_tax',
        role: 'tax_distress',
        authority: 'official',
        url: 'https://cuyahogacounty.gov/fiscal-officer/departments/real-property/delinquent-publication',
        signals: ['delinquent_property_tax'],
        automation: 'publication_import',
        notes: 'Tax delinquency is a distress signal, not proof of seller motivation.'
      }
    ]
  },
  miami: {
    market: 'Miami-Dade County, Florida',
    parcelKey: 'folio',
    sources: [
      {
        id: 'miamidade_property_appraiser',
        role: 'parcel_owner_value',
        authority: 'official',
        url: 'https://apps.miamidadepa.gov/PropertySearch/',
        signals: ['current_owner', 'mailing_address', 'sales_history', 'assessed_value', 'property_characteristics'],
        automation: 'permitted_access',
        notes: 'Use 13-digit folio as canonical county join key.'
      },
      {
        id: 'miamidade_regulation_cases',
        role: 'municipal_distress',
        authority: 'official',
        url: 'https://www.miamidade.gov/Apps/RER/RegulationSupportWebViewer/',
        signals: ['unsafe_structure', 'work_without_permit', 'expired_permit', 'code_case'],
        automation: 'reports_or_permitted_access',
        notes: 'Coverage is Miami-Dade regulatory jurisdiction; municipalities may have separate systems.'
      },
      {
        id: 'miamidade_code_citations',
        role: 'municipal_distress',
        authority: 'official',
        url: 'https://www.miamidade.gov/apps/finance/codeenfwebcitations/Cefsearch.aspx',
        signals: ['open_code_citation'],
        automation: 'permitted_access'
      },
      {
        id: 'miamidade_clerk_api',
        role: 'preforeclosure',
        authority: 'official_paid_api',
        url: 'https://www2.miamidadeclerk.gov/Developers/Help',
        signals: ['lis_pendens', 'civil_foreclosure_case', 'case_docket'],
        automation: 'licensed_api_only',
        notes: 'Preferred automation path. Do not bulk scrape/store public Official Records pages contrary to their terms.'
      },
      {
        id: 'miamidade_tax_collector',
        role: 'tax_distress',
        authority: 'official',
        url: 'https://www.miamidade.gov/taxcollector/',
        signals: ['delinquent_property_tax', 'tax_certificate_sale'],
        automation: 'publication_or_permitted_access'
      },
      {
        id: 'miamidade_parcel_gis',
        role: 'geospatial',
        authority: 'official_open_data',
        url: 'https://arcgis.gdsc.miami.edu/arcgis/rest/services/mdc_parcels/FeatureServer',
        signals: ['parcel_geometry'],
        automation: 'arcgis_query',
        notes: 'Use for geometry/spatial joins; verify current ownership/value against Property Appraiser.'
      }
    ]
  },
  licensed: {
    attom: {
      role: 'normalized_property_foreclosure',
      url: 'https://api.developer.attomdata.com/docs',
      signals: ['owner', 'mortgage', 'avm', 'foreclosure', 'preforeclosure', 'property_detail'],
      use: 'Speed and normalization layer; verify critical legal/status facts against official source.'
    },
    batchdata: {
      role: 'contact_enrichment',
      url: 'https://developer.batchdata.com/',
      signals: ['phone', 'email', 'alternate_address', 'owner_contact'],
      use: 'Enrich only high-scoring leads; retain source/confidence/timestamp and suppression status.'
    }
  }
});

const DISTRESS_WEIGHTS = Object.freeze({
  new_lis_pendens: 30,
  active_foreclosure: 20,
  condemned_or_unsafe: 25,
  registered_vacant: 20,
  multiple_open_code_violations: 15,
  delinquent_property_tax: 15,
  municipal_lien: 10,
  absentee_owner: 10,
  owner_held_10_plus_years: 8,
  high_estimated_equity: 15,
  out_of_state_owner: 5
});

function getMarketSources(market) {
  if (!SOURCES[market]) throw new Error(`Unsupported market: ${market}`);
  return SOURCES[market];
}

module.exports = { SOURCES, DISTRESS_WEIGHTS, getMarketSources };
