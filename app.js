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
  updateDoc,
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

enableIndexedDbPersistence(db).catch(() => {});

// ─── State ────────────────────────────────────────────────────────────────────

let currentUser     = null;
let allEntries      = [];
let unsubscribeSnap = null;

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
  return formatFullDate(dateStr);
}

function formatFullDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}

// ─── Qualifier helpers ────────────────────────────────────────────────────────

const QUALIFIERS = [
  { value: 'sugar-free',  label: 'Sugar-free'  },
  { value: 'gluten-free', label: 'Gluten-free' },
  { value: 'whole-grain', label: 'Whole grain' },
  { value: 'spelt',       label: 'Spelt'       },
];

function qualifierLabel(value) {
  return QUALIFIERS.find(q => q.value === value)?.label ?? value;
}

// Handle old entries that stored qualifier as a string
function toQualArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}

// ─── Qualifier multi-select factory ──────────────────────────────────────────
// Builds the dropdown inside wrapEl and returns { getValues, setValues, reset }.

function createQualifierSelect(wrapEl) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'input input-qualifier qualifier-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');

  const labelSpan = document.createElement('span');
  labelSpan.className = 'qualifier-label';
  btn.appendChild(labelSpan);

  // Arrow SVG
  btn.insertAdjacentHTML('beforeend',
    `<svg class="select-arrow" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
       <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
     </svg>`);

  const dropdown = document.createElement('div');
  dropdown.className = 'qualifier-dropdown hidden';
  dropdown.setAttribute('role', 'listbox');
  dropdown.setAttribute('aria-multiselectable', 'true');

  QUALIFIERS.forEach(({ value, label }) => {
    const lbl = document.createElement('label');
    lbl.className = 'qualifier-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    cb.addEventListener('change', syncLabel);
    lbl.appendChild(cb);
    lbl.append(' ' + label);
    dropdown.appendChild(lbl);
  });

  wrapEl.appendChild(btn);
  wrapEl.appendChild(dropdown);

  function syncLabel() {
    const vals = getValues();
    if (vals.length) {
      labelSpan.textContent = vals.map(qualifierLabel).join(', ');
      labelSpan.style.color = '';
    } else {
      labelSpan.textContent = '— Qualifier —';
      labelSpan.style.color = 'var(--text-dim)';
    }
  }

  function getValues() {
    return Array.from(dropdown.querySelectorAll('input:checked')).map(cb => cb.value);
  }

  function setValues(vals) {
    dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = vals.includes(cb.value);
    });
    syncLabel();
  }

  function reset() { setValues([]); }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden', isOpen);
    btn.setAttribute('aria-expanded', String(!isOpen));
  });

  // Prevent clicks inside dropdown from bubbling to the outside-click handler
  dropdown.addEventListener('mousedown', e => e.stopPropagation());

  syncLabel(); // set initial placeholder
  return { getValues, setValues, reset };
}

// ─── Food history for autocomplete ───────────────────────────────────────────

function getFoodHistory(queryStr) {
  const seen = new Map();
  for (let i = allEntries.length - 1; i >= 0; i--) {
    const e = allEntries[i];
    const key = e.name.toLowerCase();
    if (!seen.has(key)) seen.set(key, e);
  }
  let results = Array.from(seen.values());
  if (queryStr) {
    const q = queryStr.toLowerCase();
    results = results.filter(e => e.name.toLowerCase().includes(q));
  }
  return results.slice(0, 8);
}

// ─── Autocomplete factory ─────────────────────────────────────────────────────

