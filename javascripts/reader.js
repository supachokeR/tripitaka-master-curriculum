(function () {
  "use strict";

  const readerState = {
    items: [],
    nodeMap: [],
    currentItem: 0,
    isReading: false,
    rate: 0.75,
    session: 0,
    usesSelectionHighlight: false,
    voiceURI: "",
    timer: null,
    waiting: false,
  };

  const rates = [0.75, 1, 1.25, 1.5, 2];
  const rateStorageKey = "tripitaka-reader-clear-rate";
  const voiceStorageKey = "tripitaka-reader-female-voice";

  function supportsSpeech() {
    return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  function normalizeText(value) {
    return value.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s+/g, " ").trim();
  }

  function createNodeMap(article) {
    const excludedSelector = ".reader-controls, .headerlink, script, style, noscript, pre, code";
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
    let previousBlock;

    while ((node = walker.nextNode())) {
      const block = node.parentElement.closest("p, li, h1, h2, h3, h4, h5, h6, td, th") || node.parentElement;
      if (block !== previousBlock) text += "\n";
      previousBlock = block;
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
    const maximumLength = 180;
    const boundaries = typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter("th", { granularity: "word" }).segment(text.slice(start, end)),
        (part) => start + part.index + part.segment.length)
      : Array.from(text.slice(start, end).matchAll(/\s+/g), (part) => start + part.index + part[0].length);
    let cursor = start;

    while (cursor < end) {
      let boundary = Math.min(end, cursor + maximumLength);
      if (boundary < end) {
        const safeBoundaries = boundaries.filter((position) => position > cursor && position <= boundary);
        boundary = safeBoundaries.length ? safeBoundaries[safeBoundaries.length - 1]
          : (boundaries.find((position) => position > boundary) || end);
      }

      const trimmed = trimRange(text, cursor, boundary);
      const sentence = normalizeText(text.slice(trimmed.start, trimmed.end));
      if (sentence) items.push({ ...trimmed, text: sentence, pause: boundary >= end ? 500 : 200 });
      cursor = boundary;
    }
  }

  function createReadItems(article) {
    const { nodeMap, text } = createNodeMap(article);
    const items = [];
    for (const block of text.matchAll(/[^\n]+/g)) {
      const sentences = typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter("th", { granularity: "sentence" }).segment(block[0])
        : [{ index: 0, segment: block[0] }];
      for (const sentence of sentences) {
        const start = block.index + sentence.index;
        const trimmed = trimRange(text, start, start + sentence.segment.length);
        if (trimmed.start < trimmed.end) addReadableRange(items, text, trimmed.start, trimmed.end);
      }
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
      clearTimeout(readerState.timer);
      window.speechSynthesis.cancel();
      readerState.isReading = false;
      setToggleLabel(controls, false);
      startReading(controls);
    }
  }

  function selectThaiVoice() {
    const voices = thaiVoices();
    return voices.find((voice) => voice.voiceURI === readerState.voiceURI)
      || voices.find((voice) => /kanya/i.test(voice.name))
      || voices.find((voice) => /premwadee/i.test(voice.name)) || voices[0];
  }

  function thaiVoices() {
    return window.speechSynthesis.getVoices().filter((voice) =>
      /^th(?:[-_]|$)/i.test(voice.lang)
      && /kanya|premwadee|achara|\bfemale\b/i.test(voice.name));
  }

  function updateVoices(controls) {
    const select = controls.querySelector(".reader-controls__voice");
    const voices = thaiVoices();
    select.replaceChildren();
    if (!voices.length) {
      select.add(new Option("ยังไม่พบเสียงผู้หญิงภาษาไทย", ""));
      select.disabled = true;
      return;
    }
    select.disabled = false;
    voices.forEach((voice) => select.add(new Option(voice.name, voice.voiceURI)));
    const voice = selectThaiVoice();
    select.value = voice.voiceURI;
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
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = "th-TH";
    utterance.rate = readerState.rate;

    const voice = selectThaiVoice();
    if (voice) utterance.voice = voice;
    utterance.onstart = function () {
      if (session === readerState.session) highlightItem(item);
    };

    utterance.onend = function () {
      if (session !== readerState.session) return;
      readerState.currentItem += 1;
      readerState.timer = setTimeout(() => speakNext(controls, session), item.pause / readerState.rate);
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

  async function startReading(controls) {
    const requestSession = ++readerState.session;
    readerState.waiting = true;
    setToggleLabel(controls, true);
    if (!thaiVoices().length) {
      setStatus(controls, "กำลังโหลดเสียงผู้หญิงภาษาไทย…");
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          window.speechSynthesis.removeEventListener("voiceschanged", changed);
          resolve();
        };
        const changed = () => { if (thaiVoices().length) finish(); };
        const timeout = setTimeout(finish, 2500);
        window.speechSynthesis.addEventListener("voiceschanged", changed);
        changed();
      });
    }
    if (requestSession !== readerState.session) return;
    readerState.waiting = false;
    updateVoices(controls);
    if (!selectThaiVoice()) {
      setToggleLabel(controls, false);
      setStatus(controls, "ไม่พบเสียงผู้หญิงภาษาไทย กรุณาเพิ่มเสียง Kanya หรือ Premwadee ในอุปกรณ์ หรือเปิดด้วยเบราว์เซอร์ที่มีเสียงผู้หญิงภาษาไทย");
      return;
    }
    if (!readerState.items.length) {
      setToggleLabel(controls, false);
      setStatus(controls, "ไม่พบข้อความสำหรับอ่าน");
      return;
    }

    readerState.isReading = true;
    readerState.session += 1;
    readerState.waiting = false;
    clearTimeout(readerState.timer);
    const session = readerState.session;
    setToggleLabel(controls, true);
    setStatus(controls, `กำลังอ่านด้วยความเร็ว ${readerState.rate} เท่า`);
    speakNext(controls, session);
  }

  function stopReading(controls) {
    readerState.session += 1;
    readerState.waiting = false;
    clearTimeout(readerState.timer);
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
      '<label class="reader-controls__voice-label">เสียงผู้หญิง (ภาษาไทย) <select class="reader-controls__voice" aria-label="เลือกเสียงผู้หญิงภาษาไทย"></select></label>',
      '<p class="reader-controls__status" role="status">เลือกความเร็วแล้วกด “อ่านหน้านี้”</p>',
    ].join("");

    article.insertBefore(controls, article.firstChild);
    readerState.items = createReadItems(article);
    readerState.currentItem = 0;

    controls.querySelector(".reader-controls__button").addEventListener("click", function () {
      if (readerState.isReading || readerState.waiting) {
        stopReading(controls);
      } else {
        readerState.currentItem = 0;
        startReading(controls);
      }
    });

    controls.querySelector(".reader-controls__voice").addEventListener("change", function (event) {
      readerState.voiceURI = event.target.value;
      try { window.localStorage.setItem(voiceStorageKey, readerState.voiceURI); } catch (_) {}
      if (readerState.isReading) setRate(controls, readerState.rate);
    });
    updateVoices(controls);

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
    readerState.waiting = false;
    clearTimeout(readerState.timer);
    window.speechSynthesis.cancel();
    readerState.isReading = false;
    clearHighlight();

    try {
      const savedRate = Number(window.localStorage.getItem(rateStorageKey));
      if (rates.includes(savedRate)) readerState.rate = savedRate;
      readerState.voiceURI = window.localStorage.getItem(voiceStorageKey) || "";
    } catch (_) {
      // Use the default speed when browser storage is unavailable.
    }

    const article = document.querySelector("article.md-content__inner");
    if (article && !article.querySelector(".reader-controls")) createControls(article);
  }

  if (supportsSpeech()) window.speechSynthesis.addEventListener("voiceschanged", function () {
    const controls = document.querySelector(".reader-controls");
    if (controls) updateVoices(controls);
  });

  if (typeof document$ !== "undefined") {
    document$.subscribe(mountReader);
  } else {
    document.addEventListener("DOMContentLoaded", mountReader);
  }
})();
