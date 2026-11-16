// Gemini assistant for the caption editor — everything AI runs on Gemini now.
// Script, hooks, editing, polish, post pack, script match and chat all use the SAME free
// Gemini key the visitor already saved for subtitles (More options → Gemini settings).
// Only STYLES stay in-app: templates, rendering and export are untouched and fully local.
//
// Privacy model (same promise as the rest of the site, and the same as js/gemini-asr.js):
//   * The visitor pastes THEIR OWN Gemini API key (free from Google AI Studio). It is stored
//     ONLY in this browser's localStorage (key 'vcz-gemini-key', shared with subtitles) and is
//     sent ONLY to Google's Gemini API. No key is bundled with the site, and there is no
//     owner key anywhere in this file. The key is NEVER logged (not even a prefix).
//   * Only TEXT is ever sent: caption text, a topic, or a question. Video and audio never
//     leave the device through this module (subtitles send audio clips — see gemini-asr.js).
//   * On Google's free tier, data sent to the API may be used to improve Google's products —
//     the settings note below says this plainly.
//   * Until a key is saved, every feature stays visibly off — nothing pretends to work.
//   * Any failure falls back to the existing local behaviour (rule-based auto edit, local
//     findClips hooks) — the editor never hangs and nothing is half-applied.
//
// The editor itself is reached only through window.BB_AI (a small bridge defined in app.js):
// segments are read as display text and written back through the editor's own edit path, and
// edit plans go through B().applyAiPlan — the same shape the (owner-gated) Claude edit
// returns — so cuts, hook, highlights, Shorts, undo and autosave behave exactly like the
// existing AI edit.

import { GEMINI_LS_KEY, GEMINI_ENDPOINT, geminiTestKey } from './gemini-asr.js';

// ---------- key ----------
const geminiKey = () => { try { return (localStorage.getItem(GEMINI_LS_KEY) || '').trim(); } catch { return ''; } };
const hasKey = () => !!geminiKey();

// ---------- Gemini text client (mirrors geminiTestKey + ai-assist.js aiChat) ----------
async function geminiChat(messages, { timeoutMs = 60000, temperature = 0.7, json = false, maxOutputTokens = 2048 } = {}) {
  const key = geminiKey();
  if (!key) throw new Error('Add your Gemini key first (More options → Gemini settings).');
  const system = messages.find(m => m.role === 'system');
  const userMsgs = messages.filter(m => m.role !== 'system');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system.content }] } } : {}),
        contents: userMsgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { ...(json ? { responseMimeType: 'application/json' } : {}), temperature, maxOutputTokens },
      }),
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'Gemini took too long to answer. Try again.' : 'Could not reach Gemini. Check your internet connection.');
  } finally { clearTimeout(timer); }
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || '';
    if (r.status === 400) throw new Error(`Gemini rejected the request (400)${msg ? `: ${msg}` : ''}.`);
    if (r.status === 401 || r.status === 403) throw new Error('Gemini rejected your API key. Check the key in More options → Gemini settings.');
    if (r.status === 429) { const e = new Error('busy'); e.status = 429; throw e; }
    throw new Error(`Gemini failed (${r.status})${msg ? `: ${msg}` : ''}`);
  }
  const parts = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const text = parts.map(p => p.text || '').join('');
  if (!text.trim()) throw new Error('Gemini returned an empty answer. Try again.');
  return text;
}