function createAutocomplete(inputEl, listEl, onApply) {
  let focusIdx = -1;

  function buildList(queryStr) {
    const results = getFoodHistory(queryStr);
    if (!results.length) { hide(); return; }

    listEl.innerHTML = '';
    results.forEach((entry) => {
      const li = document.createElement('li');
      li.className = 'suggestion-item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');

      const nameSpan = document.createElement('span');
      nameSpan.textContent = entry.name;
      li.appendChild(nameSpan);

      const meta = document.createElement('span');
      meta.className = 'suggestion-meta';
      toQualArray(entry.qualifier).forEach(qv => {
        const q = document.createElement('span');
        q.className = 'suggestion-qualifier';
        q.textContent = qualifierLabel(qv);
        meta.appendChild(q);
      });
      if (entry.kcal != null) {
        const k = document.createElement('span');
        k.className = 'suggestion-kcal';
        k.textContent = formatKcal(entry.kcal);
        meta.appendChild(k);
      }
      if (meta.children.length) li.appendChild(meta);

      li.addEventListener('mousedown', e => { e.preventDefault(); onApply(entry); hide(); });
      listEl.appendChild(li);
    });

    focusIdx = -1;
    listEl.classList.remove('hidden');
  }

  function hide() {
    listEl.classList.add('hidden');
    focusIdx = -1;
  }

  function moveFocus(delta) {
    const items = listEl.querySelectorAll('.suggestion-item');
    if (!items.length) return;
    focusIdx = Math.max(-1, Math.min(items.length - 1, focusIdx + delta));
    items.forEach((item, i) => item.setAttribute('aria-selected', i === focusIdx ? 'true' : 'false'));
  }

  // Only show suggestions after 3 characters
  inputEl.addEventListener('input', () => {
    const val = inputEl.value.trim();
    if (val.length >= 3) buildList(val); else hide();
  });
  inputEl.addEventListener('focus', () => {
    const val = inputEl.value.trim();
    if (val.length >= 3) buildList(val);
  });

  inputEl.addEventListener('keydown', e => {
    if (listEl.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(+1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
    else if (e.key === 'Enter') {
      if (focusIdx >= 0) {
        e.preventDefault();
        listEl.querySelectorAll('.suggestion-item')[focusIdx]
          ?.dispatchEvent(new MouseEvent('mousedown'));
      }
    } else if (e.key === 'Escape') { hide(); }
  });

  return { hide };
}

// Close suggestions and qualifier dropdowns on outside click
document.addEventListener('mousedown', e => {
  if (!e.target.closest('.autocomplete-wrap')) {
    document.querySelectorAll('.suggestions').forEach(el => el.classList.add('hidden'));
  }
  if (!e.target.closest('.qualifier-wrap')) {
    document.querySelectorAll('.qualifier-dropdown').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.qualifier-btn').forEach(el => el.setAttribute('aria-expanded', 'false'));
  }
});

// ─── Shared entry submission ──────────────────────────────────────────────────

async function submitEntry(date, { qty, qualSel, foodName, ac }) {
  if (!currentUser) return;

  const name = foodName.value.trim();
  if (!name) { shake(foodName); foodName.focus(); return; }

  const entry = {
    date,
    timestamp: Date.now(),
    quantity:  qty.value.trim(),
    qualifier: qualSel.getValues(),
    name,
  };

  // Reset before async write — feels instant
  qty.value = foodName.value = '';
  qualSel.reset();
  ac.hide();
  foodName.focus();

  try {
    await addDoc(collection(db, 'users', currentUser.uid, 'entries'), entry);
  } catch (err) {
    console.error('Failed to add entry:', err);
  }
}

// ─── DOM references ───────────────────────────────────────────────────────────

const $qty              = document.getElementById('qty');
const $qualifierWrap    = document.getElementById('qualifier-wrap');
const $foodName         = document.getElementById('food-name');
const $addBtn           = document.getElementById('add-btn');
const $suggestions      = document.getElementById('suggestions');
const $entriesList      = document.getElementById('entries-list');
const $viewLog          = document.getElementById('view-log');
const $viewCal          = document.getElementById('view-calendar');
const $calGrid          = document.getElementById('cal-grid');
const $calLabel         = document.getElementById('cal-month-label');
const $calEntries       = document.getElementById('cal-entries');

const $calAddSection    = document.getElementById('cal-add-section');
const $calForDate       = document.getElementById('cal-for-date');
const $calQty           = document.getElementById('cal-qty');
const $calQualifierWrap = document.getElementById('cal-qualifier-wrap');
const $calFoodName      = document.getElementById('cal-food-name');
const $calAddBtn        = document.getElementById('cal-add-btn');
const $calSuggestions   = document.getElementById('cal-suggestions');

const $authScreen = document.getElementById('auth-screen');
const $signInBtn  = document.getElementById('sign-in-btn');
const $signOutBtn = document.getElementById('sign-out-btn');
const $userChip   = document.getElementById('user-chip');
const $userAvatar = document.getElementById('user-avatar');
const $userName   = document.getElementById('user-name');

// ─── Wire log form ────────────────────────────────────────────────────────────

const logQualSel = createQualifierSelect($qualifierWrap);

const logAC = createAutocomplete($foodName, $suggestions, entry => {
  $foodName.value = entry.name;
  logQualSel.setValues(toQualArray(entry.qualifier));
});

const logEls = { qty: $qty, qualSel: logQualSel, foodName: $foodName, ac: logAC };

$addBtn.addEventListener('click', () => submitEntry(localDateStr(), logEls));
$foodName.addEventListener('keydown', e => {
  if (e.key === 'Enter' && $suggestions.classList.contains('hidden')) {
    e.preventDefault(); submitEntry(localDateStr(), logEls);
  }
});

// ─── Wire calendar form ───────────────────────────────────────────────────────

const calQualSel = createQualifierSelect($calQualifierWrap);

const calAC = createAutocomplete($calFoodName, $calSuggestions, entry => {
  $calFoodName.value = entry.name;
  calQualSel.setValues(toQualArray(entry.qualifier));
});

const calEls = { qty: $calQty, qualSel: calQualSel, foodName: $calFoodName, ac: calAC };

$calAddBtn.addEventListener('click', () => submitEntry(selectedDate, calEls));
$calFoodName.addEventListener('keydown', e => {
  if (e.key === 'Enter' && $calSuggestions.classList.contains('hidden')) {
    e.preventDefault(); submitEntry(selectedDate, calEls);
  }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    $authScreen.classList.add('hidden');
    $userChip.classList.remove('hidden');
    $userAvatar.src = user.photoURL || '';
    $userAvatar.style.display = user.photoURL ? '' : 'none';
    $userName.textContent = user.displayName || user.email || '';
    subscribeToEntries(user.uid);
  } else {
    $authScreen.classList.remove('hidden');
    $userChip.classList.add('hidden');
    if (unsubscribeSnap) { unsubscribeSnap(); unsubscribeSnap = null; }
    allEntries = [];
  }
});

