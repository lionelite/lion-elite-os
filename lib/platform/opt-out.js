'use strict';

const OPT_OUT_PATTERNS=[
  /\bunsubscribe\b/i,
  /\bstop\b/i,
  /\bremove me\b/i,
  /\bdo not contact\b/i,
  /\bdon't contact\b/i,
  /\btake me off\b/i,
  /\bopt out\b/i,
  /\bno more (?:emails|messages|texts)\b/i
];

function detectOptOut(text=''){
  const value=String(text||'').trim();
  const matched=OPT_OUT_PATTERNS.find(re=>re.test(value));
  return {optOut:Boolean(matched),matched:matched?matched.source:null};
}

module.exports={detectOptOut,OPT_OUT_PATTERNS};