/** Ask for JSON and parse tolerantly (code fences / surrounding prose are stripped). */
async function geminiJSON(messages, opts) {
  const raw = await geminiChat(messages, { ...opts, json: true });
  const clean = raw.replace(/```(?:json)?/gi, '');
  const starts = [clean.indexOf('{'), clean.indexOf('[')].filter(i => i >= 0).sort((a, b) => a - b);
  if (!starts.length) throw new Error('Gemini did not return usable data. Try again.');
  const start = starts[0];
  const end = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { throw new Error('Gemini returned data that could not be read. Try again.'); }
}

// ---------- editor bridge ----------
const B = () => window.BB_AI || null;
const segLines = () => { const b = B(); return b.segments().map((s, i) => ({ i, start: s.start, end: s.end, text: b.displayText(i) })); };
const stampedTranscript = maxChars => {
  const b = B();
  let out = '';
  for (const l of segLines()) {
    const line = `[${b.fmt(l.start)}] ${l.text}\n`;
    if (out.length + line.length > maxChars) return { text: out, truncated: true };
    out += line;
  }
  return { text: out, truncated: false };
};
function styleNote() {
  const b = B(); if (!b) return 'the same language and style as the transcript';
  if (b.hinglish()) return 'Hinglish — Hindi written in Roman letters, the way Indian creators actually speak it';
  const l = b.textLang();
  if (l === 'hi') return 'Hindi (Devanagari script)';
  if (l === 'en') return 'English';
  return 'the same language and style as the transcript';
}
const SYSTEM_BASE = 'You help Indian short-video creators (Reels, Shorts, YouTube) who work from auto-generated captions. Be concrete and brief. Never invent facts that are not in the transcript.';

// ---------- tiny DOM helpers (same shapes as js/ai-assist.js) ----------
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = el('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
  }
  if (btn) { const old = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = old; }, 1500); }
  const b = B(); if (b) b.toast('Copied.');
}
function setBusy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = label || 'Working…'; }
  else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
}
function requireCaptions() {
  const b = B();
  if (!b || !b.hasVideo()) { if (b) b.toast('Open a video first.'); return false; }
  if (!b.segments().length) { b.toast('Make captions first (✨ Auto captions) — Gemini works from what is said in the video.', 6000); return false; }
  if (b.isBusy()) { b.toast('The editor is busy right now. Try again in a moment.'); return false; }
  return true;
}
const errBusy = e => (e && e.message === 'busy' ? 'Gemini is busy right now — the free tier is rate-limited. Wait a minute and try again; the local edit still works meanwhile.' : e.message);

// ---------- mount ----------
const STYLE = `
.bbai-sec{border-top:1px solid rgba(127,127,127,.25);padding:10px 2px 14px}
.bbai-sec h3{margin:4px 0 6px;font-size:14px}
.bbai-sec p.hint{margin:0 0 8px}
.bbai-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}
.bbai-out{margin-top:8px}
.bbai-item{display:flex;gap:6px;align-items:flex-start;padding:6px 8px;border:1px solid rgba(127,127,127,.25);border-radius:8px;margin:5px 0}
.bbai-item .t{flex:1;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.45}
.bbai-err{color:#ff7a7a;font-size:12.5px;min-height:1em;margin:4px 0;white-space:pre-wrap}
.bbai-note{border:1px dashed rgba(255,190,0,.55);border-radius:8px;padding:8px 10px;font-size:12.5px;line-height:1.5;margin:8px 0}
.bbai-log{max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:6px;margin:8px 0}
.bbai-msg{padding:7px 9px;border-radius:10px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-width:92%}
.bbai-msg.u{align-self:flex-end;background:rgba(90,11,25,.55)}
.bbai-msg.a{align-self:flex-start;background:rgba(127,127,127,.16)}
.bbai-msg .seek{cursor:pointer;text-decoration:underline;padding:0;border:none;background:none;color:inherit;font:inherit}
.bbai-sec textarea,.bbai-sec input[type=text],.bbai-sec input[type=password]{width:100%;box-sizing:border-box}
.bbai-sec details{margin:6px 0}
.bbai-sec summary{cursor:pointer;font-weight:600;font-size:13.5px}
.bbai-chip{font-size:12px}
.bbai-prog{font-size:12.5px;opacity:.85;min-height:1em}
`;

function buildUI(root) {
  if (!document.getElementById('geminiAssistStyle')) {
    const style = el('style'); style.id = 'geminiAssistStyle'; style.textContent = STYLE; root.appendChild(style);
  }
  const b = B();

  // ----- Gemini key status (the key itself lives in More options → Gemini settings) -----
  const secKey = el('section', 'bbai-sec');
  secKey.appendChild(el('h3', null, '✨ Gemini — script, hooks, editing'));
  secKey.appendChild(el('p', 'hint', 'Everything AI here runs on your own free Gemini key — the same key as subtitles. Only text is sent to Google (caption text, a topic, a question); your video and audio never leave this device through these features. On Google\u2019s free tier your data may be used to improve its products.'));
  const keyRow = el('div', 'bbai-row');
  const keyStat = el('span', 'bbai-prog');
  const btnKeyTest = el('button', 'btn btn-sm', 'Test Gemini key'); btnKeyTest.type = 'button';
  keyRow.append(btnKeyTest, keyStat);
  secKey.appendChild(keyRow);
  const gate = el('div', 'bbai-note', 'Gemini is off: add your free key in More options → Gemini settings (AI quality → Gemini), then come back here. Nothing below will pretend to work without one.');
  gate.id = 'geminiGate';
  secKey.appendChild(gate);
  root.appendChild(secKey);

  const gateAll = () => {
    const on = hasKey();
    gate.hidden = on;
    root.querySelectorAll('[data-gemini-act]').forEach(n => { n.disabled = !on; });
    keyStat.textContent = on ? 'Gemini ready ✓ (same key as subtitles)' : '';
  };
  btnKeyTest.onclick = async () => {
    if (!hasKey()) { keyStat.textContent = 'No Gemini key saved yet — add it in More options → Gemini settings.'; gateAll(); return; }
    setBusy(btnKeyTest, true, 'Testing…');
    try { await geminiTestKey(geminiKey()); keyStat.textContent = 'Connected ✓ — Gemini accepted the key.'; }
    catch (e) { keyStat.textContent = errBusy(e); }
    finally { setBusy(btnKeyTest, false); gateAll(); }
  };

  // ----- shared section builder -----
  function section(title, hintText) {
    const s = el('section', 'bbai-sec');
    s.appendChild(el('h3', null, title));
    if (hintText) s.appendChild(el('p', 'hint', hintText));
    const err = el('div', 'bbai-err'); err.setAttribute('role', 'alert');
    const out = el('div', 'bbai-out');
    s.append(err, out);
    root.appendChild(s);
    return { s, err, out };
  }
  const itemRow = (text, extraBtns) => {
    const row = el('div', 'bbai-item');
    row.appendChild(el('div', 't', text));
    const cp = el('button', 'btn btn-sm', 'Copy'); cp.type = 'button';
    cp.onclick = () => copyText(text, cp);
    row.appendChild(cp);
    (extraBtns || []).forEach(x => row.appendChild(x));
    return row;
  };

  // ----- 1) Script writer (NEW — needs no video) -----
  {
    const { s, err, out } = section('✍️ Script writer', 'A shoot-ready Hinglish vlog script from your topic — hook first, then beats, then a call to action. No video needed.');
    const topic = el('input'); topic.type = 'text'; topic.placeholder = 'Topic, e.g. Jaipur me best street food under ₹100'; topic.id = 'geminiScriptTopic';
    const row = el('div', 'bbai-row');
    const lenSel = el('select'); ['30 seconds', '60 seconds', '90 seconds'].forEach((t, i) => { const o = el('option', null, t); o.value = ['30', '60', '90'][i]; lenSel.appendChild(o); }); lenSel.value = '60';
    const toneSel = el('select'); ['Funny', 'Emotional', 'Informative', 'Motivational'].forEach(t => { const o = el('option', null, t); o.value = t.toLowerCase(); toneSel.appendChild(o); });
    const btn = el('button', 'btn btn-sm', 'Write script'); btn.type = 'button'; btn.dataset.geminiAct = '1';
    row.append(lenSel, toneSel, btn);
    s.insertBefore(topic, err); s.insertBefore(row, err);
    btn.onclick = async () => {
      err.textContent = ''; out.textContent = '';
      const t = topic.value.trim();
      if (!t) { err.textContent = 'Write your topic first.'; return; }
      setBusy(btn, true);
      try {
        const j = await geminiJSON([
          { role: 'system', content: `${SYSTEM_BASE} Output ONLY a JSON object. You write scripts for Indian creators who speak Hinglish on camera.` },
          { role: 'user', content: `Write a ${lenSel.value}-second vlog script in Hinglish (Hindi in Roman letters, English words in English — the way Indian creators actually speak) on this topic: "${t}". Tone: ${toneSel.value}. The script must open with a 2-second spoken hook that stops the scroll, then 3–5 short beats (each one line the creator says), then one call to action (follow / comment / DM). Keep every line speakable in one breath — no long sentences, no made-up facts, no brand names I did not give. Return JSON: {"title":"...","hook":"...","beats":[{"label":"...","line":"..."}, ...],"cta":"...","script":"the full script as flowing lines"}` },
        ], { temperature: 0.8, maxOutputTokens: 4096, timeoutMs: 90000 });
        const title = typeof j.title === 'string' ? j.title.trim() : '';
        const hook = typeof j.hook === 'string' ? j.hook.trim() : '';
        const beats = Array.isArray(j.beats) ? j.beats.filter(x => x && typeof x.line === 'string' && x.line.trim()) : [];
        const cta = typeof j.cta === 'string' ? j.cta.trim() : '';
        const script = typeof j.script === 'string' ? j.script.trim() : '';
        if (!hook && !beats.length && !script) throw new Error('Gemini returned an empty script. Try again.');
        if (title) out.appendChild(el('h4', null, `Title: ${title}`));
        if (hook) out.appendChild(itemRow(`HOOK: ${hook}`));
        beats.forEach(x => out.appendChild(itemRow(`${x.label ? `${x.label}: ` : ''}${x.line.trim()}`)));
        if (cta) out.appendChild(itemRow(`CTA: ${cta}`));
        if (script) {
          out.appendChild(el('h4', null, 'Full script'));
          const row2 = el('div', 'bbai-item');
          row2.appendChild(el('div', 't', script));
          const cp = el('button', 'btn btn-sm', 'Copy script'); cp.type = 'button';
          cp.onclick = () => copyText(script, cp);
          row2.appendChild(cp); out.appendChild(row2);
          const scr = document.getElementById('bbaiScriptGemini');
          if (scr) {
            const use = el('button', 'btn btn-sm', 'Send to Script match'); use.type = 'button';
            use.onclick = () => { scr.value = script; B().toast('Script sent to Script match — after you shoot it, match captions to these exact words.'); };
            out.appendChild(use);
          }
        }
      } catch (e) { err.textContent = errBusy(e); }
      finally { setBusy(btn, false); }
    };
  }

  // ----- 2) Hooks & titles (Gemini) -----
  {
    const { s, err, out } = section('🪝 Hooks & titles', 'Five scroll-stopping hooks and five titles from what is said in the video.');
    const row = el('div', 'bbai-row');
    const btn = el('button', 'btn btn-sm', 'Generate hooks & titles'); btn.type = 'button'; btn.dataset.geminiAct = '1';
    row.appendChild(btn); s.insertBefore(row, err);
    btn.onclick = async () => {
      err.textContent = ''; out.textContent = '';
      if (!requireCaptions()) return;
      setBusy(btn, true);
      try {
        const t = stampedTranscript(12000);
        const j = await geminiJSON([
          { role: 'system', content: `${SYSTEM_BASE} Output ONLY a JSON object.` },
          { role: 'user', content: `Here is the transcript of a short video (timestamps in brackets):\n\n${t.text}\n\nWrite in ${styleNote()}. Give exactly 5 hooks (each one short line a viewer reads in the first 2 seconds; no clickbait lies, no facts not in the transcript) and exactly 5 titles (clear, searchable, under 60 characters). Return JSON: {"hooks":["..."],"titles":["..."]}` },
        ]);
        const hooks = Array.isArray(j.hooks) ? j.hooks.filter(x => typeof x === 'string' && x.trim()) : [];
        const titles = Array.isArray(j.titles) ? j.titles.filter(x => typeof x === 'string' && x.trim()) : [];
        if (!hooks.length && !titles.length) throw new Error('Gemini returned no hooks or titles. Try again.');
        if (hooks.length) { out.appendChild(el('h4', null, 'Hooks')); hooks.forEach(h => {
          const use = el('button', 'btn btn-sm', 'On-screen'); use.type = 'button';
          use.onclick = () => { if (B().addHook(h)) B().toast('Hook added as on-screen text at the start. Ctrl+Z undoes.'); };
          out.appendChild(itemRow(h, [use]));
        }); }
        if (titles.length) { out.appendChild(el('h4', null, 'Titles')); titles.forEach(t2 => out.appendChild(itemRow(t2))); }
      } catch (e) { err.textContent = errBusy(e); }
      finally { setBusy(btn, false); }
    };
  }

  // ----- 3) Gemini edit (NEW — BYOK replacement for the owner-gated Claude edit) -----
  // Returns the SAME plan shape applyAiPlan already applies: {cuts, hook, highlights,
  // shorts, title, description}. Local rule-based auto edit stays as the fallback.
  {
    const { s, err, out } = section('🤖 Gemini edit', 'Gemini reads the transcript and plans the edit — bad takes and repeats cut, a hook on screen, key words highlighted, and the best Shorts picked. Applied with the editor\u2019s own tools; one undo step. If Gemini is busy, the local Auto edit still works.');
    const row = el('div', 'bbai-row');
    const btn = el('button', 'btn btn-sm', 'Plan edit with Gemini'); btn.type = 'button'; btn.dataset.geminiAct = '1';
    const prog = el('span', 'bbai-prog');
    row.append(btn, prog); s.insertBefore(row, err);
    btn.onclick = async () => {
      err.textContent = ''; out.textContent = ''; prog.textContent = '';
      if (!requireCaptions()) return;
      setBusy(btn, true);
      try {
        const t = stampedTranscript(12000);
        const dur = B().duration ? B().duration() : 0; // bridge addition (see PATCH-PLAN-ALL.md); 0 = no upper clamp
        prog.textContent = 'Gemini is reading the transcript…';
        const j = await geminiJSON([
          { role: 'system', content: `${SYSTEM_BASE} Output ONLY a JSON object. You are a ruthless short-video editor: cut everything that does not earn its seconds.` },
          { role: 'user', content: `This video is ${dur ? `${Math.round(dur)} seconds long` : 'a short video'} — transcript with timestamps in brackets (first part only: ${t.truncated ? 'yes' : 'no'}):\n\n${t.text}\n\nPlan the edit in ${styleNote()}. (1) "cuts": at most 8 ranges to REMOVE — bad takes, repeated lines, rambling, off-topic bits — each {"start": seconds, "end": seconds, "reason": "one short line"}; never cut plain silences (the editor cuts those itself) and never cut the opening hook. (2) "hook": one short on-screen hook line from the best moment (under 8 words). (3) "highlights": up to 12 single words from the transcript worth colouring. (4) "shorts": at most 4 self-contained clips for Shorts/Reels, each {"start": seconds, "end": seconds, "title": "short hook title"} — each 15–60 s, each with its own clear point. (5) "title": one YouTube title. (6) "description": one short description line. All times must be inside the video. Return JSON: {"cuts":[{"start":0,"end":0,"reason":"..."}],"hook":"...","highlights":["..."],"shorts":[{"start":0,"end":0,"title":"..."}],"title":"...","description":"..."}` },
        ], { temperature: 0, maxOutputTokens: 4096, timeoutMs: 120000 });
        prog.textContent = '';
        // Validate + clamp everything to the video before handing it to the editor.
        const clamp = (a, b) => { const x = Math.max(0, +a || 0), y = dur ? Math.min(dur, +b || 0) : (+b || 0); return [x, y]; };
        const cuts = (Array.isArray(j.cuts) ? j.cuts : []).slice(0, 8).map(c => { const [a, b] = clamp(c.start, c.end); return { start: +a.toFixed(3), end: +b.toFixed(3), reason: String(c.reason || '') }; }).filter(c => c.end - c.start >= 0.3);
        const shorts = (Array.isArray(j.shorts) ? j.shorts : []).slice(0, 4).map(c => { const [a, b] = clamp(c.start, c.end); return { start: +a.toFixed(3), end: +b.toFixed(3), title: String(c.title || '').trim() }; }).filter(c => c.end - c.start >= 10 && c.title);
        const hook = typeof j.hook === 'string' ? j.hook.trim() : '';
        const highlights = (Array.isArray(j.highlights) ? j.highlights : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 12);
        const title = typeof j.title === 'string' ? j.title.trim() : '';
        const description = typeof j.description === 'string' ? j.description.trim() : '';
        if (!cuts.length && !hook && !highlights.length && !shorts.length && !title) {
          err.textContent = 'Gemini found nothing worth cutting — your video is already tight. The local Auto edit (pauses + fillers) is still there if you want it.';
          return;
        }
        const res = B().applyAiPlan({ cuts, hook, highlights, shorts, title, description });
        if (res && res.done && res.done.length) out.appendChild(el('p', 'hint', `Applied: ${res.done.join(' · ')}`));
      } catch (e) {
        prog.textContent = '';
        err.textContent = errBusy(e);
        if (B().autoEdit) {
          const fb = el('button', 'btn btn-sm', 'Run local Auto edit instead'); fb.type = 'button';
          fb.onclick = () => { B().autoEdit(); };
          out.appendChild(fb);
        }
      } finally { setBusy(btn, false); }
    };
  }

  // ----- 4) Caption polish (Gemini) -----
  {
    const { s, err, out } = section('✨ Polish captions', 'Fixes hearing mistakes, spelling and punctuation, and makes the language natural. Your caption timings are never changed — if Gemini\u2019s reply does not line up 1-to-1 with your captions, nothing is applied.');
    const row = el('div', 'bbai-row');
    const btn = el('button', 'btn btn-sm', 'Polish captions'); btn.type = 'button'; btn.dataset.geminiAct = '1';
    const prog = el('span', 'bbai-prog');
    row.append(btn, prog); s.insertBefore(row, err);
    btn.onclick = async () => {
      err.textContent = ''; out.textContent = ''; prog.textContent = '';
      if (!requireCaptions()) return;
      const lines = segLines();
      setBusy(btn, true);
      try {
        const fixed = new Array(lines.length);
        const BATCH = 40;
        for (let at = 0; at < lines.length; at += BATCH) {
          const batch = lines.slice(at, at + BATCH);
          prog.textContent = `Polishing captions ${at + 1}–${at + batch.length} of ${lines.length}…`;
          const numbered = batch.map((l, k) => `${k + 1}. ${l.text}`).join('\n');
          const j = await geminiJSON([
            { role: 'system', content: `${SYSTEM_BASE} Output ONLY a JSON object.` },
            { role: 'user', content: `These are ${batch.length} numbered caption lines from a video, in ${styleNote()}:\n\n${numbered}\n\nFix each line: correct words the speech recogniser heard wrong, fix spelling and punctuation, and make the phrasing natural — without changing the meaning, without translating, and without adding or removing lines. Keep each line about the same length. Return JSON: {"lines":["line 1","line 2", ...]} with exactly ${batch.length} entries in the same order.` },
          ], { temperature: 0, maxOutputTokens: 4096, timeoutMs: 90000 });
          const arr = j && Array.isArray(j.lines) ? j.lines : null;
          if (!arr || arr.length !== batch.length || arr.some(x => typeof x !== 'string' || !x.trim())) {
            throw Object.assign(new Error('__mismatch'), { suggestions: j });
          }
          arr.forEach((x, k) => { fixed[at + k] = x.trim(); });
        }
        prog.textContent = '';
        const res = B().applyTexts(fixed);
        if (!res.ok) throw new Error('Could not apply the polish safely, so nothing was changed.');
        B().toast(res.changed ? `Polished ${res.changed} caption${res.changed > 1 ? 's' : ''}. Timings unchanged — Ctrl+Z undoes.` : 'Captions already look clean — nothing to change.', 6000);
      } catch (e) {
        prog.textContent = '';
        if (e.message === '__mismatch') {
          err.textContent = 'Gemini\u2019s reply did not line up 1-to-1 with your captions, so NOTHING was changed. You can copy any suggestion below by hand:';
          const arr = e.suggestions && Array.isArray(e.suggestions.lines) ? e.suggestions.lines : [];
          arr.forEach(x => { if (typeof x === 'string' && x.trim()) out.appendChild(itemRow(x)); });
        } else err.textContent = errBusy(e);
      } finally { setBusy(btn, false); }
    };
  }

  // ----- 5) Post pack (Gemini) -----
  {
    const { s, err, out } = section('📣 Post pack', 'Ready-to-post description, hashtags and a pinned comment, written from the video itself.');
    const row = el('div', 'bbai-row');
    const btn = el('button', 'btn btn-sm', 'Make post pack'); btn.type = 'button'; btn.dataset.geminiAct = '1';
    row.appendChild(btn); s.insertBefore(row, err);
    const block = (label, text) => {
      out.appendChild(el('h4', null, label));
      const row2 = el('div', 'bbai-item');
      row2.appendChild(el('div', 't', text));
      const cp = el('button', 'btn btn-sm', 'Copy'); cp.type = 'button';
      cp.onclick = () => copyText(text, cp);
      row2.appendChild(cp); out.appendChild(row2);
    };
    btn.onclick = async () => {
      err.textContent = ''; out.textContent = '';
      if (!requireCaptions()) return;
      setBusy(btn, true);
      try {
        const t = stampedTranscript(12000);
        const j = await geminiJSON([
          { role: 'system', content: `${SYSTEM_BASE} Output ONLY a JSON object.` },
          { role: 'user', content: `Transcript of a short video:\n\n${t.text}\n\nWrite a posting pack in ${styleNote()}: (1) "description": 2–4 short lines for the post, ending with one question that invites comments; (2) "hashtags": 10–15 relevant hashtags (with #), mixing broad and niche, none invented-brand names; (3) "pinnedComment": one friendly first comment that asks viewers a question about the video. Return JSON: {"description":"...","hashtags":["#...", ...],"pinnedComment":"..."}` },
        ]);
        const desc = typeof j.description === 'string' ? j.description.trim() : '';
        const tags = Array.isArray(j.hashtags) ? j.hashtags.filter(x => typeof x === 'string' && x.trim()).map(x => (x.trim().startsWith('#') ? x.trim() : `#${x.trim()}`)) : [];
        const pin = typeof j.pinnedComment === 'string' ? j.pinnedComment.trim() : '';
        if (!desc && !tags.length && !pin) throw new Error('Gemini returned an empty post pack. Try again.');
        if (desc) block('Description', desc);
        if (tags.length) block('Hashtags', tags.join(' '));
        if (pin) block('Pinned comment', pin);
      } catch (e) { err.textContent = errBusy(e); }
      finally { setBusy(btn, false); }
    };
  }

  // ----- 6) Script match (Gemini) -----
  {
    const { s, err, out } = section('🎬 Script match', 'Paste the script you actually read out. Captions are rewritten in your script\u2019s exact words, keeping the original timings. Applied only if the reply lines up 1-to-1 and really follows your script.');
    const ta = el('textarea'); ta.rows = 5; ta.placeholder = 'Paste your script here…'; ta.id = 'bbaiScriptGemini';
    s.insertBefore(ta, err);
    const row = el('div', 'bbai-row');
    const btn = el('button', 'btn btn-sm', 'Match captions to script'); btn.type = 'button'; btn.dataset.geminiAct = '1';
    const prog = el('span', 'bbai-prog');
    row.append(btn, prog); s.insertBefore(row, err);
    const normWords = t => (String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    btn.onclick = async () => {
      err.textContent = ''; out.textContent = ''; prog.textContent = '';
      if (!requireCaptions()) return;
      const script = ta.value.trim();
      if (!script) { err.textContent = 'Paste your script first.'; return; }
      const lines = segLines();
      if (lines.length > 200) { err.textContent = `This video has ${lines.length} captions — script match works up to 200 captions at a time. Split the video or trim it first.`; return; }
      setBusy(btn, true);
      try {
        prog.textContent = 'Matching captions to your script…';
        const numbered = lines.map((l, k) => `${k + 1}. ${l.text}`).join('\n');
        const j = await geminiJSON([
          { role: 'system', content: `${SYSTEM_BASE} Output ONLY a JSON object.` },
          { role: 'user', content: `A creator read this script aloud:\n\n"""\n${script.slice(0, 14000)}\n"""\n\nThe speech recogniser produced these ${lines.length} numbered caption lines (same performance, with hearing mistakes):\n\n${numbered}\n\nRewrite the caption lines using the script's EXACT words, in script order, spread across the same ${lines.length} lines so each line still matches what is spoken at that moment. Keep line lengths similar to the originals. Do not add words that are not in the script, and do not drop script sentences. Return JSON: {"lines":["line 1", ...]} with exactly ${lines.length} entries.` },
        ], { temperature: 0, maxOutputTokens: 4096, timeoutMs: 120000 });
        prog.textContent = '';
        const arr = j && Array.isArray(j.lines) ? j.lines : null;
        if (!arr || arr.length !== lines.length || arr.some(x => typeof x !== 'string' || !x.trim())) {
          err.textContent = 'Gemini\u2019s reply did not line up 1-to-1 with your captions, so NOTHING was changed. Suggestions, if any:';
          (arr || []).forEach(x => { if (typeof x === 'string' && x.trim()) out.appendChild(itemRow(x)); });
          return;
        }
        // Local safeguard: the result must actually use the script's words.
        const bag = new Map();
        normWords(arr.join(' ')).forEach(w => bag.set(w, (bag.get(w) || 0) + 1));
        const sw = normWords(script);
        let hit = 0;
        const seen = new Map();
        sw.forEach(w => { const c = (seen.get(w) || 0) + 1; seen.set(w, c); if ((bag.get(w) || 0) >= c) hit++; });
        const coverage = sw.length ? hit / sw.length : 0;
        if (coverage < 0.7) {
          err.textContent = `The reply only used ${Math.round(coverage * 100)}% of your script's words, so NOTHING was changed — it may have drifted from your script. The suggestions are shown below so you can copy from them by hand:`;
          arr.forEach(x => out.appendChild(itemRow(x)));
          return;
        }
        const res = B().applyTexts(arr.map(x => x.trim()));
        if (!res.ok) { err.textContent = 'Could not apply the match safely, so nothing was changed.'; return; }
        B().toast(`Captions now follow your script (${Math.round(coverage * 100)}% of script words used). Timings unchanged — Ctrl+Z undoes.`, 7000);
      } catch (e) { prog.textContent = ''; err.textContent = errBusy(e); }
      finally { setBusy(btn, false); }
    };
  }

  // ----- 7) Chat with this video (Gemini) -----
  {
    const { s, err, out } = section('💬 Chat with this video', 'Ask about the video\u2019s content: the strongest hook moment, a summary, where to cut Shorts. Answers use only the transcript.');
    const log = el('div', 'bbai-log'); log.id = 'geminiChatLog';
    s.insertBefore(log, err);
    const chips = el('div', 'bbai-row');
    ['Best 15-second hook moment?', 'Summarise this video in 3 lines', 'Where can I cut Shorts from this?', 'Who is this video for?'].forEach(q => {
      const c = el('button', 'btn btn-sm bbai-chip', q); c.type = 'button'; c.dataset.geminiAct = '1';
      c.onclick = () => { input.value = q; send(); };
      chips.appendChild(c);
    });
    s.insertBefore(chips, err);
    const row = el('div', 'bbai-row');
    const input = el('input'); input.type = 'text'; input.placeholder = 'Ask about this video…'; input.id = 'geminiChatIn';
    const btn = el('button', 'btn btn-sm', 'Ask'); btn.type = 'button'; btn.dataset.geminiAct = '1';
    row.append(input, btn); s.insertBefore(row, err);
    const history = [];
    const addMsg = (who, text) => {
      const m = el('div', `bbai-msg ${who === 'u' ? 'u' : 'a'}`);
      if (who === 'u') { m.textContent = text; }
      else {
        // Assistant text is inserted as text nodes; [m:ss] stamps become seek buttons.
        const re = /\[?(\d{1,3}):(\d{2})\]?/g; let last = 0, mm;
        while ((mm = re.exec(text))) {
          if (mm.index > last) m.appendChild(document.createTextNode(text.slice(last, mm.index)));
          const sec = +mm[1] * 60 + +mm[2];
          const sb = el('button', 'seek', mm[0]); sb.type = 'button';
          sb.onclick = () => B().seekTo(sec);
          m.appendChild(sb); last = mm.index + mm[0].length;
        }
        m.appendChild(document.createTextNode(text.slice(last)));
      }
      log.appendChild(m); log.scrollTop = log.scrollHeight;
      return m;
    };
    async function send() {
      err.textContent = '';
      const q = input.value.trim();
      if (!q) return;
      if (!requireCaptions()) return;
      input.value = '';
      addMsg('u', q);
      setBusy(btn, true, 'Thinking…');
      try {
        const t = stampedTranscript(24000);
        const sys = `${SYSTEM_BASE} You are answering questions about ONE video, using only its transcript below (timestamps in brackets). When you point to a moment, cite its timestamp like [1:23]. If the answer is not in the transcript, say so plainly.\n\nTRANSCRIPT${t.truncated ? ' (first part only — the video is long)' : ''}:\n${t.text}`;
        const msgs = [{ role: 'system', content: sys }, ...history.slice(-8), { role: 'user', content: q }];
        const ans = await geminiChat(msgs, { timeoutMs: 90000, maxOutputTokens: 2048 });
        history.push({ role: 'user', content: q }, { role: 'assistant', content: ans });
        addMsg('a', ans);
      } catch (e) { err.textContent = errBusy(e); }
      finally { setBusy(btn, false); }
    }
    btn.onclick = send;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  gateAll();
}

// Wait for the pane (added in app.html) and the editor bridge (defined in app.js, which
// loads before this module), then build once. Loads after js/ai-assist.js, so the Gemini
// sections sit below the ChatGPT ones in the same AI tab.
(function init(tries = 0) {
  const pane = document.getElementById('paneAI');
  const host = document.getElementById('bbaiRoot');
  if (pane && host && B()) { buildUI(host); return; }
  if (tries < 60) setTimeout(() => init(tries + 1), 100);
  else if (host) host.appendChild(el('p', 'hint', 'Gemini assistant could not start (editor bridge missing). The rest of the editor is unaffected.'));
})();
