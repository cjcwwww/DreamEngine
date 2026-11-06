/* DreamEngine Hub about dialog. */
(() => {
  const byId = (id) => document.getElementById(id);

  function openExternal(url) {
    if (window.hub?.openExternal) {
      window.hub.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  function copyText(text) {
    if (window.hub?.copyText) return window.hub.copyText(text);
    return false;
  }

  function showCopyResult(copied) {
    const output = byId("aboutCopyQqLabel");
    if (!output) return;
    output.textContent = copied ? "已复制" : "复制失败";
    window.setTimeout(() => {
      output.textContent = "复制";
    }, 1400);
  }

  function setOpen(open) {
    const dialog = byId("aboutDialog");
    const trigger = byId("brandMark");
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
    const dialog = byId("aboutDialog");
    if (!dialog || dialog.hidden || event.key !== "Tab") return;
    const items = dialog.querySelectorAll("button:not([disabled])");
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function init() {
    const trigger = byId("brandMark");
    const dialog = byId("aboutDialog");
    if (!trigger || !dialog) return;

    trigger.addEventListener("click", () => setOpen(dialog.hidden));
    byId("aboutClose").addEventListener("click", () => setOpen(false));
    dialog.addEventListener("mousedown", (event) => {
      if (event.target === dialog) setOpen(false);
    });

    for (const id of ["aboutDouyin", "aboutGithub"]) {
      byId(id).addEventListener("click", (event) => {
        openExternal(event.currentTarget.dataset.url);
      });
    }

    byId("aboutCopyQq").addEventListener("click", async () => {
      const copied = await copyText(byId("aboutQqNumber").textContent.trim());
      showCopyResult(Boolean(copied));
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !dialog.hidden) {
        event.stopPropagation();
        setOpen(false);
      } else {
        trapFocus(event);
      }
    });

    const version = byId("extVersion").textContent.trim();
    if (version) byId("aboutVersion").textContent = version;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.AEV_About = {
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
})();
