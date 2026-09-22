'use strict';

class ApolloProvider {
  constructor({ apiKey, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.name = 'apollo';
  }

  assertConfigured() {
    if (!this.apiKey) {
      const error = new Error('Apollo API key is not configured');
      error.code = 'APOLLO_NOT_CONFIGURED';
      throw error;
    }
  }

  async api(path, body) {
    this.assertConfigured();
    const response = await this.fetchImpl('https://api.apollo.io' + path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': this.apiKey
      },
      body: JSON.stringify(body || {})
    });
    if (!response.ok) {
      const error = new Error('Apollo API request failed');
      error.status = response.status;
      error.detail = await response.text();
      throw error;
    }
    return response.json();
  }

  async search({ icp = {}, page = 1, perPage = 25 } = {}) {
    const body = { page, per_page: perPage };
    if (Array.isArray(icp.titles) && icp.titles.length) body.person_titles = icp.titles;
    if (Array.isArray(icp.seniorities) && icp.seniorities.length) body.person_seniorities = icp.seniorities;
    if (icp.geography) body.organization_locations = [icp.geography];
    if (Array.isArray(icp.domains) && icp.domains.length) body.q_organization_domains_list = icp.domains;
    if (Array.isArray(icp.excludeDomains) && icp.excludeDomains.length) body.organization_not_domains = icp.excludeDomains;
    if (icp.keywords) body.q_keywords = icp.keywords;
    if (icp.emailStatus) body.contact_email_status = Array.isArray(icp.emailStatus) ? icp.emailStatus : [icp.emailStatus];

    const result = await this.api('/api/v1/mixed_people/api_search', body);
    const people = result.people || result.contacts || [];
    return people.map(person => ({
      sourceProvider: 'apollo',
      sourceExternalId: person.id || person.person_id || null,
      contactName: person.name || [person.first_name, person.last_name].filter(Boolean).join(' '),
      title: person.title || '',
      companyName: person.organization?.name || person.organization_name || '',
      companyDomain: person.organization?.primary_domain || person.organization?.website_url || '',
      linkedinUrl: person.linkedin_url || '',
      email: person.email || null,
      city: person.city || '',
      state: person.state || '',
      country: person.country || '',
      raw: person
    }));
  }

  async enrich(person, { revealPhone = false, revealPersonalEmails = false, webhookUrl } = {}) {
    const body = {};
    if (person.sourceExternalId) body.id = person.sourceExternalId;
    if (person.linkedinUrl) body.linkedin_url = person.linkedinUrl;
    if (person.companyDomain) body.domain = String(person.companyDomain).replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];
    if (person.contactName) body.name = person.contactName;
    if (person.email) body.email = person.email;
    if (revealPhone) {
      if (!webhookUrl) throw new Error('webhookUrl is required when revealing phone numbers');
      body.reveal_phone_number = true;
      body.webhook_url = webhookUrl;
    }
    if (revealPersonalEmails) body.reveal_personal_emails = true;

    const result = await this.api('/api/v1/people/match', body);
    return {
      matchConfidence: result.match_confidence || result.person?.match_confidence || null,
      person: result.person || null,
      raw: result
    };
  }
}

module.exports = { ApolloProvider };
