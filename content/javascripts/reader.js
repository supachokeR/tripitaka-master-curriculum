(function () {
  "use strict";

  const readerState = {
    items: [],
    nodeMap: [],
    currentItem: 0,
    isReading: false,
    rate: 1,
    session: 0,
    usesSelectionHighlight: false,
  };

  const rates = [1, 1.25, 1.5, 2];
  const rateStorageKey = "tripitaka-reader-rate";

  function supportsSpeech() {
    return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function createNodeMap(article) {
    const excludedSelector = ".reader-controls, script, style, noscript, pre, code";
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement && !node.parentElement.closest(excludedSelector)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const nodeMap = [];
    let text = "";
    let node;

    while ((node = walker.nextNode())) {
      const start = text.length;
      text += node.data;
      nodeMap.push({ node, start, end: text.length });
    }

    return { nodeMap, text };
  }

  function trimRange(text, start, end) {
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    return { start, end };
  }

  function addReadableRange(items, text, start, end) {
    const maximumLength = 260;
    let cursor = start;

    while (cursor < end) {
      let boundary = Math.min(end, cursor + maximumLength);
      if (boundary < end) {
        const whitespace = text.lastIndexOf(" ", boundary);
        if (whitespace > cursor + 40) boundary = whitespace + 1;
      }

      const trimmed = trimRange(text, cursor, boundary);
      const sentence = normalizeText(text.slice(trimmed.start, trimmed.end));
      if (sentence) items.push({ ...trimmed, text: sentence });
      cursor = boundary;
    }
  }

  function createReadItems(article) {
    const { nodeMap, text } = createNodeMap(article);
    const items = [];
    const sentences = text.matchAll(/[^.!?…。！？]+[.!?…。！？]*|.+$/g);

    for (const match of sentences) {
      const start = match.index;
      const end = start + match[0].length;
      const trimmed = trimRange(text, start, end);
      if (trimmed.start < trimmed.end) addReadableRange(items, text, trimmed.start, trimmed.end);
    }

    readerState.nodeMap = nodeMap;
    return items;
  }

  function locateTextPosition(position, isEnd) {
    const entry = readerState.nodeMap.find(({ start, end }) => (
      position >= start && (isEnd ? position <= end : position < end)
    ));

    if (!entry) return null;
    return { node: entry.node, offset: position - entry.start };
  }

  function createRange(item) {
    const start = locateTextPosition(item.start, false);
    const end = locateTextPosition(item.end, true);
    if (!start || !end) return null;

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function clearHighlight() {
    if (window.CSS && CSS.highlights) CSS.highlights.delete("tripitaka-reader");

    if (readerState.usesSelectionHighlight) {
      window.getSelection()?.removeAllRanges();
      readerState.usesSelectionHighlight = false;
    }
  }

  function scrollToRange(range) {
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.top >= 84 && rect.bottom <= window.innerHeight - 84)) return;

    const element = range.startContainer.parentElement?.closest("p, li, blockquote, h1, h2, h3, h4, td, th")
      || range.startContainer.parentElement;
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function highlightItem(item) {
    const range = createRange(item);
    if (!range) return;

    clearHighlight();

    if (window.Highlight && window.CSS && CSS.highlights) {
      CSS.highlights.set("tripitaka-reader", new Highlight(range));
    } else {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      readerState.usesSelectionHighlight = true;
    }

    scrollToRange(range);
  }

  function setStatus(controls, message) {
    const status = controls.querySelector(".reader-controls__status");
    if (status) status.textContent = message;
  }

  function setToggleLabel(controls, isReading) {
    const button = controls.querySelector(".reader-controls__button");
    if (!button) return;
    button.textContent = isReading ? "■ หยุดอ่าน" : "🔊 อ่านหน้านี้";
    button.setAttribute("aria-pressed", String(isReading));
  }

  function setRate(controls, rate) {
    readerState.rate = rate;
    try {
      window.localStorage.setItem(rateStorageKey, String(rate));
    } catch (_) {
      // Reading still works when browser storage is unavailable.
    }

    controls.querySelectorAll(".reader-controls__rate").forEach((button) => {
      const selected = Number(button.dataset.rate) === rate;
      button.setAttribute("aria-pressed", String(selected));
    });

    setStatus(controls, `ความเร็วการอ่าน ${rate} เท่า`);

    if (readerState.isReading) {
      readerState.session += 1;
      window.speechSynthesis.cancel();
      readerState.isReading = false;
      setToggleLabel(controls, false);
      startReading(controls);
    }
  }

  function selectThaiVoice() {
    const voices = window.speechSynthesis.getVoices();
    return voices.find((voice) => String(voice.lang).toLowerCase().startsWith("th"));
  }

  function speakNext(controls, session) {
    if (session !== readerState.session) return;

    if (!readerState.isReading || readerState.currentItem >= readerState.items.length) {
      readerState.isReading = false;
      setToggleLabel(controls, false);
      setStatus(controls, "อ่านจบแล้ว");
      clearHighlight();
      return;
    }

    const item = readerState.items[readerState.currentItem];
    highlightItem(item);
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = "th-TH";
    utterance.rate = readerState.rate;

    const voice = selectThaiVoice();
    if (voice) utterance.voice = voice;

    utterance.onend = function () {
      if (session !== readerState.session) return;
      readerState.currentItem += 1;
      speakNext(controls, session);
    };

    utterance.onerror = function (event) {
      if (session !== readerState.session) return;
      if (event.error === "canceled" || event.error === "interrupted") return;
      readerState.isReading = false;
      setToggleLabel(controls, false);
      setStatus(controls, "ไม่สามารถอ่านออกเสียงได้ในขณะนี้");
      clearHighlight();
    };

    window.speechSynthesis.speak(utterance);
  }

  function startReading(controls) {
    if (!readerState.items.length) {
      setStatus(controls, "ไม่พบข้อความสำหรับอ่าน");
      return;
    }

    readerState.isReading = true;
    readerState.session += 1;
    const session = readerState.session;
    setToggleLabel(controls, true);
    setStatus(controls, `กำลังอ่านด้วยความเร็ว ${readerState.rate} เท่า`);
    speakNext(controls, session);
  }

  function stopReading(controls) {
    readerState.session += 1;
    window.speechSynthesis.cancel();
    readerState.isReading = false;
    readerState.currentItem = 0;
    setToggleLabel(controls, false);
    setStatus(controls, "หยุดอ่านแล้ว");
    clearHighlight();
  }

  function createControls(article) {
    const controls = document.createElement("section");
    controls.className = "reader-controls";
    controls.setAttribute("aria-label", "เครื่องมืออ่านออกเสียง");
    controls.innerHTML = [
      '<button class="reader-controls__button" type="button" aria-pressed="false">🔊 อ่านหน้านี้</button>',
      '<div class="reader-controls__rates" role="group" aria-label="ความเร็วการอ่าน">',
      '<span class="reader-controls__label">ความเร็ว</span>',
      ...rates.map((rate) => `<button class="reader-controls__rate" type="button" data-rate="${rate}" aria-pressed="false">${rate}×</button>`),
      "</div>",
      '<p class="reader-controls__status" role="status">เลือกความเร็วแล้วกด “อ่านหน้านี้”</p>',
    ].join("");

    article.insertBefore(controls, article.firstChild);
    readerState.items = createReadItems(article);
    readerState.currentItem = 0;

    controls.querySelector(".reader-controls__button").addEventListener("click", function () {
      if (readerState.isReading) {
        stopReading(controls);
      } else {
        readerState.currentItem = 0;
        startReading(controls);
      }
    });

    controls.querySelectorAll(".reader-controls__rate").forEach((button) => {
      button.addEventListener("click", function () {
        setRate(controls, Number(button.dataset.rate));
      });
    });

    setRate(controls, readerState.rate);
  }

  function mountReader() {
    if (!supportsSpeech()) return;

    readerState.session += 1;
    window.speechSynthesis.cancel();
    readerState.isReading = false;
    clearHighlight();

    try {
      const savedRate = Number(window.localStorage.getItem(rateStorageKey));
      if (rates.includes(savedRate)) readerState.rate = savedRate;
    } catch (_) {
      // Use the default speed when browser storage is unavailable.
    }

    const article = document.querySelector("article.md-content__inner");
    if (article && !article.querySelector(".reader-controls")) createControls(article);
  }

  if (typeof document$ !== "undefined") {
    document$.subscribe(mountReader);
  } else {
    document.addEventListener("DOMContentLoaded", mountReader);
  }
})();
