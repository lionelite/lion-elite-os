'use strict';

const MCP_TOOLS=Object.freeze([
  {name:'workspace.get',scope:'workspace:read',level:'viewer',spends:false},
  {name:'campaign.list',scope:'campaign:read',level:'viewer',spends:false},
  {name:'prospect.search',scope:'prospect:read',level:'viewer',spends:false},
  {name:'prospect.reveal',scope:'prospect:write',level:'operator',spends:true},
  {name:'prospect.suppress',scope:'prospect:write',level:'operator',spends:false},
  {name:'conversation.list',scope:'conversation:read',level:'viewer',spends:false},
  {name:'meeting.announce',scope:'meeting:write',level:'operator',spends:true},
  {name:'agent.list',scope:'agent:read',level:'viewer',spends:false},
  {name:'agent.pause',scope:'agent:write',level:'operator',spends:false},
  {name:'signal.list',scope:'signal:read',level:'viewer',spends:false},
  {name:'integration.list',scope:'integration:read',level:'viewer',spends:false},
  {name:'usage.get',scope:'usage:read',level:'viewer',spends:false},
  {name:'audit.list',scope:'audit:read',level:'admin',spends:false},
  {name:'company.get',scope:'workspace:read',level:'viewer',spends:false},
  {name:'campaign.plan',scope:'campaign:write',level:'operator',spends:true}
]);

function allowedTools(scopes=[]){const set=new Set(scopes);return MCP_TOOLS.filter(t=>set.has(t.scope))}
function assertNoSendTools(){return MCP_TOOLS.every(t=>!/(send|message\.send|outbound\.send)/i.test(t.name))}
module.exports={MCP_TOOLS,allowedTools,assertNoSendTools};
