'use strict';

const RUNTIME_JOBS=Object.freeze([
  {key:'checkup',cadenceSeconds:900},
  {key:'new_leads',dailyTime:'08:00'},
  {key:'linkedin_search',cadenceSeconds:60},
  {key:'heat_scores',cadenceSeconds:60},
  {key:'queue',cadenceSeconds:60},
  {key:'sender',cadenceSeconds:60},
  {key:'replies',cadenceSeconds:60},
  {key:'grading',cadenceSeconds:3600},
  {key:'rewriting',cadenceSeconds:21600},
  {key:'account_health',cadenceSeconds:21600},
  {key:'cleanup',dailyTime:'03:30'}
]);

function runtimeJobCatalog(){return RUNTIME_JOBS.map(x=>({...x}))}
module.exports={RUNTIME_JOBS,runtimeJobCatalog};
