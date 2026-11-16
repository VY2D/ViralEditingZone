// Gemini transcription for the caption editor — browser-direct, bring your own key (BYOK).
//
// Privacy model (same promise as the rest of the site, and the same as js/ai-assist.js):
//   * The visitor pastes THEIR OWN Gemini API key (free from Google AI Studio). It is stored
//     ONLY in this browser's localStorage (see GEMINI_LS_KEY, used by app.js) and is sent ONLY
//     to Google's Gemini API. No key is bundled with the site, and there is no owner key here.
//   * The key is passed in as a function argument — this module never reads localStorage itself
//     and NEVER logs the key (not even a prefix).
//   * Only AUDIO CLIPS (16 kHz mono WAV, ≤ 29 s each) are sent to Gemini. The video never
//     leaves the device. Note: on Google's free tier, data sent to the API may be used to
//     improve Google's products — the settings UI must say this plainly before the user saves
//     a key (see PATCH-PLAN.md).
//
// Why gemini-2.5-flash via generateContent (and not the dedicated gemini-3.5-transcribe):
//   * One HTTPS call per clip, inline base64 audio, JSON output — it drops straight into the
//     existing chunked flow from js/cloud-asr.js with no extra round trips.
//   * gemini-3.5-transcribe is the dedicated speech-to-text model (native word timestamps,
//     85+ languages) but it does NOT use generateContent: it needs the Files API upload first,
//     then POST /v1beta/interactions, i.e. two calls per clip and a different response shape.
//     That is the upgrade path if word-level timestamps from the dedicated model prove better
//     (see PATCH-PLAN.md §6); it is not needed for the first version.
//   * A generative model also follows the Hinglish instruction in the prompt (Roman Hindi,
//     exactly as spoken) — the dedicated model returns verbatim text but cannot be told which
//     script to write Hindi in.
//
// Shape (identical to cloudTranscribe in js/cloud-asr.js, so app.js needs no other changes):
//   geminiTranscribe(audio, { apiKey, lang, task, onWords, onProgress, signal, parallel })
//     → Promise<{ words, level: 'segment', windows }>
//   words are { text, start, end, approx: true } — Gemini gives segment timestamps (1–3 s
//   phrases); chunksToWords spreads each segment's words evenly and snapToSpeech re-spreads
//   them over the voiced frames, exactly like the Fast-mode segment path.

import { planWindows, cleanWords, snapToSpeech, chunksToWords, SR } from './asr-core.js';
import { toWav } from './cloud-asr.js';

export const GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
/** localStorage key for the visitor's own Gemini API key (same BYOK pattern as js/ai-assist.js). */
export const GEMINI_LS_KEY = 'vcz-gemini-key';
/** Inline request cap is 20 MB; a 29 s 16 kHz mono WAV is ~0.93 MB (~1.24 MB base64). */
const CHUNK_TIMEOUT_MS = 120000;

function wavToBase64(blob) {
  return blob.arrayBuffer().then(buf => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  });
}

function promptFor(dur, lang, task) {
  if (task === 'translate') {
    return `Transcribe this audio clip and translate it into English, word for word. Do not summarise and do not drop anything. ` +
      `This clip is exactly ${dur.toFixed(1)} seconds long. Split the English translation into short segments at natural pauses, each about 1–3 seconds, covering the whole clip from 0 to ${dur.toFixed(1)} seconds with no gaps and no overlaps. ` +
      `Reply with ONLY this JSON object, no other text: {"segments":[{"start":0.0,"end":2.4,"text":"..."}, ...]}`;
  }
  const langNote = lang ? ` The speech is in language code "${lang}".` : '';
  return `Transcribe this audio clip EXACTLY as spoken, word for word. Do not summarise, do not clean up, do not translate.${langNote}` +
    ` The speaker speaks Hindi mixed with English (Hinglish). Write Hindi words in Roman letters exactly as spoken (for example "aaj hum jaa rahe hain"), and keep English words in English. Never convert Roman Hindi into Devanagari script.` +
    ` Keep every word, including small filler words. Keep names, numbers and brand names exactly as heard.` +
    ` This clip is exactly ${dur.toFixed(1)} seconds long. Split the speech into short segments at natural pauses, each about 1–3 seconds, covering the whole clip from 0 to ${dur.toFixed(1)} seconds with no gaps and no overlaps.` +
    ` Reply with ONLY this JSON object, no other text: {"segments":[{"start":0.0,"end":2.4,"text":"..."}, ...]}`;
}

