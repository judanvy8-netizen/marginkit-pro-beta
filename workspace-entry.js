(function () {
  'use strict';
  function boot() {
    var url, panel = document.querySelector('.premium-future');
    if (!panel || !window.ORVANTRO_WORKSPACE_URL) return;
    try {
      url = new URL(window.ORVANTRO_WORKSPACE_URL);
      if (url.protocol !== 'https:' || !['/workspace', '/workspace/'].includes(url.pathname) || url.username || url.password || url.search || url.hash) return;
    } catch (_) { return; }
    var heading = panel.querySelector('h2'), note = panel.querySelector('p');
    if (heading) heading.textContent = '팀 작업공간';
    if (note) note.textContent = '로그인 후 팀 권한과 시나리오 저장·비교를 사용할 수 있습니다 이 브라우저의 정산 파일과 저장 기록은 자동 전송되지 않습니다 채널 API 자동 수집과 예약 이메일은 준비 중입니다';
    var notes = panel.querySelectorAll('p');
    if (notes[1]) notes[1].textContent = '현재 도구는 무료 베타이며 결제·구독은 없습니다 기기 내 Premium 기록은 JSON으로 백업할 수 있으며 팀 작업공간에 저장한 시나리오는 로그인한 계정으로 불러올 수 있습니다';
    var link = document.createElement('a');
    link.className = 'suite-premium-entry';
    link.href = url.href;
    link.rel = 'noreferrer';
    link.textContent = '팀 작업공간 열기 ↗';
    panel.appendChild(link);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
