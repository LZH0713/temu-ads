(function captureTemuAntiContent() {
  if (window.__temuRoasAntiContentCaptureLoaded) {
    return;
  }
  window.__temuRoasAntiContentCaptureLoaded = true;

  const HEADER_NAME = "anti-content";
  let lastAntiContent = "";

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) {
      return;
    }

    if (event.data?.type === "TEMU_ROAS_REQUEST_ANTI_CONTENT") {
      publish(lastAntiContent);
    }
  });

  function publish(value) {
    const text = String(value || "").trim();
    if (!text) {
      return;
    }

    lastAntiContent = text;
    try {
      sessionStorage.setItem("temuRoasAntiContent", text);
    } catch (_error) {
      // Ignore storage errors; message delivery below is enough for normal pages.
    }

    window.postMessage(
      {
        type: "TEMU_ROAS_ANTI_CONTENT",
        antiContent: text
      },
      location.origin
    );
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function wrappedFetch(input, init) {
      try {
        publish(readHeaderFromFetch(input, init));
      } catch (_error) {
        // Ignore capture errors so the page request behavior stays unchanged.
      }

      return originalFetch.apply(this, arguments);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function wrappedOpen() {
    this.__temuRoasHeaders = {};
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function wrappedSetRequestHeader(
    name,
    value
  ) {
    if (String(name || "").toLowerCase() === HEADER_NAME) {
      publish(value);
    }

    return originalSetRequestHeader.apply(this, arguments);
  };

  function readHeaderFromFetch(input, init) {
    return readHeader(init?.headers) || readHeader(input?.headers);
  }

  function readHeader(headers) {
    if (!headers) {
      return "";
    }

    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      return headers.get(HEADER_NAME) || "";
    }

    if (Array.isArray(headers)) {
      const entry = headers.find(
        ([name]) => String(name || "").toLowerCase() === HEADER_NAME
      );
      return entry?.[1] || "";
    }

    return headers[HEADER_NAME] || headers["Anti-Content"] || "";
  }
})();
