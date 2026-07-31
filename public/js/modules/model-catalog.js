/**
 * ModelCatalog — 프론트엔드에서 Claude 모델 목록을 얻는 유일한 창구.
 *
 * 왜 있는가
 * ---------
 * 예전에는 index.html 의 <option>, app.js 의 displayNames 맵,
 * oneoff-toolbar-module 의 models 배열, ralph-loop-module 의 <option> 문자열까지
 * 네 군데에 모델 ID 가 각각 하드코딩돼 있었다. 그래서 백엔드
 * src/config/models.ts 에 Opus 5 를 추가해도
 *
 *   - 드롭다운에는 나타나지 않아 사용자가 고를 수 없었고
 *   - override 없는 프로젝트는 실제로 Opus 5 로 실행되는데 화면에는
 *     "Sonnet 4.6" 이라고 표시되는(=거짓말하는) 상태였다.
 *
 * 이제 목록/표시명/기본값은 전부 GET /api/settings/models 에서 온다.
 * 백엔드 config 가 유일한 출처이고, 이 모듈이 그 사본을 들고 있는다.
 * scripts/validate.mjs 의 "4b. 모델 목록 단일 출처" 단계가 프론트에
 * 모델 ID 리터럴이 다시 들어오는 것을 막는다.
 */
(function(window) {
  'use strict';

  var models = [];
  var defaultModel = null;
  var loaded = false;

  var ModelCatalog = {};

  /** 카탈로그를 API 에서 채운다. 이미 채워져 있으면 그대로 둔다. */
  ModelCatalog.load = function() {
    if (!window.ApiClient || !window.ApiClient.getAvailableModels) {
      return window.jQuery ? window.jQuery.Deferred().reject().promise() : null;
    }

    return window.ApiClient.getAvailableModels().done(function(data) {
      ModelCatalog.setModels((data && data.models) || []);
    });
  };

  /**
   * 프로젝트 모델 API 응답(availableModels/defaultModel)으로도 채울 수 있다.
   * 두 엔드포인트 중 먼저 도착한 쪽이 카탈로그를 세운다.
   */
  ModelCatalog.setModels = function(list) {
    if (!list || !list.length) return;

    models = list.map(function(m) {
      return { id: m.id, displayName: m.displayName || m.name || m.id };
    });
    loaded = true;
  };

  ModelCatalog.setDefault = function(modelId) {
    if (modelId) defaultModel = modelId;
  };

  ModelCatalog.isLoaded = function() {
    return loaded;
  };

  ModelCatalog.getModels = function() {
    return models.slice();
  };

  ModelCatalog.getDefault = function() {
    return defaultModel || (models[0] ? models[0].id : '');
  };

  ModelCatalog.has = function(modelId) {
    for (var i = 0; i < models.length; i++) {
      if (models[i].id === modelId) return true;
    }
    return false;
  };

  ModelCatalog.getDisplayName = function(modelId) {
    if (!modelId) return '';

    for (var i = 0; i < models.length; i++) {
      if (models[i].id === modelId) return models[i].displayName;
    }

    // 카탈로그에 없으면 ID 를 그대로 보여준다. 임의로 예쁘게 만들면
    // "지원 목록에 없는 모델이 설정돼 있다"는 사실이 가려진다.
    return modelId;
  };

  /**
   * 설정에 남아 있는 옛 모델 ID 를 걸러 현재 유효한 값으로 바꾼다.
   * 목록에 없는 값을 <select> 에 넣으면 브라우저가 빈 값으로 만들어 버려서,
   * 사용자는 "아무것도 안 골라진" 드롭다운을 보게 된다.
   */
  ModelCatalog.resolve = function(modelId) {
    return ModelCatalog.has(modelId) ? modelId : ModelCatalog.getDefault();
  };

  /** <option> 문자열을 만든다 (HTML 을 문자열로 조립하는 모듈용). */
  ModelCatalog.buildOptionsHtml = function(selectedId, optionClass) {
    var cls = optionClass ? ' class="' + optionClass + '"' : '';
    var html = '';

    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var selected = m.id === selectedId ? ' selected' : '';
      var label = window.EscapeUtils && window.EscapeUtils.escapeHtml
        ? window.EscapeUtils.escapeHtml(m.displayName)
        : m.displayName;

      html += '<option value="' + m.id + '"' + cls + selected + '>' + label + '</option>';
    }

    return html;
  };

  /** 기존 <select> 엘리먼트를 카탈로그로 다시 채운다. 선택값은 유지한다. */
  ModelCatalog.populateSelect = function($select) {
    if (!$select || !$select.length || !models.length) return;

    var keep = $select.val();
    $select.empty();

    for (var i = 0; i < models.length; i++) {
      $select.append(
        window.jQuery('<option>').attr('value', models[i].id).text(models[i].displayName)
      );
    }

    if (keep && ModelCatalog.has(keep)) {
      $select.val(keep);
    }
  };

  window.ModelCatalog = ModelCatalog;
})(window);
