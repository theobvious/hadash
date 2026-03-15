// ─── Firebase SDK (ESM via CDN — no build step needed) ───────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  collection,
  addDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
  onSnapshot,
  enableIndexedDbPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';

// ─── Init ─────────────────────────────────────────────────────────────────────

const firebaseApp = initializeApp(firebaseConfig);
const auth        = getAuth(firebaseApp);
const db          = getFirestore(firebaseApp);

// Offline-first: cache writes locally when offline, sync when back online
enableIndexedDbPersistence(db).catch(() => {
  // Multi-tab or Safari private mode — silently fall back to memory cache
});

// ─── State ────────────────────────────────────────────────────────────────────

let currentUser       = null;
let allEntries        = [];      // in-memory, kept in sync by onSnapshot
let unsubscribeSnap   = null;   // cleanup handle for Firestore listener

// ─── Utils ────────────────────────────────────────────────────────────────────

function localDateStr(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatDateLabel(dateStr) {
  const today = localDateStr();
  if (dateStr === today) return 'Today';

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === localDateStr(yesterday)) return 'Yesterday';

  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function formatKcal(n) {
  return n != null ? n + '\u202fkcal' : '';
}

// ─── Food history for autocomplete ───────────────────────────────────────────

function getFoodHistory(query) {
  const seen = new Map();
  for (let i = allEntries.length - 1; i >= 0; i--) {
    const e = allEntries[i];
    const key = e.name.toLowerCase();
    if (!seen.has(key)) seen.set(key, e);
  }

  let results = Array.from(seen.values());
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(e => e.name.toLowerCase().includes(q));
  }
  return results.slice(0, 8);
}

// ─── DOM references ───────────────────────────────────────────────────────────

const $qty         = document.getElementById('qty');
const $qualifier   = document.getElementById('qualifier');
const $foodName    = document.getElementById('food-name');
const $kcal        = document.getElementById('kcal');
const $addBtn      = document.getElementById('add-btn');
const $suggestions = document.getElementById('suggestions');
const $entriesList = document.getElementById('entries-list');
const $viewLog     = document.getElementById('view-log');
const $viewCal     = document.getElementById('view-calendar');
const $calGrid     = document.getElementById('cal-grid');
const $calLabel    = document.getElementById('cal-month-label');
const $calEntries  = document.getElementById('cal-entries');

const $authScreen  = document.getElementById('auth-screen');
const $signInBtn   = document.getElementById('sign-in-btn');
const $signOutBtn  = document.getElementById('sign-out-btn');
const $userChip    = document.getElementById('user-chip');
const $userAvatar  = document.getElementById('user-avatar');
const $userName    = document.getElementById('user-name');

// ─── Auth ─────────────────────────────────────────────────────────────────────

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    showApp(user);
    subscribeToEntries(user.uid);
  } else {
    showAuthScreen();
    if (unsubscribeSnap) { unsubscribeSnap(); unsubscribeSnap = null; }
    allEntries = [];
  }
});

function showApp(user) {
  $authScreen.classList.add('hidden');
  $userChip.classList.remove('hidden');
  $userAvatar.src  = user.photoURL  || '';
  $userAvatar.style.display = user.photoURL ? '' : 'none';
  $userName.textContent = user.displayName || user.email || '';
}

function showAuthScreen() {
  $authScreen.classList.remove('hidden');
  $userChip.classList.add('hidden');
}

$signInBtn.addEventListener('click', () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch(err => {
    console.error('Sign-in failed:', err.message);
  });
});

$signOutBtn.addEventListener('click', () => {
  signOut(auth);
});

// ─── Firestore subscription ───────────────────────────────────────────────────

function subscribeToEntries(uid) {
  if (unsubscribeSnap) unsubscribeSnap();

  const q = query(
    collection(db, 'users', uid, 'entries'),
    orderBy('timestamp'),
  );

  unsubscribeSnap = onSnapshot(q, snapshot => {
    allEntries = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLogView();
    if (!$viewCal.classList.contains('hidden')) renderCalendar();
  }, err => {
    console.error('Firestore read error:', err);
  });
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

let focusIdx = -1;

function showSuggestions(queryStr) {
  const results = getFoodHistory(queryStr);
  if (!results.length) { hideSuggestions(); return; }

  $suggestions.innerHTML = '';

  results.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = 'suggestion-item';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.idx = i;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = entry.name;
    li.appendChild(nameSpan);

    const meta = document.createElement('span');
    meta.className = 'suggestion-meta';

    if (entry.qualifier) {
      const q = document.createElement('span');
      q.className = 'suggestion-qualifier';
      q.textContent = entry.qualifier;
      meta.appendChild(q);
    }
    if (entry.kcal != null) {
      const k = document.createElement('span');
      k.className = 'suggestion-kcal';
      k.textContent = formatKcal(entry.kcal);
      meta.appendChild(k);
    }
    if (meta.children.length) li.appendChild(meta);

    li.addEventListener('mousedown', e => {
      e.preventDefault();
      applySuggestion(entry);
    });

    $suggestions.appendChild(li);
  });

  focusIdx = -1;
  $suggestions.classList.remove('hidden');
}