$signInBtn.addEventListener('click', () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch(err => console.error('Sign-in failed:', err.message));
});
$signOutBtn.addEventListener('click', () => signOut(auth));

// ─── Firestore subscription ───────────────────────────────────────────────────

function subscribeToEntries(uid) {
  if (unsubscribeSnap) unsubscribeSnap();
  const q = query(collection(db, 'users', uid, 'entries'), orderBy('timestamp'));
  unsubscribeSnap = onSnapshot(q, snapshot => {
    allEntries = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLogView();
    if ($viewCal.style.display !== 'none') renderCalendar();
  }, err => console.error('Firestore read error:', err));
}

// ─── Delete / update entry ────────────────────────────────────────────────────

async function deleteEntry(id) {
  if (!currentUser) return;
  try {
    await deleteDoc(doc(db, 'users', currentUser.uid, 'entries', id));
  } catch (err) {
    console.error('Failed to delete entry:', err);
  }
}

async function saveEntryEdit(id, data) {
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, 'users', currentUser.uid, 'entries', id), data);
  } catch (err) {
    console.error('Failed to update entry:', err);
  }
}

// ─── Inline edit form ─────────────────────────────────────────────────────────

function showEditForm(div, entry) {
  div.innerHTML = '';
  div.classList.add('entry-editing');

  const qtyInput = document.createElement('input');
  qtyInput.type = 'text';
  qtyInput.className = 'input input-qty';
  qtyInput.value = entry.quantity || '';
  qtyInput.placeholder = 'Qty';
  div.appendChild(qtyInput);

  const qualWrap = document.createElement('div');
  qualWrap.className = 'qualifier-wrap';
  div.appendChild(qualWrap);
  const editQualSel = createQualifierSelect(qualWrap);
  editQualSel.setValues(toQualArray(entry.qualifier));

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'input input-name';
  nameInput.value = entry.name;
  nameInput.placeholder = 'Food name';
  div.appendChild(nameInput);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn-primary entry-save-btn';
  saveBtn.textContent = 'Save';
  div.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'entry-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  div.appendChild(cancelBtn);

  async function save() {
    const name = nameInput.value.trim();
    if (!name) { shake(nameInput); return; }
    saveBtn.disabled = cancelBtn.disabled = true;
    await saveEntryEdit(entry.id, {
      quantity:  qtyInput.value.trim(),
      qualifier: editQualSel.getValues(),
      name,
    });
    // onSnapshot will re-render automatically
  }

  saveBtn.addEventListener('click', save);

  cancelBtn.addEventListener('click', () => {
    div.classList.remove('entry-editing');
    const current = allEntries.find(e => e.id === entry.id) || entry;
    div.replaceWith(renderEntryRow(current));
  });

  nameInput.focus();
  nameInput.select();
}

