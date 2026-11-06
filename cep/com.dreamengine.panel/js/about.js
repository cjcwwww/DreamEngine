/* DreamEngine about dialog. ES5 for AE 2021's CEF. */
var AEV_About = (function () {
  function byId(id) {
    return document.getElementById(id);
  }

  function currentLang() {
    return document.documentElement.getAttribute("lang") === "en" ? "en" : "zh";
  }

  function label(key, fallback) {
    return typeof AEV_t === "function" ? AEV_t(key, currentLang()) : fallback;
  }

  function openExternal(url) {
    if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
      window.cep.util.openURLInDefaultBrowser(url);
      return;
    }
    if (window.Bridge && window.Bridge.evalAE) {
      window.Bridge.evalAE(
        "(function(){try{var f=new File(" + JSON.stringify(url) + ");" +
        "return f.execute()?'OK':'FAIL';}catch(e){return 'ERR:'+e.toString();}})()"
      );
      return;
    }
    window.open(url, "_blank");
  }

  function copyText(text) {
    var field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("data-about-copy", "true");
    field.setAttribute("readonly", "readonly");
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.appendChild(field);
    field.select();
    var copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(field);
    return copied;
  }

  function showCopyResult(copied) {
    var output = byId("aboutCopyQqLabel");
    if (!output) return;
    output.textContent = copied ? label("about.copied", "已复制") : label("about.copyFailed", "复制失败");
    window.setTimeout(function () {
      output.textContent = label("about.copy", "复制");
    }, 1400);
  }

  function setOpen(open) {
    var dialog = byId("aboutDialog");
    var trigger = byId("brandMark");
    if (!dialog || !trigger) return;
    dialog.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      byId("aboutClose").focus();
    } else {
      trigger.focus();
    }
  }

  function trapFocus(event) {
    var dialog = byId("aboutDialog");
    if (!dialog || dialog.hidden || event.key !== "Tab") return;
    var items = dialog.querySelectorAll("button:not([disabled])");
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function init() {
    var trigger = byId("brandMark");
    var dialog = byId("aboutDialog");
    if (!trigger || !dialog) return;

    trigger.addEventListener("click", function () {
      setOpen(dialog.hidden);
    });
    byId("aboutClose").addEventListener("click", function () {
      setOpen(false);
    });
    dialog.addEventListener("mousedown", function (event) {
      if (event.target === dialog) setOpen(false);
    });

    var links = [byId("aboutDouyin"), byId("aboutGithub")];
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener("click", function () {
        openExternal(this.getAttribute("data-url"));
      });
    }

    byId("aboutCopyQq").addEventListener("click", function () {
      showCopyResult(copyText(byId("aboutQqNumber").textContent.trim()));
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" || event.keyCode === 27) {
        if (!dialog.hidden) {
          event.stopPropagation();
          setOpen(false);
        }
      } else {
        trapFocus(event);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { open: function () { setOpen(true); }, close: function () { setOpen(false); } };
})();
