'use strict';

function mapRow(row={},mapping={}){
  const out={};
  for(const [target,source] of Object.entries(mapping||{})) out[target]=row[source]??'';
  return out;
}

function importRows(rows=[],mapping={},options={}){
  const skipFitGate=options.skipFitGate!==false;
  const accepted=[],rejected=[];
  for(const [index,row] of rows.entries()){
    const mapped=mapRow(row,mapping);
    // A LinkedIn URL is not a reachable contact. It counted as one here, so a
    // purchased file of profile links imported clean and every row looked
    // actionable — while the only way to act on it would be an automated
    // connection request or DM, which the LinkedIn User Agreement prohibits and
    // which is not ours to authorize. The URL is still carried as an identifier
    // (see lib/contacts/provider-ingest.js); it just cannot be the reason a row
    // is admitted.
    if(!mapped.email&&!mapped.phone){rejected.push({index,row:mapped,reason:'no_reachable_contact'});continue}
    accepted.push({...mapped,sourceProvider:'csv',fitGateSkipped:skipFitGate});
  }
  return {rowCount:rows.length,accepted,rejected,skipFitGate};
}

module.exports={mapRow,importRows};
