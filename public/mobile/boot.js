// ─────────────────────────────────────────────────────────────
// APK 启动钩子：把 /api/* 请求就地接管，其余照常走网络。
// 只在容器里启用（Java 侧注入 window.__ANIHUB_APP__），
// 电脑上调试可以加 ?app=1 强制开启（需要 server.mjs 的 /p 代理）。
// ─────────────────────────────────────────────────────────────
(function () {
  var force = /[?&]app=1\b/.test(location.search);
  if (!window.__ANIHUB_APP__ && !force) return;

  var corePromise = null;
  function core() {
    if (!corePromise) corePromise = import('./core.js');
    return corePromise;
  }

  var orig = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var href = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    if (href.indexOf('/api/') === 0) {
      return core().then(function (m) {
        return m.handleApi(href);
      });
    }
    return orig(input, init);
  };

  // 让播放器知道图片/视频地址已经指向本地代理
  window.__ANIHUB_LOCAL__ = true;
})();
