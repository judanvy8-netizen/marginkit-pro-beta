'use strict';
window.ORVANTRO_ANALYTICS = { site: 'marginkit-pro-beta' };
document.addEventListener('submit', event => {
  if (event.target.id !== 'feedback-form') return;
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  const fd = new FormData(form);
  const product = String(fd.get('product') || 'MarginKit').slice(0, 80);
  const rating = String(fd.get('rating') || '').slice(0, 80);
  const email = String(fd.get('email') || '').slice(0, 254);
  const body = String(fd.get('body') || '').slice(0, 4000);
  const subject = encodeURIComponent('[ORVANTRO 베타 피드백] ' + product + ' / ' + rating);
  const text = encodeURIComponent('제품: ' + product + '\n만족도: ' + rating + '\n회신 이메일: ' + (email || '(없음)') + '\n\n피드백:\n' + body);
  window.location.href = 'mailto:orvantro@gmail.com?subject=' + subject + '&body=' + text;
});
