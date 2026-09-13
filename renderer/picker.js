import { PRESETS } from './capture.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Screen/app picker. Resolves to { source, presetKey, detail, audio } or null if cancelled.
 */
export function openPicker({ presetKey, detail, audio, audioScope, helperAvailable }) {
  const dialog = $('picker');
  const grid = $('source-grid');
  const quality = $('picker-quality');
  const audioBox = $('picker-audio');
  const detailBox = $('picker-detail');
  const note = $('picker-audio-note');
  const scopeSelect = $('picker-audio-scope');
  const goLive = $('go-live');
  const tabs = [...dialog.querySelectorAll('[data-tab]')];

  let tab = 'screen';
  let sources = [];
  let selectedId = null;
  let refreshTimer = null;

  quality.replaceChildren(...Object.entries(PRESETS).map(([key, p]) => {
    const opt = el('option', null, p.label);
    opt.value = key;
    return opt;
  }));
  quality.value = presetKey;
  audioBox.checked = audio;
  scopeSelect.value = audioScope === 'system' ? 'system' : 'app';
  detailBox.checked = detail;

  const selected = () => sources.find((s) => s.id === selectedId) || null;

  function updateNote() {
    const src = selected();
    goLive.disabled = !src;
    const appShare = !!src && src.kind === 'window';
    scopeSelect.hidden = !(audioBox.checked && helperAvailable && appShare);
    if (!audioBox.checked) {
      note.textContent = '';
    } else if (helperAvailable) {
      note.textContent = !src ? '' : appShare && scopeSelect.value === 'app'
        ? "Only this app's audio is shared."
        : "All computer audio except ScreenLink's is shared.";
    } else {
      note.textContent = src && src.kind === 'window'
        ? 'App audio needs audio-capture.exe. This share will have no audio.'
        : 'Shares all computer audio (audio-capture.exe not found).';
    }
  }

  function render() {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    const visible = sources.filter((s) => s.kind === tab);
    if (!visible.length) {
      grid.replaceChildren(el('p', 'sub empty', sources.length ? 'Nothing to show here.' : 'Loading sources…'));
      return;
    }
    grid.replaceChildren(...visible.map((s) => {
      const card = el('button', 'source-card');
      card.type = 'button';
      card.classList.toggle('selected', s.id === selectedId);
      const thumb = el('div', 'thumb');
      if (s.thumbnail) {
        const img = el('img');
        img.src = s.thumbnail;
        img.alt = '';
        thumb.append(img);
      }
      const label = el('div', 'source-label');
      if (s.icon) {
        const icon = el('img', 'app-icon');
        icon.src = s.icon;
        icon.alt = '';
        label.append(icon);
      }
      label.append(el('span', null, s.name));
      label.title = s.name;
      card.append(thumb, label);
      card.addEventListener('click', () => { selectedId = s.id; render(); updateNote(); });
      card.addEventListener('dblclick', () => { selectedId = s.id; finish(true); });
      return card;
    }));
  }

  async function refresh() {
    try {
      sources = await window.screenlink.listSources();
      if (selectedId && !sources.some((s) => s.id === selectedId)) selectedId = null;
      if (!selectedId) {
        const firstScreen = sources.find((s) => s.kind === 'screen');
        if (firstScreen) selectedId = firstScreen.id;
      }
      render();
      updateNote();
    } catch (err) {
      grid.replaceChildren(el('p', 'sub empty', `Couldn't list sources: ${err.message}`));
    }
  }

  let resolvePicker;
  const result = new Promise((resolve) => { resolvePicker = resolve; });

  function finish(ok) {
    clearInterval(refreshTimer);
    tabs.forEach((t) => { t.onclick = null; });
    goLive.onclick = null;
    audioBox.onchange = null;
    scopeSelect.onchange = null;
    dialog.onclose = null;
    const src = selected();
    if (dialog.open) dialog.close();
    resolvePicker(ok && src ? {
      source: src,
      presetKey: quality.value,
      detail: detailBox.checked,
      audio: audioBox.checked,
      audioScope: scopeSelect.value,
    } : null);
  }

  tabs.forEach((t) => { t.onclick = () => { tab = t.dataset.tab; render(); }; });
  goLive.onclick = () => finish(true);
  audioBox.onchange = updateNote;
  scopeSelect.onchange = updateNote;
  dialog.onclose = () => finish(false);

  render();
  updateNote();
  dialog.showModal();
  refresh();
  refreshTimer = setInterval(refresh, 4000); // keep thumbnails live while choosing
  return result;
}
