/* ============================================================
 * 卡片 3D 聚焦
 *
 * 指针在效果卡 / 预设卡 / 素材卡上移动时，卡片朝指针方向轻微倾斜；
 * 指针离开后回正。用事件委托绑在 document 上，卡片重建后不用重绑。
 * 触摸屏不做倾斜（避免滚动时卡片乱晃）。
 * ============================================================ */

(function () {
  var CARD_SELECTOR = ".effect-card, .preset-card, .material-card";
  var active = null;
  var frame = 0;

  function reset(card) {
    if (!card) return;
    card.style.removeProperty("--tilt-x");
    card.style.removeProperty("--tilt-y");
  }

  function cardFrom(node) {
    while (node && node !== document) {
      if (node.nodeType === 1 && node.matches && node.matches(CARD_SELECTOR)) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  document.addEventListener("pointermove", function (event) {
    if (event.pointerType === "touch") return;
    var card = cardFrom(event.target);
    if (!card) return;
    if (active && active !== card) reset(active);
    active = card;

    var rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    var px = (event.clientX - rect.left) / rect.width - 0.5;
    var py = (event.clientY - rect.top) / rect.height - 0.5;

    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(function () {
      frame = 0;
      card.style.setProperty("--tilt-x", (-py * 8).toFixed(2) + "deg");
      card.style.setProperty("--tilt-y", (px * 10).toFixed(2) + "deg");
    });
  });

  document.addEventListener("pointerout", function (event) {
    var card = cardFrom(event.target);
    if (!card) return;
    if (card.contains(event.relatedTarget)) return;
    reset(card);
    if (active === card) active = null;
  });

  window.addEventListener("blur", function () {
    reset(active);
    active = null;
  });
})();
