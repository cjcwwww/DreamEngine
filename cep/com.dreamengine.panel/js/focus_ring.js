/* ============================================================
 * 焦点环
 *
 * CEP 的 CEF 不支持 :focus-visible：鼠标点完按钮后，浏览器会给
 * 按钮留一个系统白框。这里按输入方式切换 html.keyboard-nav：
 * 鼠标操作去掉白框，Tab 键盘导航时再显示强调色焦点环。
 * ============================================================ */

(function () {
  var root = document.documentElement;

  document.addEventListener("keydown", function (event) {
    if (event.key === "Tab") root.classList.add("keyboard-nav");
  }, true);

  document.addEventListener("pointerdown", function () {
    root.classList.remove("keyboard-nav");
  }, true);
})();
