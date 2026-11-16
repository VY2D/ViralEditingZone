// Live Caption Studio — record with the camera, captions as you speak, one-tap silence cut,
// final video ready to share. Browser-direct, bring your own Gemini key (BYOK).
//
// How it works (see PATCH-PLAN-LIVE.md for the wiring into app.js / app.html):
//   * LIVE PREVIEW — the camera picture with captions overlaid as you speak. The overlay is
//     the browser's own speech recognition (webkitSpeechRecognition, instant interim results,
//     ~0.5 s behind your voice) — that is the only in-browser way to get word-instant captions.
//   * GEMINI CORRECTION — every ~5 s of microphone audio is also sent to Gemini (the same
//     saved key subtitles use). When the answer returns (~5–8 s behind your voice), those words
//     replace the recognition's words for that stretch, so the overlay self-corrects to exact
//     Roman Hinglish. No key, or recognition unsupported (Safari/Firefox): the overlay stays
//     on recognition alone, and the final captions still come from Gemini after you stop.
//   * RECORDING — the CLEAN camera + microphone stream (not the preview canvas). The preview
//     captions are never burned into the recording: the final, accurate Gemini captions are
//     burned in once, at export, through the editor's normal export path. That also keeps the
//     full capture quality (1080p, or 4K where the camera supports it) instead of the
//     1080x1920 / 8 Mbit canvas re-encode.
//   * FINISH — after you stop: the recording is loaded into the editor, Gemini re-transcribes
//     it properly (the authoritative captions), one tap cuts the silences (word gaps), the
//     video exports at your chosen quality, and the share sheet opens. Target: about 1–2 min
//     of finishing for a video up to ~2 min on Chrome/Edge (WebCodecs export is faster than
//     real time); on Safari / MediaRecorder-only browsers the export runs in real time, so the
//     finish takes about the video's length + ~30 s.
//
// Privacy: only AUDIO CLIPS (16 kHz mono, ≤ 5 s each for live correction, ≤ 29 s for the final
// pass) are sent to Google's Gemini API, and only when the visitor saved their own key. The
// video itself never leaves the device except through the share sheet the user picks.
// The key is read from the same localStorage store subtitles use (vcz-gemini-key, imported
// from gemini-asr.js), never logged, never sent anywhere except the Gemini API.

import { geminiTranscribe, GEMINI_LS_KEY } from './gemini-asr.js';
import { SR } from './asr-core.js';

/** Microphone audio is downsampled to 16 kHz mono for Gemini, like the rest of the app. */
const MIC_SR = SR; // 16000
/** Live-correction window: 5 s of speech per Gemini request (~12 requests per minute of talking). */
const LIVE_WINDOW_S = 5;

const $ = id => document.getElementById(id);
const fmtClock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- recording quality ----------

/** Quality choices. 4K is best-effort: most phone FRONT cameras top out at 1080p; rear cameras
    often do 4K. probeLiveQuality() marks what this camera can actually do. */
export const LIVE_QUALITIES = [
  { id: '1080p', label: '1080p · Full HD', w: 1080, h: 1920, vbr: 12_000_000 },
  { id: '4k', label: '4K · Ultra HD', w: 2160, h: 3840, vbr: 40_000_000 },
];
export const liveQuality = id => LIVE_QUALITIES.find(q => q.id === id) || LIVE_QUALITIES[0];

/** MediaStreamConstraints for the camera at the picked quality and facing. */
export function liveConstraints(qualityId, facingMode = 'user') {
  const q = liveQuality(qualityId);
  return {
    video: { width: { ideal: q.h }, height: { ideal: q.w }, facingMode },
    audio: { echoCancellation: true, noiseSuppression: true },
  };
}

/**
 * Ask the camera what it can really do. Opens a short probe stream (ideal 4K) and reads what the
 * sensor reports — getCapabilities().width.max, falling back to the settings the browser gave.
 * Returns the qualities with a `supported` flag + a plain-language note. Always resolves; a
 * denied permission just marks everything unsupported.
 */
export async function probeLiveQuality() {
  const out = LIVE_QUALITIES.map(q => ({ ...q, supported: true, note: '' }));
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return out.map(q => ({ ...q, supported: false, note: 'Camera is not available in this browser.' }));
  }
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 3840 }, height: { ideal: 2160 }, facingMode: 'user' }, audio: false,
    });
    const track = stream.getVideoTracks()[0];
    const caps = (track.getCapabilities && track.getCapabilities()) || {};
    const set = (track.getSettings && track.getSettings()) || {};
    const maxSide = Math.max(caps.width && caps.width.max || 0, set.width || 0, set.height || 0);
    const fourK = out.find(q => q.id === '4k');
    if (maxSide < 3840) {
      fourK.supported = false;
      fourK.note = maxSide ? `This camera tops out at ${maxSide}p — 4K is not available on it.` : 'This camera does not report 4K.';
    }
  } catch {
    return out.map(q => ({ ...q, supported: false, note: 'Camera permission was denied.' }));
  } finally {
    if (stream) stream.getTracks().forEach(t => t.stop());
  }
  return out;
}

