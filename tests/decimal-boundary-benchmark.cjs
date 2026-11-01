// Diagnostic benchmark, not a timing-sensitive CI assertion.
const {performance}=require('node:perf_hooks');
const D=require('../exact-decimal');
const tiny='0.'+'0'.repeat(9997)+'1';
for(const [name,fn] of [['input',()=>D.input(tiny)],['multiply',()=>D.mul(tiny,'0.5')],['percentage',()=>D.percentage(tiny,'1')]]){
 const start=performance.now();for(let i=0;i<3;i++)fn();console.log(`${name}: ${((performance.now()-start)/3).toFixed(3)} ms/call (3 calls, 10000-character literal)`);
}
