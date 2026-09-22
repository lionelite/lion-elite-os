'use strict';

class GoogleCalendarAdapter {
  constructor({ accessToken, calendarId = 'primary', fetchImpl = fetch } = {}) {
    this.accessToken = accessToken;
    this.calendarId = calendarId;
    this.fetchImpl = fetchImpl;
  }

  assertConfigured() {
    if (!this.accessToken) {
      const error = new Error('Google Calendar access token is not configured');
      error.code = 'CALENDAR_NOT_CONFIGURED';
      throw error;
    }
  }

  async api(path, options = {}) {
    this.assertConfigured();
    const response = await this.fetchImpl('https://www.googleapis.com/calendar/v3' + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + this.accessToken,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const error = new Error('Google Calendar API request failed');
      error.status = response.status;
      error.detail = await response.text();
      throw error;
    }
    return response.json();
  }

  async listBusy({ timeMin, timeMax, timeZone = 'UTC' }) {
    const body = { timeMin, timeMax, timeZone, items: [{ id: this.calendarId }] };
    const result = await this.api('/freeBusy', { method: 'POST', body: JSON.stringify(body) });
    return result.calendars?.[this.calendarId]?.busy || [];
  }

  async createMeeting({ summary, description = '', start, end, attendees = [], timeZone = 'UTC' }) {
    const body = {
      summary,
      description,
      start: { dateTime: start, timeZone },
      end: { dateTime: end, timeZone },
      attendees: attendees.map(email => ({ email })),
      conferenceData: { createRequest: { requestId: 'lionos-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
    };
    return this.api('/calendars/' + encodeURIComponent(this.calendarId) + '/events?conferenceDataVersion=1&sendUpdates=all', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }
}

module.exports = { GoogleCalendarAdapter };
