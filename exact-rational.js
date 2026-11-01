/* Bounded exact ratios for VAT decomposition. No statutory settlement rounding. */
(function (root) {
  'use strict';
  const D = root.MKDecimal || (typeof module === 'object' && module.exports ? require('./exact-decimal.js') : null);
  if (!D || typeof BigInt !== 'function') return;
  function gcd(a,b) { a=a<0n?-a:a;b=b<0n?-b:b;while(b){const r=a%b;a=b;b=r;}return a||1n; }
  function ratio(n,d=1n) {
    if(typeof n!=='bigint'||typeof d!=='bigint'||d===0n)throw new RangeError('Invalid exact ratio');
    if(n.toString().length>40000||d.toString().length>40000)throw new RangeError('Ratio resource limit');
    if(d<0n){n=-n;d=-d;}const common=gcd(n,d);return {n:n/common,d:d/common};
  }
  function decimal(value) {
    const text=D.normalize(value),negative=text.startsWith('-');
    const [whole,fraction='']=text.replace(/^-/, '').split('.');
    if(fraction.length>20000)throw new RangeError('Ratio resource limit');
    return ratio(BigInt((negative?'-':'')+whole+fraction),10n**BigInt(fraction.length));
  }
  const add=(a,b)=>ratio(a.n*b.d+b.n*a.d,a.d*b.d);
  const sub=(a,b)=>ratio(a.n*b.d-b.n*a.d,a.d*b.d);
  const divide=(a,b)=>ratio(a.n*b.d,a.d*b.n);
  const multiply=(a,b)=>ratio(a.n*b.n,a.d*b.d);
  function finite(value) {
    let d=value.d,two=0,five=0;
    // VAT repeating ratios contain factor 11: reject finite rendering immediately.
    if(d%11n===0n)return null;
    const binary=d.toString(2);
    for(let i=binary.length-1;i>=0&&binary[i]==='0';i--)two++;
    if(two>20000)throw new RangeError('Ratio resource limit');
    d >>= BigInt(two);
    let low=0,high=Math.min(20001,Math.ceil(d.toString(2).length/Math.log2(5))+1);
    while(low<high){const middle=Math.ceil((low+high)/2);if(d%(5n**BigInt(middle))===0n)low=middle;else high=middle-1;}
    five=low;if(five>20000)throw new RangeError('Ratio resource limit');d/=5n**BigInt(five);
    if(d!==1n)return null;
    const scale=Math.max(two,five);if(scale>20000)throw new RangeError('Ratio resource limit');
    const coefficient=value.n*2n**BigInt(scale-two)*5n**BigInt(scale-five);
    const sign=coefficient<0n?'-':'';const digits=(coefficient<0n?-coefficient:coefficient).toString().padStart(scale+1,'0');
    return D.normalize(sign+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits));
  }
  function preview(value,places=12) {
    if(!Number.isInteger(places)||places<0||places>100)throw new RangeError('Preview precision');
    const exact=finite(value);if(exact!==null)return {text:exact,approximate:false};
    // Display-only truncation; exact fraction survives in the result and exports.
    const scaled=value.n*10n**BigInt(places)/value.d;
    const sign=scaled<0n?'-':'';const digits=(scaled<0n?-scaled:scaled).toString().padStart(places+1,'0');
    return {text:D.normalize(sign+(places?digits.slice(0,-places)+'.'+digits.slice(-places):digits)),approximate:true};
  }
  const fraction=value=>value.d===1n?value.n.toString():value.n.toString()+'/'+value.d.toString();
  const api=Object.freeze({ratio,decimal,add,sub,divide,multiply,finite,preview,fraction});
  root.MKRational=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
