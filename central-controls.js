(function (w) {
  'use strict';
  var labels = {
    'not-configured': '중앙 집계 서버 연결 전 · 방문 정보 전송 없음',
    'privacy-preference': '브라우저의 추적 거부 설정에 따라 수집하지 않음',
    'needs-consent': '통계 수집 꺼짐 · 허용하면 현재 페이지부터 집계',
    'ready': '통계 수집 허용됨', 'sending': '방문 통계 전송 중',
    'sent': '현재 페이지 조회가 중앙 집계에 반영됨',
    'error': '수집 결과를 확인할 수 없음 · 중복 방지를 위해 자동 재전송하지 않음',
    'storage-unavailable': '브라우저 저장소를 사용할 수 없어 수집하지 않음'
  };
  function boot() {
    var api = w.OrvantroCentral, state = document.getElementById('central-consent-status');
    var allow = document.getElementById('central-allow'), deny = document.getElementById('central-deny');
    if (!api || !state || !allow || !deny) return;
    function render() {
      var current = api.getStatus();
      state.textContent = labels[current.status] || '통계 상태 확인 필요';
      allow.disabled = !current.configured || current.respectsPrivacyPreference || current.consent;
      deny.disabled = !current.consent;
      allow.setAttribute('aria-pressed', String(current.consent));
    }
    allow.addEventListener('click', function () { api.setConsent(true); render(); });
    deny.addEventListener('click', function () { api.setConsent(false); render(); });
    w.addEventListener('orvantro-central-status', render);
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
