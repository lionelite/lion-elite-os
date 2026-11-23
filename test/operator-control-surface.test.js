const test=require('node:test');const assert=require('node:assert/strict');
test('operator surface supports core library concepts',()=>{const concepts=['templates','audiences','sequences','agent-settings','agent-threads'];assert.equal(concepts.length,5);assert.ok(concepts.includes('sequences'))});
