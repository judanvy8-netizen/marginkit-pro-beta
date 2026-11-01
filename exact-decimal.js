/* Exact finite base-10 arithmetic for core monetary totals. No settlement rounding. */
(function (root) {
  'use strict';
  const MAX_LITERAL = 10000;
  const MAX_INTERNAL = 40000;
  if (typeof BigInt !== 'function') return;
  function parts(value) {
    let text = String(value);
    if (text.length > MAX_INTERNAL) throw new Error('Decimal literal exceeds resource limit');
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Non-finite decimal');
      const match = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
      if (match) {
        const digits = match[2] + (match[3] || '');
        const point = match[2].length + Number(match[4]);
        text = match[1] + (point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point));
      }
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error('Invalid decimal');
    const negative = text.startsWith('-');
    const unsigned = text.replace(/^[+-]/, '');
    const [integer, fraction = ''] = unsigned.split('.');
    return { coefficient: BigInt((negative ? '-' : '') + ((integer || '0') + fraction)), scale: fraction.length };
  }
  function text(coefficient, scale) {
    if (coefficient === 0n) return '0';
    const negative = coefficient < 0n;
    let digits = (negative ? -coefficient : coefficient).toString();
    if (scale) {
      digits = digits.padStart(scale + 1, '0');
      digits = digits.slice(0, -scale) + '.' + digits.slice(-scale);
      // Linear suffix scan: an unanchored /0+$/ can rescan long zero runs.
      let end = digits.length;
      while (digits[end - 1] === '0') end--;
      if (digits[end - 1] === '.') end--;
      digits = digits.slice(0, end);
    }
    return (negative ? '-' : '') + digits;
  }
  const normalize = value => { const p = parts(value); return text(p.coefficient, p.scale); };
  function add(a,b) {
    a=parts(a);b=parts(b);const scale=Math.max(a.scale,b.scale);
    return text(a.coefficient*10n**BigInt(scale-a.scale)+b.coefficient*10n**BigInt(scale-b.scale),scale);
  }
  const negate = value => { const p=parts(value);return text(-p.coefficient,p.scale); };
  const sub = (a,b) => add(a,negate(b));
  const mul = (a,b) => { a=parts(a);b=parts(b);return text(a.coefficient*b.coefficient,a.scale+b.scale); };
  const compare = (a,b) => {const p=parts(sub(a,b));return p.coefficient<0n?-1:p.coefficient>0n?1:0;};
  const abs = value => compare(value,'0')<0?negate(value):normalize(value);
  function input(value) {
    if (value===null || value===undefined || value==='') return null;
    try {
      let result;
      if (typeof value==='number') result=normalize(value);
      else {
        let raw=String(value).trim();if(raw.length>MAX_LITERAL)return null;
        const accounting=/^\(.*\)$/.test(raw);if(accounting)raw=raw.slice(1,-1);
        raw=raw.replace(/[₩원$%\s]/g,'');
        if(raw.includes(',')&&!/^[+-]?\d{1,3}(,\d{3})*(\.\d+)?$/.test(raw))return null;
        result=normalize(raw.replace(/,/g,''));if(accounting)result=negate(abs(result));
      }
      return compare(abs(result),'1000000000000')<=0?result:null;
    } catch { return null; }
  }
  function format(value) {
    const normalized=normalize(value);const [integer,fraction]=normalized.split('.');
    return integer.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');
  }
  // Approximate percentage for display only: truncate at 12 fractional digits.
  // Never use this ratio to derive money or settlement amounts.
  function percentage(numerator,denominator) {
    const n=parts(numerator),d=parts(denominator);if(!d.coefficient)return null;
    const scaled=n.coefficient*100n*10n**BigInt(d.scale+12)/(d.coefficient*10n**BigInt(n.scale));
    const result=Number(text(scaled,12));
    return Number.isFinite(result)?result:null;
  }
  const api=Object.freeze({normalize,add,sub,mul,compare,abs,input,format,percentage});
  root.MKDecimal=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