// ---------- microphone tap (for the Gemini live correction) ----------

function downsample(input, fromRate) {
  if (fromRate === MIC_SR) return new Float32Array(input);
  const ratio = fromRate / MIC_SR, out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const c = Math.floor(i * ratio);
    let s = 0, n = 0;
    for (let j = c; j < Math.min(input.length, c + Math.ceil(ratio)); j++, n++) s += input[j];
    out[i] = n ? s / n : 0;
  }
  return out;
}

const geminiKey = () => { try { return (localStorage.getItem(GEMINI_LS_KEY) || '').trim(); } catch { return ''; } };

let actx = null, micSrc = null, micProc = null, micMute = null;
let micBuf = [], micLen = 0, micWinStart = 0, micQueue = Promise.resolve(), micOn = false;
/** Corrected windows: [{ winStart, winEnd, words }] — words are absolute seconds in the take. */
let corrected = [];

function storeCorrection(winStart, winEnd, words) {
  corrected = corrected.filter(c => c.winEnd <= winStart || c.winStart >= winEnd);
  corrected.push({ winStart, winEnd, words });
  // Keep only the last ~2 minutes of corrections: the overlay only ever shows recent words.
  const floor = winEnd - 120;
  corrected = corrected.filter(c => c.winEnd > floor);
}

/** Merge Gemini-corrected words into the recognition's live word list (what the preview draws).
    Words inside a corrected window are replaced wholesale; everything else stays as spoken. */
export function overlayWords(srWords, _t) {
  if (!corrected.length) return srWords;
  const out = srWords.filter(w => !corrected.some(c => w.start >= c.winStart && w.start < c.winEnd));
  for (const c of corrected) out.push(...c.words);
  return out.sort((a, b) => a.start - b.start);
}

async function transcribeLiveWindow(chunk, winStart) {
  const key = geminiKey();
  if (!key) return;
  try {
    const res = await geminiTranscribe(chunk, { apiKey: key, lang: 'hi', task: 'transcribe', parallel: 1 });
    const words = (res.words || []).map(w => ({ ...w, start: +(w.start + winStart).toFixed(3), end: +(w.end + winStart).toFixed(3) }));
    if (words.length) storeCorrection(winStart, winStart + chunk.length / MIC_SR, words);
  } catch { /* keep the recognition's words for this window — never block the recording */ }
}

/**
 * Tap the camera's microphone and send a ~5 s window to Gemini each time one fills up.
 * `t0` is performance.now() at the moment the camera started, so word times line up with the
 * preview clock. `baseSec` is where the take already is when the tap (re)starts — after a
 * front/rear camera switch the tap restarts mid-take, so its windows keep the take's clock.
 * Sequential queue (one request at a time) so corrections stay in order and never burst the
 * free tier. Call stopMicTap() when the camera stops.
 */
export function startMicTap(stream, t0, baseSec = 0) {
  stopMicTap();
  if (!geminiKey()) return false; // no key: recognition-only overlay, final pass still uses Gemini after stop
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    micSrc = actx.createMediaStreamSource(stream);
    micProc = actx.createScriptProcessor(4096, 1, 1);
    micMute = actx.createGain(); micMute.gain.value = 0; // never play the mic back
    micBuf = []; micLen = 0; micWinStart = baseSec; micOn = true;
    micProc.onaudioprocess = e => {
      if (!micOn) return;
      const down = downsample(e.inputBuffer.getChannelData(0), actx.sampleRate);
      micBuf.push(down); micLen += down.length;
      while (micLen >= MIC_SR * LIVE_WINDOW_S) {
        // Stitch the buffered pieces into one 5 s window.
        const win = new Float32Array(MIC_SR * LIVE_WINDOW_S);
        let o = 0, used = [];
        for (const p of micBuf) { win.set(p.subarray(0, Math.min(p.length, win.length - o)), o); o += Math.min(p.length, win.length - o); if (o >= win.length) break; }
        // Drop the consumed samples from the buffer.
        let drop = MIC_SR * LIVE_WINDOW_S;
        const rest = [];
        for (const p of micBuf) {
          if (drop >= p.length) { drop -= p.length; continue; }
          if (drop > 0) { rest.push(p.subarray(drop)); drop = 0; } else rest.push(p);
        }
        micBuf = rest; micLen = micBuf.reduce((a, p) => a + p.length, 0);
        const start = micWinStart; micWinStart += LIVE_WINDOW_S;
        micQueue = micQueue.then(() => transcribeLiveWindow(win, start)).catch(() => {});
      }
    };
    micSrc.connect(micProc); micProc.connect(micMute); micMute.connect(actx.destination);
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return true;
  } catch { stopMicTap(); return false; }
}

