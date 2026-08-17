'use strict';

function createPushService(store) {
  const publicKey = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim();
  const subject = String(process.env.WEB_PUSH_SUBJECT || 'mailto:info@lionelitebeauty.com').trim();
  let webPush = null;

  if (publicKey && privateKey) {
    try {
      webPush = require('web-push');
      webPush.setVapidDetails(subject, publicKey, privateKey);
    } catch (error) {
      console.error('[coaching-push] web-push could not be initialized:', error.message);
    }
  }

  async function notifyMessage({ senderType, clientId }) {
    if (!webPush) return { configured: false, sent: 0 };
    const recipientType = senderType === 'coach' ? 'client' : 'coach';
    const recipientClientId = recipientType === 'client' ? clientId : null;
    const subscriptions = await store.listPushSubscriptions(recipientType, recipientClientId);
    const payload = JSON.stringify({
      title: senderType === 'coach' ? 'Message from your Lion Elite coach' : 'New client message',
      body: 'Open Lion Elite Coaching to read and respond.',
      url: '/coaching/#messages',
      tag: `coaching-message-${clientId}`
    });
    let sent = 0;
    await Promise.all(subscriptions.map(async subscription => {
      try {
        await webPush.sendNotification(subscription, payload, { TTL: 60 * 60, urgency: 'high' });
        sent += 1;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await store.removePushSubscription(subscription.endpoint);
          return;
        }
        console.error('[coaching-push] notification failed:', error.statusCode || error.message);
      }
    }));
    return { configured: true, sent };
  }

  return {
    configured: Boolean(webPush),
    publicKey: webPush ? publicKey : '',
    notifyMessage
  };
}

module.exports = { createPushService };
