// Auto Background Generator
// Periodically triggers SillyTavern's native image generation (default: background)
// every N chat turns and lets the generated image be set automatically.
const MODULE_NAME = 'auto-background';

// ---- SillyTavern internals (loaded lazily) ----
let extSettings, saveFn, getCtx, eventSrc, eventTypes, executeSlash;

// ---- Runtime state ----
let turnsUntilNext = 3;

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
    saveFn = ext.saveSettingsDebounced;
    getCtx = ext.getContext;

    const sc = await import('../../../../script.js');
    eventSrc = sc.eventSource;
    eventTypes = sc.event_types;

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

// ---- Success detection -------------------------------------------------
// The /sd command does NOT throw when the backend is misconfigured — it just
// shows a warning and resolves. So we watch for the actual result (either the
// FORCE_SET_BACKGROUND event for background mode, or a new chat message that
// carries media) before claiming success.
function waitForImage(timeoutMs) {
    return new Promise((resolve) => {
        const ctx = getCtx && getCtx();
        const chat = ctx && ctx.chat;
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
        const onMsg = (msg) => {
            if (msg && Array.isArray(msg.extra?.media) && msg.extra.media.length) finish(true);
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

    // Start watching for the result BEFORE triggering, because the image is
    // produced asynchronously (after the slash command returns).
    const waitP = waitForImage(120000);

    try {
        setStatus(manual ? 'Generating…' : 'Auto-generating…');
        toastr.info(`Auto Background: generating "${s.type}"…`);
        await executeSlash(cmd);
    } catch (e) {
        console.error('[auto-background] trigger failed:', e);
        setStatus('Error: ' + (e?.message || e));
        toastr.error(`Auto Background: trigger failed — ${e?.message || e}`);
        return;
    }

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
}

// ---- Turn counter ------------------------------------------------------
function onMessageReceived(msg) {
    if (!msg) return;
    // Only count genuine AI replies.
    if (msg.is_user || msg.is_system) return;
    // Skip image posts (the SD extension posts its generated image as a message).
    if (Array.isArray(msg.extra?.media) && msg.extra.media.length) return;

    const s = settings();
    turnsUntilNext -= 1;

    if (turnsUntilNext <= 0) {
        turnsUntilNext = s.frequency;
        generateNow();
    }

    s.turns_until_next = turnsUntilNext;
    saveFn();
    updateCounterLabel();
}

function resetCounter() {
    const s = settings();
    turnsUntilNext = s.frequency;
    s.turns_until_next = turnsUntilNext;
    saveFn();
    updateCounterLabel();
}

// ---- Settings UI -------------------------------------------------------
function updateCounterLabel() {
    const el = document.getElementById('auto-background-counter');
    if (el) el.textContent = String(turnsUntilNext);
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
            <small>Automatically generates an image every N chat turns.</small>
        </div>
        <div class="auto-background-block">
            <label for="auto-background-frequency">Frequency (turns between generations)</label>
            <input type="number" id="auto-background-frequency" min="1" step="1" />
            <small>Turns until next generation: <span class="auto-background-counter" id="auto-background-counter">${turnsUntilNext}</span></small>
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

    eventSrc.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    eventSrc.on(eventTypes.CHAT_CHANGED, resetCounter);

    console.log('[auto-background] initialized.');
});
