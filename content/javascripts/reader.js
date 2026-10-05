(function () {
  "use strict";

  const readerState = {
    chunks: [],
    currentChunk: 0,
    isReading: false,
    rate: 1,
    session: 0,
  };

  const rates = [1, 1.25, 1.5, 2];
  const rateStorageKey = "tripitaka-reader-rate";

  function supportsSpeech() {
    return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function getArticleText(article) {
    const copy = article.cloneNode(true);
    copy.querySelectorAll(".reader-controls, script, style, noscript").forEach((node) => node.remove());
    return normalizeText(copy.textContent || "");
  }

  function splitIntoChunks(text) {
    const maxLength = 260;
    const parts = text.match(/[^.!?…。！？]+[.!?…。！？]*|.+$/g) || [];
    const chunks = [];
    let chunk = "";

    parts.forEach((part) => {
      const sentence = normalizeText(part);
      if (!sentence) return;

      if (chunk && `${chunk} ${sentence}`.length > maxLength) {
        chunks.push(chunk);
        chunk = sentence;
      } else {
        chunk = chunk ? `${chunk} ${sentence}` : sentence;
      }
    });

    if (chunk) chunks.push(chunk);
    return chunks;
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

    if (!readerState.isReading || readerState.currentChunk >= readerState.chunks.length) {
      readerState.isReading = false;
      setToggleLabel(controls, false);
      setStatus(controls, "อ่านจบแล้ว");
      return;
    }

    const utterance = new SpeechSynthesisUtterance(readerState.chunks[readerState.currentChunk]);
    utterance.lang = "th-TH";
    utterance.rate = readerState.rate;

    const voice = selectThaiVoice();
    if (voice) utterance.voice = voice;

    utterance.onend = function () {
      if (session !== readerState.session) return;
      readerState.currentChunk += 1;
      speakNext(controls, session);
    };

    utterance.onerror = function (event) {
      if (session !== readerState.session) return;
      if (event.error === "canceled" || event.error === "interrupted") return;
      readerState.isReading = false;
      setToggleLabel(controls, false);
      setStatus(controls, "ไม่สามารถอ่านออกเสียงได้ในขณะนี้");
    };

    window.speechSynthesis.speak(utterance);
  }

  function startReading(controls) {
    if (!readerState.chunks.length) {
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
    readerState.currentChunk = 0;
    setToggleLabel(controls, false);
    setStatus(controls, "หยุดอ่านแล้ว");
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
    readerState.chunks = splitIntoChunks(getArticleText(article));
    readerState.currentChunk = 0;

    controls.querySelector(".reader-controls__button").addEventListener("click", function () {
      if (readerState.isReading) {
        stopReading(controls);
      } else {
        readerState.currentChunk = 0;
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
