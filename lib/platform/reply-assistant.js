'use strict';
const {detectOptOut}=require('./opt-out');

function classifyReply(text='') {
  if(detectOptOut(text).optOut) return 'opt_out';
  const t=String(text).toLowerCase();
  if (/not interested|no thanks|not a fit/.test(t)) return 'not_interested';
  if (/price|cost|how much|pricing/.test(t)) return 'pricing';
  if (/book|calendar|meeting|call|interested|sounds good|tell me more/.test(t)) return 'interested';
  return 'neutral';
}

function draftReply({ classification, contactName='', offerName='', bookingUrl='' }={}) {
  const name=contactName ? ' '+contactName : '';
  if(classification==='opt_out') return 'Understood'+name+'. I will make sure you are not contacted again.';
  if(classification==='not_interested') return 'Thanks for letting me know'+name+'. I appreciate the reply.';
  if(classification==='pricing') return 'Absolutely'+name+'. I can walk you through pricing and what is included. Would you like a quick call, or should I send the details here?';
  if(classification==='interested') return bookingUrl
    ? 'Great'+name+'. Here is the calendar link so you can grab the time that works best for you: '+bookingUrl
    : 'Great'+name+'. Happy to keep this moving. What day or time works best for a quick conversation?';
  return 'Thanks for getting back to me'+name+'. Happy to help. What would be most useful for you to know next?';
}

module.exports={classifyReply,draftReply};
