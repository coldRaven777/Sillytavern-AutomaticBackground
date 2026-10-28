// Auto Background Generator
// Triggers SillyTavern's native image generation (default: background) on every
// NORMAL user message send and lets the generated image be set as the chat background.
const MODULE_NAME = 'auto-background';

// ---- SillyTavern internals (loaded lazily) ----
let extSettings, saveFn, getCtx, eventSrc, eventTypes, executeSlash;

// ---- Runtime state ----
let turnsUntilNext = 3;
let generating = false;       // re-entrancy guard: true while a generation is in flight
let lastTriggerAt = 0;        // timestamp of the last trigger (cooldown to absorb SD's own image message)

// Generation modes exposed by SillyTavern's image generation, mapped to their
// /sd trigger word. "background" is default and auto-applies the image to the chat.
const TYPE_OPTIONS = [
    { value: 'background', label: 'Background (auto-set)' },
    { value: 'you',        label: 'Yourself (Character)' },
    { value: 'face',       label: 'Your Face' },
    { value: 'me',         label: 'Me (User Persona)' },
    { value: 'scene',      label: 'The Whole Story' },
    { value: 'last',       label: 'The Last Message' },
    { value: 'raw_last',   label: 'Raw Last Message' },
];

function defaultSettings() {
    return {
        frequency: 3,
        type: 'background',
        turns_until_next: 3,
    };
}

async function load() {
    const ext = await import('../../../extensions.js');
    extSettings = ext.extension_settings;
    getCtx = ext.getContext;

    const sc = await import('../../../../script.js');
    eventSrc = sc.eventSource;
    eventTypes = sc.event_types;
    saveFn = sc.saveSettingsDebounced;

    const sl = await import('../../../slash-commands.js');
    executeSlash = sl.executeSlashCommands;
}

function settings() {
    if (!extSettings[MODULE_NAME]) {
        extSettings[MODULE_NAME] = defaultSettings();
    }
    // Coerce / repair persisted values so a stale 0/NaN can't fire every turn.
    const s = extSettings[MODULE_NAME];
    s.frequency = Math.max(1, Math.floor(Number(s.frequency)) || 3);
    if (!TYPE_OPTIONS.some(o => o.value === s.type)) s.type = 'background';
    turnsUntilNext = Math.max(0, Math.floor(Number(s.turns_until_next)) || s.frequency);
    return s;
}

// SillyTavern emits MESSAGE_RECEIVED with either the full message object (main
// script) or a bare message id (the SD extension does `emit(MESSAGE_RECEIVED,
// messageId, 'extension')`). Resolve to the actual message either way.
function resolveMessage(msg) {
    if (msg && typeof msg === 'object') return msg;
    if (typeof msg === 'number' || typeof msg === 'string') {
        const chat = getCtx && getCtx().chat;
        if (chat) return chat[Number(msg)];
    }
    return null;
}

// ---- Success detection -------------------------------------------------
// The /sd command does NOT throw when the backend is misconfigured — it just
// shows a warning and resolves. So we watch for the actual result (the
// FORCE_SET_BACKGROUND event for background mode, or a chat message that carries
// media) before claiming success.
function waitForImage(timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            eventSrc.off(eventTypes.FORCE_SET_BACKGROUND, onBg);
            eventSrc.off(eventTypes.MESSAGE_RECEIVED, onMsg);
        };
        const finish = (ok, reason) => {
            if (done) return;
            done = true;
            cleanup();
            resolve({ ok, reason });
        };

        const onBg = (data) => {
            if (data && (data.url || data.path)) finish(true);
        };
        const onMsg = (m) => {
            const r = resolveMessage(m);
            if (r && Array.isArray(r.extra?.media) && r.extra.media.length) finish(true);
        };

        eventSrc.on(eventTypes.FORCE_SET_BACKGROUND, onBg);
        eventSrc.on(eventTypes.MESSAGE_RECEIVED, onMsg);
        timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    });
}

// ---- Trigger the native image generation -------------------------------
async function generateNow({ manual = false } = {}) {
    const s = settings();
    const cmd = `/sd ${s.type}`;

    // Re-entrancy guard: never stack generations. This is the only throttle —
    // the `frequency` counter decides WHEN to generate; the `generating` flag
    // only prevents two overlapping generations. (A 30s wall-clock cooldown used
    // to live here and silently disabled the plugin during normal chatting.)
    if (generating) {
        console.log('[auto-background] generation already in progress, skipping.');
        return;
    }

    generating = true;
    try {
        // Start watching for the result BEFORE triggering, because the image is
        // produced asynchronously (after the slash command returns).
        const waitP = waitForImage(120000);

        setStatus(manual ? 'Generating…' : 'Auto-generating…');
        console.log(`[auto-background] triggering: ${cmd}`);
        toastr.info(`Auto Background: generating "${s.type}"…`);
        await executeSlash(cmd);

        const res = await waitP;
        if (res.ok) {
            setStatus('Last generation: success');
            toastr.success(`Auto Background: "${s.type}" image set.`);
        } else {
            setStatus('Last generation: no image produced');
            toastr.warning(
                `Auto Background: no image was produced. ` +
                `Check that Image Generation has a connected backend (A1111/ComfyUI/Forge/cloud) ` +
                `and is enabled.`
            );
        }
    } catch (e) {
        console.error('[auto-background] trigger failed:', e);
        setStatus('Error: ' + (e?.message || e));
        toastr.error(`Auto Background: trigger failed — ${e?.message || e}`);
    } finally {
        generating = false;
    }
}