function hideSuggestions() {
  $suggestions.classList.add('hidden');
  focusIdx = -1;
}

function applySuggestion(entry) {
  $foodName.value  = entry.name;
  if (entry.kcal      != null) $kcal.value      = entry.kcal;
  if (entry.qualifier)         $qualifier.value  = entry.qualifier;
  hideSuggestions();
  $kcal.focus();
}

function moveFocus(delta) {
  const items = $suggestions.querySelectorAll('.suggestion-item');
  if (!items.length) return;
  focusIdx = Math.max(-1, Math.min(items.length - 1, focusIdx + delta));
  items.forEach((item, i) => item.setAttribute('aria-selected', i === focusIdx ? 'true' : 'false'));
}

$foodName.addEventListener('input', () => showSuggestions($foodName.value.trim()));
$foodName.addEventListener('focus', () => showSuggestions($foodName.value.trim()));

$foodName.addEventListener('keydown', e => {
  if ($suggestions.classList.contains('hidden')) {
    if (e.key === 'Enter') { e.preventDefault(); addEntry(); }
    return;
  }
  if (e.key === 'ArrowDown')  { e.preventDefault(); moveFocus(+1); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); moveFocus(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (focusIdx >= 0) {
      $suggestions.querySelectorAll('.suggestion-item')[focusIdx]
        ?.dispatchEvent(new MouseEvent('mousedown'));
    } else {
      hideSuggestions();
      addEntry();
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

document.addEventListener('mousedown', e => {
  if (!e.target.closest('.autocomplete-wrap')) hideSuggestions();
});

// ─── Add entry ────────────────────────────────────────────────────────────────

$addBtn.addEventListener('click', addEntry);
$kcal.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } });

async function addEntry() {
  if (!currentUser) return;

  const name = $foodName.value.trim();
  if (!name) {
    $foodName.classList.remove('shake');
    void $foodName.offsetWidth;
    $foodName.classList.add('shake');
    $foodName.focus();
    $foodName.addEventListener('animationend', () => $foodName.classList.remove('shake'), { once: true });
    return;
  }

  const entry = {
    date:      localDateStr(),
    timestamp: Date.now(),
    quantity:  $qty.value.trim(),
    qualifier: $qualifier.value,
    name,
    kcal:      $kcal.value !== '' ? parseInt($kcal.value, 10) : null,
  };

  // Reset form before the async write so it feels instant
  $qty.value = '';
  $qualifier.value = '';
  $foodName.value = '';
  $kcal.value = '';
  hideSuggestions();
  $foodName.focus();

  try {
    await addDoc(collection(db, 'users', currentUser.uid, 'entries'), entry);
    // onSnapshot re-renders automatically
  } catch (err) {
    console.error('Failed to add entry:', err);
  }
}

// ─── Delete entry ─────────────────────────────────────────────────────────────

async function deleteEntry(id) {
  if (!currentUser) return;
  try {
    await deleteDoc(doc(db, 'users', currentUser.uid, 'entries', id));
    // onSnapshot re-renders automatically
  } catch (err) {
    console.error('Failed to delete entry:', err);
  }
}

// ─── Render entry row ─────────────────────────────────────────────────────────

function renderEntryRow(entry) {
  const div = document.createElement('div');
  div.className = 'entry';
  div.dataset.id = entry.id;

  const qty = document.createElement('span');
  qty.className = 'entry-qty';
  qty.textContent = entry.quantity || '—';
  div.appendChild(qty);

  if (entry.qualifier) {
    const q = document.createElement('span');
    q.className = 'entry-qualifier';
    q.textContent = entry.qualifier;
    div.appendChild(q);
  }

  const name = document.createElement('span');
  name.className = 'entry-name';
  name.title = entry.name;
  name.textContent = entry.name;
  div.appendChild(name);

  const kcal = document.createElement('span');
  kcal.className = 'entry-kcal';
  kcal.textContent = formatKcal(entry.kcal);
  div.appendChild(kcal);

  const del = document.createElement('button');
  del.className = 'entry-delete';
  del.setAttribute('aria-label', 'Delete ' + entry.name);
  del.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <path d="M1.5 1.5l10 10M11.5 1.5l-10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  del.addEventListener('click', () => deleteEntry(entry.id));
  div.appendChild(del);

  return div;
}

// ─── Render log view ──────────────────────────────────────────────────────────

function renderLogView() {
  if (!allEntries.length) {
    $entriesList.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect x="4" y="8" width="24" height="20" rx="3" stroke="currentColor" stroke-width="1.5"/>
        <path d="M4 14h24" stroke="currentColor" stroke-width="1.5"/>
        <path d="M10 4v4M22 4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M11 20h10M11 24h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span>No entries yet. Add your first food above.</span>`;
    $entriesList.appendChild(empty);
    return;
  }

  // Group by date, newest date first
  const groups = new Map();
  for (const e of allEntries) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }
  const sortedDates = [...groups.keys()].sort((a, b) => b.localeCompare(a));

  $entriesList.innerHTML = '';

  for (const date of sortedDates) {
    const dayEntries = groups.get(date);
    const group = document.createElement('div');
    group.className = 'date-group';

    const label = document.createElement('div');
    label.className = 'date-label';
    label.textContent = formatDateLabel(date);

    const totalKcal  = dayEntries.reduce((s, e) => s + (e.kcal || 0), 0);
    const hasAnyKcal = dayEntries.some(e => e.kcal != null);
    if (hasAnyKcal && totalKcal > 0) {
      const summary = document.createElement('span');
      summary.className = 'day-summary';
      summary.textContent = totalKcal + '\u202fkcal total';
      label.appendChild(summary);
    }

    group.appendChild(label);
    for (const entry of dayEntries) group.appendChild(renderEntryRow(entry));
    $entriesList.appendChild(group);
  }
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

let calYear     = new Date().getFullYear();
let calMonth    = new Date().getMonth();
let selectedDate = null;

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function renderCalendar() {
  $calLabel.textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;

  const entryDates = new Set(allEntries.map(e => e.date));
  const today      = localDateStr();
  const firstDow   = new Date(calYear, calMonth, 1).getDay();
  const startOffset  = (firstDow + 6) % 7;
  const daysInMonth  = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrevMon = new Date(calYear, calMonth, 0).getDate();
  const totalCells   = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  $calGrid.innerHTML = '';

  for (let i = 0; i < totalCells; i++) {
    let day, dateStr, otherMonth;

    if (i < startOffset) {
      day = daysInPrevMon - startOffset + 1 + i;
      const y = calMonth === 0 ? calYear - 1 : calYear;
      const m = calMonth === 0 ? 12 : calMonth;
      dateStr = `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      otherMonth = true;
    } else if (i < startOffset + daysInMonth) {
      day = i - startOffset + 1;
      dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      otherMonth = false;
    } else {
      day = i - startOffset - daysInMonth + 1;
      const y = calMonth === 11 ? calYear + 1 : calYear;
      const m = calMonth === 11 ? 1 : calMonth + 2;
      dateStr = `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      otherMonth = true;
    }

    const cell = document.createElement('div');
    cell.className = 'cal-day';
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', dateStr);
    cell.textContent = day;
    cell.dataset.date = dateStr;

    if (otherMonth)               cell.classList.add('other-month');
    if (dateStr === today)        cell.classList.add('today');
    if (entryDates.has(dateStr))  cell.classList.add('has-entries');
    if (dateStr === selectedDate) cell.classList.add('selected');

    cell.addEventListener('click', () => {
      selectedDate = dateStr;
      renderCalendar();
    });

    $calGrid.appendChild(cell);
  }

  if (selectedDate) {
    renderCalEntries(selectedDate);
  } else {
    $calEntries.innerHTML = '<div class="empty-state"><span>Select a day to see its entries.</span></div>';
  }
}

function renderCalEntries(dateStr) {
  const dayEntries = allEntries.filter(e => e.date === dateStr);

  $calEntries.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'date-label';
  label.textContent = formatDateLabel(dateStr);

  const totalKcal  = dayEntries.reduce((s, e) => s + (e.kcal || 0), 0);
  const hasAnyKcal = dayEntries.some(e => e.kcal != null);
  if (hasAnyKcal && totalKcal > 0) {
    const summary = document.createElement('span');
    summary.className = 'day-summary';
    summary.textContent = totalKcal + '\u202fkcal total';
    label.appendChild(summary);
  }

  $calEntries.appendChild(label);

  if (!dayEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<span>No entries for this day.</span>';
    $calEntries.appendChild(empty);
    return;
  }

  for (const entry of dayEntries) $calEntries.appendChild(renderEntryRow(entry));
}

document.getElementById('prev-month').addEventListener('click', () => {
  if (--calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});

document.getElementById('next-month').addEventListener('click', () => {
  if (++calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
});

// ─── View toggle ──────────────────────────────────────────────────────────────

document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');

    const view = btn.dataset.view;
    $viewLog.classList.toggle('hidden', view !== 'log');
    $viewCal.classList.toggle('hidden', view !== 'calendar');

    if (view === 'calendar') {
      if (!selectedDate) selectedDate = localDateStr();
      renderCalendar();
    }
  });
});
