'use strict';

const { GmailAdapter } = require('./gmail');
const { GoogleCalendarAdapter } = require('./calendar');
const { CalendlyAdapter } = require('./calendly');

function createIntegrationAdapters(env = process.env) {
  return {
    gmail: new GmailAdapter({ accessToken: env.GTM_GMAIL_ACCESS_TOKEN }),
    googleCalendar: new GoogleCalendarAdapter({
      accessToken: env.GTM_GOOGLE_CALENDAR_ACCESS_TOKEN,
      calendarId: env.GTM_GOOGLE_CALENDAR_ID || 'primary'
    }),
    calendly: new CalendlyAdapter({ accessToken: env.GTM_CALENDLY_ACCESS_TOKEN })
  };
}

function integrationReadiness(env = process.env) {
  return {
    gmail: Boolean(env.GTM_GMAIL_ACCESS_TOKEN),
    googleCalendar: Boolean(env.GTM_GOOGLE_CALENDAR_ACCESS_TOKEN),
    calendly: Boolean(env.GTM_CALENDLY_ACCESS_TOKEN)
  };
}

module.exports = { createIntegrationAdapters, integrationReadiness };