export function stopMicTap() {
  micOn = false;
  try { if (micProc) { micProc.onaudioprocess = null; micProc.disconnect(); } } catch { /* ignore */ }
  try { if (micMute) micMute.disconnect(); } catch { /* ignore */ }
  try { if (micSrc) micSrc.disconnect(); } catch { /* ignore */ }
  micProc = null; micMute = null; micSrc = null;
  micBuf = []; micLen = 0;
}

// ---------- clean recording (camera + mic, no burned-in captions) ----------

const LIVE_MIME = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4;codecs=avc1,opus', 'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
];
export const pickLiveMime = () => LIVE_MIME.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

let liveRecorder = null, liveParts = [], liveBlob = null, liveMime = '', liveQualityId = '1080p', liveDone = null;
export const lastRecording = () => liveBlob ? { blob: liveBlob, mimeType: liveMime, qualityId: liveQualityId } : null;

/** Record the clean camera + mic stream. Resolves with the Blob when stopCleanRecording() ends it.
    Throws at once when this browser can't record (so the UI can say so before the take starts). */
export function startCleanRecording(stream, qualityId = '1080p') {
  if (!window.MediaRecorder) throw new Error('Recording isn’t supported in this browser.');
  const mimeType = pickLiveMime();
  if (!mimeType) throw new Error('This browser can’t record video. Try Chrome, Edge, Firefox or Safari.');
  liveQualityId = qualityId;
  const q = liveQuality(qualityId);
  const recStream = new MediaStream([...stream.getVideoTracks(), ...stream.getAudioTracks()]);
  liveParts = []; liveMime = mimeType;
  liveRecorder = new MediaRecorder(recStream, {
    mimeType, videoBitsPerSecond: q.vbr, audioBitsPerSecond: 192000,
  });
  const done = new Promise((resolve, reject) => {
    liveRecorder.ondataavailable = e => { if (e.data && e.data.size) liveParts.push(e.data); };
    liveRecorder.onstop = () => {
      liveBlob = new Blob(liveParts, { type: mimeType || 'video/webm' });
      resolve(liveBlob);
    };
    liveRecorder.onerror = () => reject(new Error('Recording failed on this device.'));
  });
  liveDone = done;
  liveRecorder.start(500);
  return done;
}

export function stopCleanRecording() {
  if (liveRecorder && liveRecorder.state !== 'inactive') { try { liveRecorder.stop(); } catch { /* ignore */ } }
  return liveDone; // resolves with the Blob once the recorder flushes (null when never started)
}
export const isRecording = () => !!(liveRecorder && liveRecorder.state === 'recording');

// ---------- share ----------

function downloadFile(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/**
 * Open the phone's share sheet with the finished video (Instagram, YouTube, WhatsApp, … —
 * whichever apps are installed). True direct upload into Instagram/YouTube from inside the
 * app is NOT possible here: each platform needs its own API + login + review, and the web
 * share sheet is the supported route. Returns 'shared', 'downloaded' (share unavailable),
 * or 'cancelled' (the user closed the sheet).
 */
export async function shareVideo(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Live Caption Studio', text: 'Made with BrandBaazi Live Caption Studio' });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // fall through to download on any other share failure
    }
  }
  downloadFile(blob, filename);
  return 'downloaded';
}

// ---------- finish flow (after Stop) ----------

/**
 * Turn the take into the finished video. Steps, all through the editor's own paths (the
 * `bridge` is the small window.BB_LIVE object the patch adds in app.js):
 *   1. load the recording into the editor (decode + wave peaks start automatically),
 *   2. Gemini re-transcribes it properly — the authoritative, accurate captions,
 *   3. one tap cuts the silences (word gaps from those captions),
 *   4. export at the picked quality (1080p, or 4K "Original" when the take is 4K),
 *   5. the caller then shares the returned Blob.
 * `onStep(text)` reports progress for the finish panel. Throws a plain-language error when
 * any step fails, so the UI can say what happened instead of hanging.
 */
