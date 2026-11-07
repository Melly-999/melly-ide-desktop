// Scoped localization: feature prose and code remain English, marked lang=en.
const labels = {
  hubSearchTrigger: ['Open quick search', 'Otwórz szybkie wyszukiwanie'],
  hubMenuTrigger: ['Menu unavailable in this prototype', 'Menu niedostępne w tym prototypie'],
  modalCloseBtn: ['Close dialog', 'Zamknij okno'], paletteClose: ['Close search', 'Zamknij wyszukiwanie'],
  paletteInput: ['Search local records', 'Szukaj lokalnych rekordów'],
  editorTextarea: ['Code editor', 'Edytor kodu'], editorCloseBtn: ['Closing the fixed editor is unavailable', 'Zamykanie stałego edytora jest niedostępne'],
  consoleClose: ['Close execution status', 'Zamknij stan wykonania'],
  clearChatBtn: ['Reset demo chat', 'Zresetuj czat demonstracyjny'],
  chatTextInput: ['Prompt for simulated chat', 'Wiadomość do symulowanego czatu'],
  chatAttachBtn: ['Insert sample context (SIMULATED)', 'Wstaw przykładowy kontekst (SIMULATED)'],
  chatMicBtn: ['Insert fixed voice sample (SIMULATED); no audio recording', 'Wstaw próbkę głosu (SIMULATED); bez nagrywania'],
  chatSendBtn: ['Send to simulated chat', 'Wyślij do symulowanego czatu'],
  accUndo: ['Undo', 'Cofnij'], accRedo: ['Redo', 'Ponów'], accSearch: ['Search code', 'Szukaj w kodzie'],
  accKeyboard: ['Dismiss keyboard', 'Ukryj klawiaturę']
};
const texts = {
  reviewApproveBtn: ['Approve', 'Zatwierdź'], reviewRejectBtn: ['Reject', 'Odrzuć'], reviewCancelBtn: ['Cancel', 'Anuluj'],
  editorSaveBtn: ['Save', 'Zapisz']
};
const polishStates = { default: 'PRZYKŁAD LOKALNY', edited: 'ZMIENIONO', saving: 'ZAPISYWANIE', saved: 'ZAPISANO LOKALNIE', failed: 'BŁĄD ZAPISU', unavailable: 'PAMIĘĆ NIEDOSTĘPNA', recovery: 'WYMAGANE ODZYSKIWANIE' };
export function saveStateLabel(state, fallback) {
  return globalThis.document?.documentElement?.lang === 'pl' ? polishStates[state] || fallback : fallback;
}
export function localizeControls(root, lang = globalThis.document?.documentElement?.lang || 'en') {
  if (!root?.querySelector) return;
  const index = lang === 'pl' ? 1 : 0;
  for (const [id, values] of Object.entries(labels)) {
    const el = root.querySelector('#' + id);
    if (el) {
      const live = {chatTextInput:['AI prompt','Wiadomość AI'],chatAttachBtn:['Choose explicit file context','Wybierz pliki do kontekstu'],chatSendBtn:['Preview AI request','Podgląd wiadomości AI']};
      const translated = el.closest?.('[data-live-ai]') && live[id] ? live[id] : values;
      el.setAttribute('aria-label', translated[index]); el.lang = lang;
    }
  }
  for (const [id, values] of Object.entries(texts)) {
    const el = root.querySelector('#' + id);
    if (el) { el.textContent = values[index]; el.lang = lang; }
  }
  root.querySelectorAll?.('button[title]').forEach(el => {
    if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', el.title);
  });
  root.querySelectorAll?.('.accessory-btn[data-insert]').forEach(el => {
    const names = { '  ': ['Indent code', 'Wstaw wcięcie'], '{': ['Insert opening brace', 'Wstaw nawias klamrowy otwierający'], '}': ['Insert closing brace', 'Wstaw nawias klamrowy zamykający'], '(': ['Insert opening parenthesis', 'Wstaw nawias otwierający'], ')': ['Insert closing parenthesis', 'Wstaw nawias zamykający'] };
    el.setAttribute('aria-label', names[el.dataset.insert][index]); el.lang = lang;
  });
  root.querySelectorAll?.('.add-new-box input, .add-new-box textarea').forEach(el => el.setAttribute('aria-label', el.placeholder));
  const frame = root.querySelector('#toggleDeviceFrame');
  if (frame) {
    const on = frame.getAttribute('aria-pressed') === 'true';
    frame.textContent = index ? `Ramka telefonu: ${on ? 'wł.' : 'wył.'}` : `Phone frame: ${on ? 'on' : 'off'}`;
    frame.setAttribute('aria-label', index ? 'Ramka podglądu aplikacji' : 'Application preview frame'); frame.lang = lang;
  }
  const language = root.querySelector('#toggleLanguage');
  if (language) {
    language.setAttribute('aria-label', index ? 'Przełącz kontrolki na angielski; opisy funkcji pozostają angielskie' : 'Switch controls to Polish; feature descriptions remain English');
    language.title = index ? 'Polskie kontrolki; opisy funkcji po angielsku' : 'English controls; feature descriptions remain English';
  }
}
