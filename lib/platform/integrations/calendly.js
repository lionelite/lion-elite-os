'use strict';

class CalendlyAdapter {
  constructor({ accessToken, fetchImpl = fetch } = {}) {
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
  }

  assertConfigured() {
    if (!this.accessToken) {
      const error = new Error('Calendly access token is not configured');
      error.code = 'CALENDLY_NOT_CONFIGURED';
      throw error;
    }
  }

  async api(path, options = {}) {
    this.assertConfigured();
    const response = await this.fetchImpl('https://api.calendly.com' + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + this.accessToken,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const error = new Error('Calendly API request failed');
      error.status = response.status;
      error.detail = await response.text();
      throw error;
    }
    return response.json();
  }

  async getCurrentUser() {
    return this.api('/users/me');
  }

  async listEventTypes({ userUri, active = true, count = 50 }) {
    const qs = new URLSearchParams({ user: userUri, active: String(active), count: String(count) });
    return this.api('/event_types?' + qs.toString());
  }
}

module.exports = { CalendlyAdapter };