/** Parse Gemini's reply into [{ text, timestamp: [start, end] }]. Tolerates code fences and prose. */
function parseSegments(raw, dur) {
  const clean = String(raw || '').replace(/```(?:json)?/gi, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  let segs = null;
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(clean.slice(start, end + 1));
      if (j && Array.isArray(j.segments)) segs = j.segments;
    } catch { /* fall through to the plain-text fallback below */ }
  }
  if (!segs) {
    // The model answered in plain text instead of JSON: keep the words, timed over the clip.
    const text = clean.replace(/\s+/g, ' ').trim();
    return text ? [{ text, timestamp: [0, dur] }] : [];
  }
  return segs
    .map(s => ({
      text: String((s && s.text) || '').trim(),
      timestamp: [Math.max(0, Math.min(dur, +s.start || 0)), Math.max(0, Math.min(dur, +s.end || 0))],
    }))
    .filter(s => s.text && s.timestamp[1] > s.timestamp[0])
    .sort((a, b) => a.timestamp[0] - b.timestamp[0]);
}

async function transcribeClip(wavB64, dur, lang, task, apiKey, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHUNK_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new Error('cancelled'); }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let r;
  try {
    r = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: wavB64 } },
            { text: promptFor(dur, lang, task) },
          ],
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 2048 },
      }),
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? (signal && signal.aborted ? 'cancelled' : 'Gemini took too long to answer. Try again.') : 'Could not reach Gemini. Check your internet connection.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || '';
    if (r.status === 400) throw new Error(`Gemini rejected the request (400)${msg ? `: ${msg}` : ''}. The key or the audio may be at fault.`);
    if (r.status === 401 || r.status === 403) throw new Error('Gemini rejected your API key. Check the key in More options → Gemini settings.');
    if (r.status === 429) { const e = new Error('busy'); e.status = 429; throw e; }
    throw new Error(`Gemini failed (${r.status})${msg ? `: ${msg}` : ''}`);
  }
  const parts = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const text = parts.map(p => p.text || '').join('');
  if (!text.trim()) throw new Error('Gemini returned an empty transcript for this clip.');
  return parseSegments(text, dur);
}

/**
 * @param {Float32Array} audio  16 kHz mono
 * @param {{ apiKey: string, lang: string|null, task: 'transcribe'|'translate', onWords?, onProgress?, signal?, parallel? }} o
 * @returns {Promise<{ words, level: 'segment', windows }>}
 */
export async function geminiTranscribe(audio, { apiKey, lang, task, onWords, onProgress, signal, parallel = 3 }) {
  if (!apiKey || !String(apiKey).trim()) throw new Error('Add your Gemini API key first (More options → Gemini settings).');
  const windows = planWindows(audio, { firstMax: 12 });
  const results = new Array(windows.length);
  let next = 0, done = 0, shown = 0;
  const one = async i => {
    const { start, end } = windows[i];
    const dur = (end - start) / SR;
    const b64 = await wavToBase64(toWav(audio.subarray(start, end)));
    const chunks = await transcribeClip(b64, dur, lang, task, String(apiKey).trim(), signal);
    results[i] = chunksToWords(chunks, 'segment', start / SR, end / SR);
    done++;
    onProgress && onProgress(done, windows.length);
    // Show parts in order as soon as everything before them is in.
    while (shown < results.length && results[shown]) {
      onWords && onWords(snapToSpeech(cleanWords(results[shown]), audio));
      shown++;
    }
  };
  const workers = Array.from({ length: Math.min(parallel, windows.length) }, async () => {
    while (next < windows.length) await one(next++);
  });
  await Promise.all(workers);
  return { words: snapToSpeech(cleanWords(results.flat()), audio), level: 'segment', windows: windows.length };
}

/**
 * Tiny key check for the settings UI ("Test connection"): one text-only call, no audio.
 * Returns true when the key is accepted; throws a plain-language error otherwise.
 */
export async function geminiTestKey(apiKey) {
  if (!apiKey || !String(apiKey).trim()) throw new Error('Paste a key first.');
  const r = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(String(apiKey).trim())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 16 },
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) throw new Error('Gemini rejected this key. Check it and try again.');
    if (r.status === 429) throw new Error('Rate limit reached on this key. Try again in a minute.');
    throw new Error(`Gemini test failed (${r.status}).`);
  }
  const parts = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  if (!parts.map(p => p.text || '').join('').trim()) throw new Error('Gemini answered, but with empty text. Try again.');
  return true;
}