// ---- Trigger: fire on every NORMAL user message send --------------------
// Hook GENERATION_STARTED and act only for type 'normal'. This excludes Silent,
// Swipe, Continue, Personify, Regenerate and other send modes, plus automatic /
// triggered generations. `frequency` throttles to every Nth normal send
// (1 = every message).
function onGenerationStarted(type, eventData) {
    try {
        if (String(type).toLowerCase() !== 'normal') return;
        if (eventData?.automatic_trigger) return;

        const s = settings();

        // Count every Normal send FIRST, so the label always ticks down — even while a
        // generation is in flight or inside the cooldown window. Only the actual image
        // generation is throttled by the guard below.
        turnsUntilNext -= 1;
        const hit = turnsUntilNext <= 0;
        if (hit) turnsUntilNext = s.frequency;

        s.turns_until_next = turnsUntilNext;
        saveFn();
        updateCounterLabel();

        // Throttle only the generation itself, not the counter. The `generating`
        // flag (not a wall-clock cooldown) is the guard: it prevents re-triggering
        // while an image is actually in flight. A time-based cooldown broke the
        // plugin during normal chatting — every send after the first stayed within
        // 30s of the last one, so the counter kept advancing but no image was ever
        // produced ("generates once then never").
        if (generating) {
            console.log('[auto-background] generation skipped (already in progress), counter still advanced.');
            return;
        }

        if (hit) generateNow();
    } catch (e) {
        // Never let a failure here abort the generation flow (TTS, replies, etc.).
        console.error('[auto-background] onGenerationStarted error:', e);
    }
}

function resetCounter() {
    try {
        const s = settings();
        turnsUntilNext = s.frequency;
        s.turns_until_next = turnsUntilNext;
        saveFn();
        updateCounterLabel();
    } catch (e) {
        console.error('[auto-background] resetCounter error:', e);
    }
}

// ---- Settings UI -------------------------------------------------------
function updateCounterLabel() {
    const el = document.getElementById('auto-background-counter');
    if (!el) return;
    const s = extSettings?.[MODULE_NAME];
    // At frequency 1 there is nothing to count down — show a clear label instead.
    el.textContent = (s && s.frequency === 1) ? 'every message' : String(turnsUntilNext);
}

function setStatus(text) {
    const el = document.getElementById('auto-background-status');
    if (el) el.textContent = text || '';
}

function buildSettings() {
    const s = settings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    if (document.getElementById('auto-background-settings')) return; // already built

    const root = document.createElement('div');
    root.id = 'auto-background-settings';
    root.className = 'auto-background-settings';

    root.innerHTML = `
        <div class="auto-background-header">
            <h3>Auto Background Generator</h3>
            <small>Generates a background on every Normal message send (every Nth if frequency &gt; 1).</small>
        </div>
        <div class="auto-background-block">
            <label for="auto-background-frequency">Frequency (normal messages between generations)</label>
            <input type="number" id="auto-background-frequency" min="1" step="1" />
            <small>Messages until next generation: <span class="auto-background-counter" id="auto-background-counter">${turnsUntilNext}</span></small>
        </div>
        <div class="auto-background-block">
            <label for="auto-background-type">Image type to generate</label>
            <select id="auto-background-type"></select>
            <small>Background auto-applies the image as the chat background; others post to chat.</small>
        </div>
        <div class="auto-background-block">
            <button type="button" id="auto-background-now" class="menu_button">Generate now (test)</button>
            <small id="auto-background-status"></small>
        </div>
    `;
    container.appendChild(root);

    const freqInput = root.querySelector('#auto-background-frequency');
    freqInput.value = s.frequency;
    freqInput.addEventListener('change', () => {
        const v = Math.max(1, Math.floor(Number(freqInput.value)) || 3);
        freqInput.value = v;
        s.frequency = v;
        if (turnsUntilNext <= 0) turnsUntilNext = v;
        s.turns_until_next = turnsUntilNext;
        saveFn();
        updateCounterLabel();
    });

    const typeSelect = root.querySelector('#auto-background-type');
    for (const o of TYPE_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (o.value === s.type) opt.selected = true;
        typeSelect.appendChild(opt);
    }
    typeSelect.addEventListener('change', () => {
        s.type = typeSelect.value;
        saveFn();
    });

    root.querySelector('#auto-background-now').addEventListener('click', () => {
        generateNow({ manual: true });
    });

    updateCounterLabel();
}

// ---- Boot -------------------------------------------------------------
jQuery(async () => {
    try {
        await load();
    } catch (e) {
        console.error('[auto-background] failed to load ST internals:', e);
        return;
    }

    settings();
    buildSettings();

    eventSrc.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    eventSrc.on(eventTypes.CHAT_CHANGED, resetCounter);

    console.log('[auto-background] initialized.');
});