// ─── Render entry row ─────────────────────────────────────────────────────────

function renderEntryRow(entry) {
  const div = document.createElement('div');
  div.className = 'entry';

  const qty = document.createElement('span');
  qty.className = 'entry-qty';
  qty.textContent = entry.quantity || '—';
  div.appendChild(qty);

  toQualArray(entry.qualifier).forEach(qv => {
    const q = document.createElement('span');
    q.className = 'entry-qualifier';
    q.textContent = qualifierLabel(qv);
    div.appendChild(q);
  });

  const name = document.createElement('span');
  name.className = 'entry-name';
  name.title = entry.name;
  name.textContent = entry.name;
  div.appendChild(name);

  const edit = document.createElement('button');
  edit.className = 'entry-edit';
  edit.setAttribute('aria-label', 'Edit ' + entry.name);
  edit.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <path d="M8.5 2l2.5 2.5-7 7H1.5V9L8.5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
  </svg>`;
  edit.addEventListener('click', () => showEditForm(div, entry));
  div.appendChild(edit);

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

// ─── Render log view (today only) ─────────────────────────────────────────────

function renderLogView() {
  const todayEntries = allEntries.filter(e => e.date === localDateStr());

  $entriesList.innerHTML = '';

  if (!todayEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect x="4" y="8" width="24" height="20" rx="3" stroke="currentColor" stroke-width="1.5"/>
        <path d="M4 14h24" stroke="currentColor" stroke-width="1.5"/>
        <path d="M10 4v4M22 4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M11 20h10M11 24h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span>Nothing logged today yet.</span>`;
    $entriesList.appendChild(empty);
    return;
  }

  for (const entry of todayEntries) $entriesList.appendChild(renderEntryRow(entry));
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

let calYear      = new Date().getFullYear();
let calMonth     = new Date().getMonth();
let selectedDate = null;

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function renderCalendar() {
  $calLabel.textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;

  const entryDates    = new Set(allEntries.map(e => e.date));
  const today         = localDateStr();
  const firstDow      = new Date(calYear, calMonth, 1).getDay();
  const startOffset   = (firstDow + 6) % 7;
  const daysInMonth   = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrevMon = new Date(calYear, calMonth, 0).getDate();
  const totalCells    = Math.ceil((startOffset + daysInMonth) / 7) * 7;

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
    $calForDate.textContent = formatFullDate(selectedDate);
    $calAddSection.classList.remove('hidden');
    renderCalEntries(selectedDate);
  } else {
    $calAddSection.classList.add('hidden');
    $calEntries.innerHTML = '<div class="empty-state"><span>Select a day to see its entries.</span></div>';
  }
}

function renderCalEntries(dateStr) {
  const dayEntries = allEntries.filter(e => e.date === dateStr);

  $calEntries.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'date-label';
  label.textContent = formatDateLabel(dateStr);

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
    $viewLog.style.display = view === 'log'      ? '' : 'none';
    $viewCal.style.display = view === 'calendar' ? '' : 'none';

    if (view === 'calendar') {
      if (!selectedDate) selectedDate = localDateStr();
      renderCalendar();
    }
  });
});