export async function finishStudio(bridge, { qualityId = '1080p', cut = true, onStep } = {}) {
  const step = t => { if (onStep) onStep(t); };
  const rec = lastRecording();
  if (!rec || !rec.blob || !rec.blob.size) throw new Error('There is no recording to finish yet.');
  const ext = rec.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([rec.blob], `live-studio-${new Date().toISOString().slice(0, 10)}.${ext}`, { type: rec.blob.type });
  step('Loading your take into the editor…');
  await bridge.loadRecording(file);
  step('✨ Gemini is writing the final captions…');
  await bridge.captionsGemini();
  let saved = 0;
  if (cut) {
    step('Cutting the pauses…');
    saved = bridge.cutSilences() || 0;
  }
  step('Exporting the final video…');
  const blob = await bridge.exportStudio(qualityId);
  if (!blob || !blob.size) throw new Error('The export produced an empty file.');
  return { blob, saved, filename: file.name.replace(/\.[^.]+$/, '') + '-captioned.' + (blob.type.includes('mp4') ? 'mp4' : 'webm') };
}

// ---------- wiring (called once, after the patch adds the studio UI) ----------

let probedQuality = false;
/** Ask the camera what it can do and update the quality picker. Lazy on purpose: the probe
    opens a camera stream, so it must never run at page load (no permission prompt before the
    user opens Live mode). Runs at most once per visit. */
export async function probeAndFillQuality() {
  if (probedQuality) return;
  probedQuality = true;
  const qSel = $('studioQuality'), statusEl = $('studioStatus');
  if (!qSel) return;
  try {
    const list = await probeLiveQuality();
    for (const q of list) {
      const opt = qSel.querySelector(`option[value="${q.id}"]`);
      if (opt) { opt.disabled = !q.supported; opt.textContent = q.label + (q.supported ? '' : ' · not on this camera'); }
    }
    const note = list.find(q => q.id === '4k');
    if (note && !note.supported && statusEl) statusEl.textContent = note.note || '';
  } catch { /* leave both qualities enabled; the camera call will report the real failure */ }
}

let studioTimer = null;

/** Wire the studio controls the patch adds to the live bar. Safe to call before the camera
    starts. The quality probe is NOT run here — see probeAndFillQuality(). */
export function initLiveStudio() {
  const B = window.BB_LIVE || (window.BB_LIVE = {});
  B.studio = {
    probeLiveQuality, probeAndFillQuality, liveConstraints, startMicTap, stopMicTap, overlayWords,
    startCleanRecording, stopCleanRecording, isRecording, lastRecording,
    shareVideo, finishStudio, pickLiveMime,
  };
  const qSel = $('studioQuality'), flipBtn = $('studioFlip');
  const finishBtn = $('studioFinishBtn'), shareBtn = $('studioShareBtn');
  const statusEl = $('studioStatus');
  if (flipBtn) {
    flipBtn.onclick = async () => {
      const b = window.BB_LIVE;
      if (!b || !b.cam || !b.flipCamera) return;
      flipBtn.disabled = true;
      try { await b.flipCamera(qSel ? qSel.value : '1080p'); }
      catch { if (b.toast) b.toast('Couldn’t switch camera on this device.'); }
      finally { flipBtn.disabled = false; }
    };
  }
  if (finishBtn) {
    finishBtn.onclick = async () => {
      const rec = lastRecording();
      if (!rec) return;
      finishBtn.disabled = true;
      if (shareBtn) shareBtn.disabled = true;
      const setStatus = t => { if (statusEl) statusEl.textContent = t; };
      try {
        const { blob, saved, filename } = await finishStudio(window.BB_LIVE, {
          qualityId: qSel ? qSel.value : '1080p', onStep: setStatus,
        });
        setStatus(`Ready${saved ? ` — ${saved.toFixed(1)} s of pauses cut` : ''} · final video is ready. Tap Share to post it.`);
        if (shareBtn) {
          shareBtn.disabled = false;
          shareBtn.onclick = async () => {
            shareBtn.disabled = true;
            const r = await shareVideo(blob, filename);
            setStatus(r === 'shared' ? 'Shared ✓ — pick the app in the share sheet.' : r === 'cancelled' ? 'Share closed — the video is still here; tap Share again to post it.' : 'Share isn’t available here, so the video downloaded instead.');
            shareBtn.disabled = false;
          };
        }
      } catch (e) {
        setStatus(e && e.message ? e.message : 'Finishing failed. Your recording is still saved — try again.');
      } finally {
        finishBtn.disabled = false;
      }
    };
  }
  // Live clock on the REC badge while recording.
  clearInterval(studioTimer);
  studioTimer = setInterval(() => {
    const t = $('liveTime');
    if (t && isRecording() && window.BB_LIVE && window.BB_LIVE.t0) {
      t.innerHTML = '<span class="live-dot"></span> REC ' + fmtClock((performance.now() - window.BB_LIVE.t0) / 1000);
    }
  }, 500);
  return B.studio;
}

// Self-start: module scripts run after the page is parsed, so the studio controls (added by the
// patch) already exist. Safe without them too — every lookup above guards for a missing element.
initLiveStudio();
