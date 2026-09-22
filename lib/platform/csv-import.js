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
    if(!mapped.email&&!mapped.linkedinUrl&&!mapped.phone){rejected.push({index,row:mapped,reason:'no_reachable_contact'});continue}
    accepted.push({...mapped,sourceProvider:'csv',fitGateSkipped:skipFitGate});
  }
  return {rowCount:rows.length,accepted,rejected,skipFitGate};
}

module.exports={mapRow,importRows};
