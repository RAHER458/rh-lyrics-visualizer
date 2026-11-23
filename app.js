/* RH LYRICS VISUALIZER v0.1 — standalone experimental project.
   No RH-MUSIC code, Workers, D1 or APIs are used. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const audio = $('audio');
  const state = {
    title: '', artist: '', duration: 0,
    buffer: null,
    lines: [],       // [{ text, words:[{text,start,end}], start, end }]
    words: [],       // flat sorted [{text,start,end,lineIndex}]
    activeWord: -1,
    activeLine: -1,
    analysis: null,
    manual: false,
    repeat: false,
    raf: 0,
    analyser: null,
    audioCtx: null,
    sourceNode: null,
  };

  const fmt = (s) => {
    const n = Math.max(0, Number(s) || 0);
    return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function setState(text, kind) {
    $('visualState').textContent = text || '';
    $('visualState').dataset.kind = kind || '';
  }

  /* ═════════════════════════ LYRICS ENGINE ═════════════════════════ */

  const LyricsEngine = {
    parseLrc(text) {
      const lines = [];
      for (const raw of String(text || '').split(/\r?\n/)) {
        const lineMatch = raw.match(/^\s*((?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/);
        if (!lineMatch) {
          const plain = raw.trim();
          if (plain) lines.push({ text: plain, words: null });
          continue;
        }
        const times = [...lineMatch[1].matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
          .map((m) => Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0));
        const body = lineMatch[2];
        const words = [];
        const tagRe = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g;
        let last = 0; let match; let plain = '';
        while ((match = tagRe.exec(body))) {
          const chunk = body.slice(last, match.index).trim();
          if (chunk) { plain += chunk + ' '; words.push({ text: chunk, start: words.length ? words[words.length - 1].end : times[0] * 1000 }); }
          const t = (Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(`0.${match[3]}`) : 0)) * 1000;
          if (words.length) words[words.length - 1].end = t;
          last = tagRe.lastIndex;
          if (chunk) words[words.length - 1].start = words.length === 1 ? times[0] * 1000 : words[words.length - 1].start;
          if (!plain && !chunk) plain = '';
        }
        const tail = body.slice(last).trim();
        if (tail) { plain += tail; if (words.length) words[words.length - 1].end = Math.max(words[words.length - 1].end, times[0] * 1000 + 500); }
        for (const t of times) lines.push({ text: (plain || body).trim(), words: words.length > 1 ? words.map((w) => ({ ...w })) : null, start: t * 1000 });
      }
      return lines.filter((line) => line.text);
    },

    fromPlain(text) {
      const out = [];
      for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        out.push({ text: line, words: line.split(/\s+/).filter(Boolean).map((w) => ({ text: w })) });
      }
      return out;
    },

    hasWordTimes(lines) {
      return lines.some((line) => line.words && line.words.length > 1 && line.words.every((w) => Number.isFinite(w.start) && Number.isFinite(w.end)));
    },

    async fetchLrclib(title, artist, duration) {
      const params = new URLSearchParams();
      params.set('track_name', title);
      params.set('artist_name', artist);
      if (duration) params.set('duration', String(Math.round(duration)));
      const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);
      const data = await res.json();
      return data.syncedLyrics || data.plainLyrics || '';
    },
  };

  /* ═════════════════════════ AUDIO ENGINE ═════════════════════════ */

  const AudioEngine = {
    async decode(arrayBuffer) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      ctx.close();
      return buffer;
    },

    /** Реальный анализ: RMS/спектр/onsets/BPM/вокальные участки. */
    async analyze(buffer) {
      const sampleRate = buffer.sampleRate;
      const hop = Math.max(1, Math.round(sampleRate * 0.02)); // 20 ms
      const mono = new Float32Array(buffer.length);
      for (let c = 0; c < buffer.numberOfChannels; c += 1) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / buffer.numberOfChannels;
      }

      // Полосовая фильтрация 180–4200 Гц: приближение вокального диапазона.
      let vocal = mono;
      try {
        const off = new OfflineAudioContext(1, buffer.length, sampleRate);
        const src = off.createBufferSource();
        const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 180;
        const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4200;
        src.buffer = buffer; src.connect(hp); hp.connect(lp); lp.connect(off.destination); src.start();
        const rendered = await off.startRendering();
        vocal = rendered.getChannelData(0);
      } catch { /* если OfflineAudioContext недоступен — используем моно */ }

      const frames = Math.floor(mono.length / hop);
      const rms = new Float32Array(frames);
      const vocalRms = new Float32Array(frames);
      const flux = new Float32Array(frames);
      let prev = 0;
      for (let f = 0; f < frames; f += 1) {
        let sum = 0; let vs = 0;
        const from = f * hop;
        const to = Math.min(from + hop, mono.length);
        for (let i = from; i < to; i += 1) { sum += mono[i] * mono[i]; vs += vocal[i] * vocal[i]; }
        const r = Math.sqrt(sum / Math.max(1, to - from));
        const vr = Math.sqrt(vs / Math.max(1, to - from));
        rms[f] = r; vocalRms[f] = vr;
        flux[f] = Math.max(0, vr - prev);
        prev = vr;
      }

      const percentile = (arr, p) => {
        const sorted = Array.from(arr).sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
      };
      const noise = percentile(vocalRms, 0.25);
      const loud = percentile(vocalRms, 0.9);
      const threshold = noise + (loud - noise) * 0.28;
      const active = new Uint8Array(frames);
      for (let f = 0; f < frames; f += 1) active[f] = vocalRms[f] > threshold ? 1 : 0;
      // Сглаживание и склейка коротких разрывов.
      for (let pass = 0; pass < 2; pass += 1) {
        const copy = active.slice();
        for (let f = 1; f < frames - 1; f += 1) {
          if (!copy[f] && copy[f - 1] && copy[f + 1]) active[f] = 1;
          if (copy[f] && !copy[f - 1] && !copy[f + 1]) active[f] = 0;
        }
      }
      const minFrames = Math.round(0.12 / 0.02);
      const segments = [];
      let start = -1;
      for (let f = 0; f <= frames; f += 1) {
        const on = f < frames && active[f];
        if (on && start < 0) start = f;
        if (!on && start >= 0) {
          if (f - start >= minFrames) segments.push({ start: start * hop / sampleRate, end: f * hop / sampleRate });
          start = -1;
        }
      }

      // BPM по автокорреляции onset-огибающей.
      const onset = new Float32Array(flux.length);
      let maxFlux = 1e-6;
      for (const v of flux) maxFlux = Math.max(maxFlux, v);
      for (let i = 0; i < flux.length; i += 1) onset[i] = flux[i] / maxFlux;
      let bpm = 0;
      const minLag = Math.round((60 / 200) / 0.02);
      const maxLag = Math.round((60 / 60) / 0.02);
      let best = 0; let bestLag = 0;
      for (let lag = minLag; lag <= maxLag; lag += 1) {
        let sum = 0;
        for (let i = 0; i + lag < onset.length; i += 1) sum += onset[i] * onset[i + lag];
        if (sum > best) { best = sum; bestLag = lag; }
      }
      if (bestLag) bpm = Math.round(60 / (bestLag * 0.02));

      return {
        bpm,
        frames,
        hopSeconds: 0.02,
        rms: Array.from(rms),
        vocalRms: Array.from(vocalRms),
        segments,
        noise,
        loud,
        vocalSeconds: segments.reduce((sum, s) => sum + (s.end - s.start), 0),
        method: 'vad+onset+tempo heuristic v0.1',
      };
    },
  };

  /* ═════════════════════════ ALIGNMENT ENGINE ═════════════════════════ */

  const AlignmentEngine = {
    weight(word) {
      const chars = Array.from(String(word || ''));
      let vowels = 0;
      for (const ch of chars) if (/[аеёиоуыэюяaeiouy]/i.test(ch)) vowels += 1;
      return 0.6 + chars.length * 0.22 + vowels * 0.65;
    },

    /** Выравнивает слова по реальным вокальным участкам, не по равномерной сетке. */
    align(lines, analysis, durationSec) {
      if (!analysis || !analysis.segments || !analysis.segments.length) {
        return { ok: false, reason: 'no_vocal_segments', lines, words: [] };
      }
      const flat = [];
      const enriched = lines.map((line, lineIndex) => {
        const words = (line.words && line.words.length ? line.words : String(line.text).split(/\s+/).filter(Boolean).map((text) => ({ text })))
          .map((word) => ({ ...word, lineIndex }));
        words.forEach((word) => flat.push(word));
        return { ...line, words };
      });
      if (!flat.length) return { ok: false, reason: 'no_words', lines: enriched, words: [] };

      const segments = analysis.segments.filter((s) => s.end > s.start);
      const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
      const timeAt = (fraction) => {
        let target = clamp(fraction, 0, 1) * total;
        for (const seg of segments) {
          const len = seg.end - seg.start;
          if (target <= len) return seg.start + target;
          target -= len;
        }
        return segments[segments.length - 1].end;
      };

      const weights = flat.map((word) => AlignmentEngine.weight(word.text));
      const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
      let acc = 0;
      const words = flat.map((word, index) => {
        const from = acc / totalWeight;
        acc += weights[index];
        const to = acc / totalWeight;
        const start = timeAt(from);
        const end = Math.max(start + 0.05, timeAt(to));
        return { text: word.text, start, end, lineIndex: word.lineIndex };
      });

      // Уверенность: покрытие слов вокальными участками и контраст энергии.
      let inside = 0;
      for (const word of words) {
        const mid = (word.start + word.end) / 2;
        if (segments.some((s) => mid >= s.start - 0.3 && mid <= s.end + 0.3)) inside += 1;
      }
      const contrast = clamp((analysis.loud - analysis.noise) / Math.max(1e-6, analysis.loud), 0, 1);
      const confidence = clamp((inside / words.length) * (0.55 + contrast * 0.45), 0, 1);

      return {
        ok: true,
        lines: enriched,
        words,
        confidence,
        vocalCoverage: analysis.vocalSeconds / Math.max(1, durationSec || 1),
        method: analysis.method,
      };
    },

    applyManual(lines) {
      const words = [];
      const enriched = lines.map((line, lineIndex) => {
        const list = (line.words || []).map((word) => ({ ...word, lineIndex })).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
        list.forEach((word) => words.push(word));
        return { ...line, words: list };
      });
      words.sort((a, b) => a.start - b.start);
      return { ok: words.length > 0, lines: enriched, words, confidence: 1, method: 'manual-lrc', vocalCoverage: 0 };
    },
  };

  /* ═════════════════════════ VISUAL + BACKGROUND ENGINE ═════════════════════════ */

  const VisualEngine = {
    renderLine(lineIndex) {
      const line = state.lines[lineIndex];
      const current = $('currentLine');
      const next = $('nextLine');
      if (!line) { current.textContent = ''; next.textContent = ''; return; }
      current.innerHTML = (line.words || []).map((w, i) => `<span class="word future" data-w="${i}">${escapeHtml(w.text)}</span>`).join(' ');
      const nextLine = state.lines[lineIndex + 1];
      next.textContent = nextLine ? nextLine.text : '';
      state.activeLine = lineIndex;
      state.activeWord = -1;
    },

    update(time) {
      if (!state.words.length) return;
      let active = -1;
      for (let i = 0; i < state.words.length; i += 1) {
        if (state.words[i].start <= time) active = i; else break;
      }
      if (active < 0) { if (state.activeWord !== -1) { state.activeWord = -1; VisualEngine.renderLine(0); } return; }
      const lineIndex = state.words[active].lineIndex;
      if (lineIndex !== state.activeLine) VisualEngine.renderLine(lineIndex);
      if (active === state.activeWord) return;
      state.activeWord = active;
      const nodes = $('currentLine').querySelectorAll('.word');
      nodes.forEach((node, i) => {
        const word = state.lines[lineIndex].words[i];
        const isCurrent = word === state.words[active];
        node.className = `word ${isCurrent ? 'current' : ''}`;
      });
      // Явная фазовая раскраска без полного ререндера.
      let w = 0;
      for (let i = 0; i < state.words.length; i += 1) {
        if (state.words[i].lineIndex !== lineIndex) continue;
        const node = nodes[w];
        if (!node) break;
        const word = state.words[i];
        node.className = `word ${word === state.words[active] ? 'current' : (word.start < time ? 'past' : 'future')}`;
        w += 1;
      }
    },
  };

  const BackgroundEngine = {
    init() {
      if (state.audioCtx || !audio) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new Ctx();
      state.sourceNode = state.audioCtx.createMediaElementSource(audio);
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = 512;
      state.sourceNode.connect(state.analyser);
      state.analyser.connect(state.audioCtx.destination);
    },
    draw() {
      const canvas = $('bgCanvas');
      const ctx = canvas.getContext('2d');
      const w = canvas.width = window.innerWidth;
      const h = canvas.height = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      if (!state.analyser) return;
      const bins = new Uint8Array(state.analyser.frequencyBinCount);
      state.analyser.getByteFrequencyData(bins);
      let bass = 0; let high = 0;
      for (let i = 0; i < bins.length; i += 1) {
        const v = bins[i] / 255;
        if (i < bins.length * 0.18) bass += v; else if (i > bins.length * 0.6) high += v;
      }
      bass /= Math.max(1, bins.length * 0.18);
      high /= Math.max(1, bins.length * 0.4);
      const hue = 220 + high * 80;
      const grad = ctx.createRadialGradient(w / 2, h * 0.28, 0, w / 2, h * 0.28, Math.max(w, h) * 0.8);
      grad.addColorStop(0, `hsla(${hue}, 92%, ${28 + bass * 26}%, ${0.18 + bass * 0.3})`);
      grad.addColorStop(0.55, `hsla(${270 + bass * 40}, 80%, 18%, .12)`);
      grad.addColorStop(1, 'rgba(7,8,15,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      $('dBass').style.width = `${Math.round(bass * 100)}%`;
      const rms = state.analysis ? state.analysis.rms[Math.min(state.analysis.rms.length - 1, Math.round(audio.currentTime / (state.analysis.hopSeconds || 0.02)))] || 0 : 0;
      $('dRms').style.width = `${Math.round(clamp(rms * 4, 0, 1) * 100)}%`;
    },
  };

  /* ═════════════════════════ PLAYBACK CONTROLLER ═════════════════════════ */

  function tick() {
    if (!audio.paused) state.raf = requestAnimationFrame(tick);
    else state.raf = 0;
    VisualEngine.update(audio.currentTime);
    BackgroundEngine.draw();
    $('seek').value = String(Math.round((audio.currentTime / Math.max(1, audio.duration)) * 1000));
    $('times').textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
    $('dPos').textContent = audio.currentTime.toFixed(2);
    $('dWord').textContent = state.words[state.activeWord] ? state.words[state.activeWord].text : '—';
    $('dLine').textContent = state.activeLine >= 0 ? String(state.activeLine + 1) : '—';
  }

  function play() {
    BackgroundEngine.init();
    if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
    audio.play().catch((error) => setState(`Ошибка воспроизведения: ${error.message}`, 'error'));
    if (!state.raf) state.raf = requestAnimationFrame(tick);
  }

  function pause() {
    audio.pause();
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    VisualEngine.update(audio.currentTime);
    BackgroundEngine.draw();
  }

  /* ═════════════════════════ EVENTS ═════════════════════════ */

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function setDiagnostics() {
    $('dBpm').textContent = state.analysis ? (state.analysis.bpm || '—') : '—';
    $('dVad').textContent = state.analysis ? `${state.analysis.segments.length} (${state.analysis.vocalSeconds.toFixed(1)} c)` : '—';
    $('dWords').textContent = state.words.length ? String(state.words.length) : '—';
    $('dConf').textContent = state.analysis && state.analysis.confidence != null ? `${Math.round(state.analysis.confidence * 100)}%` : '—';
    $('dMethod').textContent = state.analysis ? state.analysis.method : '—';
  }

  async function loadFile(file, coverFile) {
    if (!file) return;
    const buffer = await file.arrayBuffer();
    await loadArrayBuffer(buffer, file.name, coverFile);
  }

  async function loadArrayBuffer(arrayBuffer, name, coverFile) {
    setState('Декодирование аудио…');
    state.buffer = await AudioEngine.decode(arrayBuffer);
    state.duration = state.buffer.duration;
    audio.src = URL.createObjectURL(new Blob([arrayBuffer]));
    $('pTitle').textContent = state.title || name || 'Аудио';
    $('pArtist').textContent = state.artist || '';
    if (coverFile) {
      const url = URL.createObjectURL(coverFile);
      $('cover').src = url;
    }
    $('trackDuration').value = String(Math.round(state.duration));
    setState('Аудио загружено. Нажмите «Анализировать».');
  }

  async function loadUrl(url) {
    if (!url) return;
    setState('Загрузка аудио…');
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    await loadArrayBuffer(buffer, url.split('/').pop());
  }

  async function analyze() {
    if (!state.buffer) { setState('Сначала загрузите аудио.', 'error'); return; }
    $('analyzeBtn').disabled = true;
    setState('Анализ аудио: громкость, спектр, onsets, BPM, вокал…');
    try {
      const analysis = await AudioEngine.analyze(state.buffer);
      const text = $('lyricsText').value.trim();
      const lines = LyricsEngine.hasWordTimes(LyricsEngine.parseLrc(text))
        ? LyricsEngine.parseLrc(text)
        : (text ? LyricsEngine.fromPlain(text) : []);
      if (!lines.length) { setState('Нет текста. Вставьте текст или нажмите «Найти текст в LRCLIB».', 'error'); return; }
      const aligned = AlignmentEngine.align(lines, analysis, state.duration);
      state.analysis = { ...analysis, ...aligned, confidence: aligned.confidence };
      state.lines = aligned.lines || lines;
      state.words = aligned.words || [];
      state.activeLine = -1;
      state.activeWord = -1;
      VisualEngine.renderLine(0);
      VisualEngine.update(audio.currentTime);
      setDiagnostics();
      if (!aligned.ok || (state.words.length === 0)) {
        setState('Вокал не найден или текст не удалось выровнять. Вставьте LRC с пословными метками.', 'error');
      } else if (aligned.confidence < 0.35 && $('strictVad').checked) {
        setState(`Низкая уверенность синхронизации ${Math.round(aligned.confidence * 100)}%. Проверьте вручную LRC.`, 'warn');
      } else {
        setState(`Синхронизировано ${state.words.length} слов · уверенность ${Math.round(aligned.confidence * 100)}% · ${analysis.method}`);
      }
    } catch (error) {
      $('dErr').textContent = error.message;
      setState(`Ошибка анализа: ${error.message}`, 'error');
    } finally {
      $('analyzeBtn').disabled = false;
    }
  }

  /* ── events ── */
  $('playBtn').addEventListener('click', () => (audio.paused ? play() : pause()));
  $('audioFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) { state.title = f.name; loadFile(f, $('coverFile').files[0]).catch((err) => setState(err.message, 'error')); } });
  $('coverFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) $('cover').src = URL.createObjectURL(f); });
  $('loadUrlBtn').addEventListener('click', () => loadUrl($('audioUrl').value.trim()).catch((err) => setState(`Не удалось загрузить: ${err.message}`, 'error')));
  $('analyzeBtn').addEventListener('click', analyze);
  $('reanalyzeBtn').addEventListener('click', analyze);
  $('applyManualBtn').addEventListener('click', () => {
    const lines = LyricsEngine.parseLrc($('manualLrc').value.trim());
    const result = AlignmentEngine.applyManual(lines);
    if (!result.ok) { setState('В ручных таймкодах нет пословных меток.', 'error'); return; }
    state.lines = result.lines; state.words = result.words; state.analysis = { ...(state.analysis || {}), ...result };
    state.activeLine = -1; state.activeWord = -1;
    VisualEngine.renderLine(0); VisualEngine.update(audio.currentTime); setDiagnostics();
    setState(`Ручные таймкоды: ${state.words.length} слов.`);
  });
  $('fetchLyricsBtn').addEventListener('click', async () => {
    try {
      const text = await LyricsEngine.fetchLrclib($('trackTitle').value.trim(), $('trackArtist').value.trim(), Number($('trackDuration').value) || state.duration);
      if (!text) { setState('LRCLIB не вернул текст.', 'warn'); return; }
      $('lyricsText').value = text;
      setState('Текст получен из LRCLIB. Нажмите «Анализировать».');
    } catch (error) {
      setState(`LRCLIB недоступен (${error.message}). Вставьте текст вручную.`, 'error');
    }
  });
  $('diagToggle').addEventListener('click', () => {
    const panel = $('diagPanel');
    panel.hidden = !panel.hidden;
    $('diagToggle').setAttribute('aria-pressed', String(!panel.hidden));
  });
  $('seek').addEventListener('input', () => { audio.currentTime = (Number($('seek').value) / 1000) * audio.duration; VisualEngine.update(audio.currentTime); });
  $('backBtn').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); VisualEngine.update(audio.currentTime); });
  $('fwdBtn').addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); VisualEngine.update(audio.currentTime); });
  $('volume').addEventListener('input', () => { audio.volume = Number($('volume').value) / 100; });
  $('repeat').addEventListener('change', () => { state.repeat = $('repeat').checked; audio.loop = state.repeat; });
  $('trackTitle').addEventListener('input', () => { state.title = $('trackTitle').value; $('pTitle').textContent = state.title || 'Ничего не выбрано'; });
  $('trackArtist').addEventListener('input', () => { state.artist = $('trackArtist').value; $('pArtist').textContent = state.artist || '—'; });
  audio.addEventListener('pause', () => { if (state.raf) cancelAnimationFrame(state.raf); state.raf = 0; VisualEngine.update(audio.currentTime); });
  audio.addEventListener('play', () => { if (!state.raf) state.raf = requestAnimationFrame(tick); });
  audio.addEventListener('seeked', () => { VisualEngine.update(audio.currentTime); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; } else if (!audio.paused && !state.raf) state.raf = requestAnimationFrame(tick); });
  window.addEventListener('resize', () => BackgroundEngine.draw());

  setState('Загрузите трек и текст');
})();
