/*
 * Moon — page-context hook (runs inside tiktok.com's own JS world).
 *
 * When you add music / edit in TikTok's studio and hit Post, TikTok's frontend
 * builds a publish request and serializes it with JSON.stringify. If that
 * request asks for a server-side "cloud edit" (post_type 2 + vedit/canvas
 * flags), TikTok RE-RENDERS your video server-side — and that re-render is the
 * recompression that wrecks your quality.
 *
 * While Moon is ON, we intercept that request and neutralize those flags so
 * TikTok publishes your uploaded bytes AS-IS (a plain direct post), attaching
 * the sound as a playback overlay instead of baking it in. No re-encode.
 *
 * This only touches the publish request object — never your video file, and
 * only on the upload / studio pages.
 */
(function () {
  'use strict';
  if (window.__moonInjected) return;
  window.__moonInjected = true;
  window.__moonActive = false;

  // The content script flips this via a window event.
  window.addEventListener('moon-set-active', function (e) {
    window.__moonActive = !!(e && e.detail && e.detail.active);
  });

  function onPublishPage() {
    var h = location.href;
    return (
      h.indexOf('/upload') !== -1 ||
      h.indexOf('/creator-center') !== -1 ||
      h.indexOf('/tiktokstudio') !== -1
    );
  }

  // Strip the "re-render this server-side" instructions from a publish payload.
  function neutralize(node) {
    if (!node || typeof node !== 'object') return;
    if ('draft' in node) delete node.draft;
    if ('canvas_config' in node) delete node.canvas_config;
    if ('vedit_segment_info' in node) delete node.vedit_segment_info;
    if (node.cloud_edit_is_use_video_canvas !== undefined && node.cloud_edit_is_use_video_canvas !== false) {
      node.cloud_edit_is_use_video_canvas = false;
    }
    if (node.post_type === 2) node.post_type = 3; // 2 = cloud-edited (re-render) -> 3 = direct post
    for (var k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k) && node[k] && typeof node[k] === 'object') {
        neutralize(node[k]);
      }
    }
  }

  var originalStringify = JSON.stringify;
  JSON.stringify = function (value) {
    try {
      if (
        window.__moonActive &&
        onPublishPage() &&
        value &&
        typeof value === 'object' &&
        (value.single_post_req_list || value.vedit_common_info || value.post_common_info)
      ) {
        neutralize(value);
      }
    } catch (err) {
      /* never break TikTok's own serialization */
    }
    return originalStringify.apply(this, arguments);
  };
})();