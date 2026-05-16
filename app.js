// ==========================================
// Watchlist — lógica de la aplicación
// ==========================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY, TMDB_API_KEY } from './config.js';

// ---- Configuración de plataformas ----
const PLATFORMS = [
  { id: 'netflix',     name: 'Netflix',      color: 'var(--p-netflix)' },
  { id: 'hbo',         name: 'HBO Max',      color: 'var(--p-hbo)' },
  { id: 'disney',      name: 'Disney+',      color: 'var(--p-disney)' },
  { id: 'apple',       name: 'Apple TV+',    color: 'var(--p-apple)' },
  { id: 'skyshowtime', name: 'SkyShowtime',  color: 'var(--p-skyshowtime)' },
  { id: 'prime',       name: 'Prime Video',  color: 'var(--p-prime)' },
  { id: 'movistar',    name: 'Movistar+',    color: 'var(--p-movistar)' },
  { id: 'plex',        name: 'Plex',         color: 'var(--p-plex)' },
];
const PLATFORM_MAP = Object.fromEntries(PLATFORMS.map(p => [p.id, p]));

// ---- Géneros ----
// Lista canónica unificada. Cualquier género que se guarde en BBDD debe estar aquí.
const GENRES = [
  'Acción','Animación','Aventura','Bélica','Ciencia ficción','Comedia',
  'Crimen','Documental','Drama','Familia','Fantasía','Historia',
  'Misterio','Música','Romance','Suspense','Terror','Western',
];

// Mapeo de IDs de TMDB a nuestros géneros canónicos. Un ID puede mapearse a 1 o 2.
const TMDB_MOVIE_GENRES = {
  28:    ['Acción'],
  12:    ['Aventura'],
  16:    ['Animación'],
  35:    ['Comedia'],
  80:    ['Crimen'],
  99:    ['Documental'],
  18:    ['Drama'],
  10751: ['Familia'],
  14:    ['Fantasía'],
  36:    ['Historia'],
  27:    ['Terror'],
  10402: ['Música'],
  9648:  ['Misterio'],
  10749: ['Romance'],
  878:   ['Ciencia ficción'],
  53:    ['Suspense'],
  10752: ['Bélica'],
  37:    ['Western'],
  // 10770 "Película de TV" descartado
};

const TMDB_TV_GENRES = {
  10759: ['Acción', 'Aventura'],            // Action & Adventure -> ambos
  16:    ['Animación'],
  35:    ['Comedia'],
  80:    ['Crimen'],
  99:    ['Documental'],
  18:    ['Drama'],
  10751: ['Familia'],
  10762: ['Familia'],                       // Kids -> Familia
  9648:  ['Misterio'],
  10765: ['Ciencia ficción', 'Fantasía'],   // Sci-Fi & Fantasy -> ambos
  10768: ['Bélica'],                        // War & Politics -> Bélica
  37:    ['Western'],
  // News, Reality, Soap, Talk: descartados por no aplicar a una watchlist
};

function mapTMDBGenres(genreIds, mediaType) {
  if (!genreIds || genreIds.length === 0) return [];
  const map = mediaType === 'movie' ? TMDB_MOVIE_GENRES : TMDB_TV_GENRES;
  const result = new Set();
  for (const id of genreIds) {
    const names = map[id];
    if (names) names.forEach(n => result.add(n));
  }
  return Array.from(result);
}

// ---- Comprobación de configuración ----
const CONFIG_OK =
  SUPABASE_URL && !SUPABASE_URL.includes('TU_') &&
  SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes('TU_') &&
  TMDB_API_KEY && !TMDB_API_KEY.includes('TU_');

if (!CONFIG_OK) {
  document.getElementById('config-error').hidden = false;
}

// ---- Cliente Supabase ----
const supabase = CONFIG_OK ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ---- TMDB ----
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p/w300';

async function searchTMDB(query) {
  const url = `${TMDB_BASE}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=es-ES&include_adult=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Error consultando TMDB');
  const data = await res.json();
  return data.results
    .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
    .filter(r => r.poster_path)                       // sin póster, fuera
    .filter(r => r.release_date || r.first_air_date)  // sin año, fuera
    .slice(0, 12);
}

function normalizeTMDBItem(r) {
  const date = r.release_date || r.first_air_date;
  return {
    tmdb_id:      r.id,
    type:         r.media_type,
    title:        r.title || r.name,
    poster_path:  r.poster_path,
    year:         date ? parseInt(date.slice(0, 4), 10) : null,
    genres:       mapTMDBGenres(r.genre_ids, r.media_type),
  };
}

// Obtiene los detalles de una serie, incluyendo el array de temporadas
async function fetchTVDetails(tmdbId) {
  const url = `${TMDB_BASE}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-ES`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Error consultando TMDB');
  return res.json();
}

// Devuelve un array de temporadas válidas { number, year, episodeCount }
// descartando especiales (season 0) y temporadas sin fecha de estreno
function normalizeSeasons(tvDetails) {
  if (!tvDetails?.seasons) return [];
  return tvDetails.seasons
    .filter(s => s.season_number > 0)
    .filter(s => s.air_date)
    .map(s => ({
      number:       s.season_number,
      year:         parseInt(s.air_date.slice(0, 4), 10),
      episodeCount: s.episode_count,
    }))
    .sort((a, b) => a.number - b.number);
}

// ---- Estado de la UI ----
const state = {
  items: [],
  typeFilter: 'all',          // 'all' | 'movie' | 'tv'
  platformFilters: new Set(), // Set<string>
  genreFilters: new Set(),    // Set<string>
  showWatched: false,
  sortBy: 'added_desc',       // 'added_desc' | 'year_desc' | 'year_asc'
  viewMode: 'grid',           // 'grid' | 'list'
  pendingItem: null,          // item del modal
};

// ---- Referencias del DOM ----
const $ = id => document.getElementById(id);
const els = {
  searchInput:      $('search-input'),
  searchStatus:     $('search-status'),
  searchResults:    $('search-results'),
  typeFilters:      document.querySelectorAll('.type-filters .chip'),
  platformFilters:  $('platform-filters'),
  genreFilters:     $('genre-filters'),
  showWatched:      $('show-watched'),
  sortSelect:       $('sort-select'),
  viewButtons:      document.querySelectorAll('.view-btn'),
  grid:             $('watchlist-grid'),
  emptyState:       $('empty-state'),
  loadingState:     $('loading-state'),
  listCount:        $('list-count'),
  dialog:           $('platform-dialog'),
  dialogInfo:       $('dialog-item-info'),
  dialogChecks:     $('platform-checkboxes'),
  dialogSeasonSection: $('season-section'),
  dialogSeasonOptions: $('season-options'),
  dialogSave:       $('dialog-save'),
  dialogCancel:     $('dialog-cancel'),
  dialogClose:      $('dialog-close'),
  // Autenticación
  loginSection:     $('login-section'),
  loginForm:        $('login-form'),
  loginEmail:       $('login-email'),
  loginPassword:    $('login-password'),
  loginError:       $('login-error'),
  loginSubmit:      $('login-submit'),
  appMain:          $('app-main'),
  userBar:          $('user-bar'),
  userEmail:        $('user-email'),
  logoutBtn:        $('logout-btn'),
};

// ---- Render: chips de plataformas para filtrar ----
function renderPlatformFilters() {
  els.platformFilters.innerHTML = PLATFORMS.map(p => `
    <button class="chip platform-chip" data-platform="${p.id}"
            style="--platform-color: ${p.color}">${p.name}</button>
  `).join('');

  els.platformFilters.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.platform;
      if (state.platformFilters.has(id)) state.platformFilters.delete(id);
      else state.platformFilters.add(id);
      chip.classList.toggle('active');
      renderList();
    });
  });
}

// ---- Render: chips dinámicos de géneros (solo los presentes en la lista) ----
function renderGenreFilters() {
  const present = new Set();
  state.items.forEach(item => (item.genres || []).forEach(g => present.add(g)));
  const sorted = Array.from(present).sort((a, b) => a.localeCompare(b, 'es'));

  // Limpiar filtros activos que ya no tengan items
  for (const active of state.genreFilters) {
    if (!present.has(active)) state.genreFilters.delete(active);
  }

  if (sorted.length === 0) {
    els.genreFilters.innerHTML = '';
    els.genreFilters.hidden = true;
    return;
  }
  els.genreFilters.hidden = false;
  els.genreFilters.innerHTML = sorted.map(g => `
    <button class="chip genre-chip ${state.genreFilters.has(g) ? 'active' : ''}" data-genre="${escapeHTML(g)}">
      ${escapeHTML(g)}
    </button>
  `).join('');

  els.genreFilters.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const g = chip.dataset.genre;
      if (state.genreFilters.has(g)) state.genreFilters.delete(g);
      else state.genreFilters.add(g);
      chip.classList.toggle('active');
      renderList();
    });
  });
}

// ---- Render: lista de watchlist ----
function renderList() {
  const filtered = state.items.filter(item => {
    if (state.typeFilter !== 'all' && item.type !== state.typeFilter) return false;
    if (!state.showWatched && item.watched) return false;
    if (state.platformFilters.size > 0) {
      const hasAny = item.platforms?.some(p => state.platformFilters.has(p));
      if (!hasAny) return false;
    }
    if (state.genreFilters.size > 0) {
      const hasAny = item.genres?.some(g => state.genreFilters.has(g));
      if (!hasAny) return false;
    }
    return true;
  });

  // Ordenar la lista filtrada según el criterio actual
  filtered.sort((a, b) => {
    switch (state.sortBy) {
      case 'year_desc': return b.year - a.year;
      case 'year_asc':  return a.year - b.year;
      case 'added_desc':
      default:          return new Date(b.added_at) - new Date(a.added_at);
    }
  });

  els.listCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'título' : 'títulos'}`;
  els.loadingState.hidden = true;

  // Aplicar la clase de vista al contenedor
  els.grid.classList.toggle('list-view', state.viewMode === 'list');

  if (filtered.length === 0) {
    els.grid.innerHTML = '';
    els.emptyState.hidden = false;
    els.emptyState.textContent = state.items.length === 0
      ? 'Tu lista está vacía. Busca algo arriba para empezar.'
      : 'Ningún título coincide con los filtros.';
    return;
  }
  els.emptyState.hidden = true;

  els.grid.innerHTML = filtered.map((item, i) => itemCardHTML(item, i)).join('');

  // listeners por tarjeta
  els.grid.querySelectorAll('.item-card').forEach(card => {
    const id = card.dataset.id;
    card.querySelector('.watched-btn').addEventListener('click', () => toggleWatched(id));
    card.querySelector('.delete-btn').addEventListener('click',  () => deleteItem(id));
    card.querySelector('.edit-btn').addEventListener('click',    () => openEditDialog(id));
  });

  renderGenreFilters();
}

function itemCardHTML(item, i) {
  const poster = item.poster_path
    ? `<div class="item-poster" style="background-image: url('${TMDB_IMG}${item.poster_path}')">
         <span class="item-type-badge">${item.type === 'movie' ? 'Película' : 'Serie'}</span>
         <div class="watched-stamp">visto</div>
       </div>`
    : `<div class="item-poster no-image">
         <span class="item-type-badge">${item.type === 'movie' ? 'Película' : 'Serie'}</span>
         <em>?</em>
         <div class="watched-stamp">visto</div>
       </div>`;

  const platformTags = (item.platforms || []).map(pid => {
    const p = PLATFORM_MAP[pid];
    if (!p) return '';
    return `<span class="platform-tag" style="--platform-color: ${p.color}">${p.name}</span>`;
  }).join('');

  const genreLine = (item.genres && item.genres.length)
    ? `<div class="item-genres">${item.genres.map(escapeHTML).join(' · ')}</div>`
    : '';

  const escapedTitle = escapeHTML(item.title);
  const seasonBadge = item.season_number
    ? `<span class="season-badge">T${item.season_number}</span>`
    : '';

  return `
    <div class="item-card ${item.watched ? 'watched' : ''}"
         data-id="${item.id}"
         style="animation-delay: ${Math.min(i * 25, 400)}ms">
      ${poster}
      <div class="item-info">
        <h3 class="item-title">${escapedTitle}${seasonBadge}</h3>
        <div class="item-year">${item.year ?? '—'}</div>
        ${genreLine}
        <div class="item-platforms">${platformTags}</div>
        <div class="item-actions">
          <button class="icon-btn watched-btn" title="${item.watched ? 'Marcar como no visto' : 'Marcar como visto'}">
            ${item.watched ? '↺' : '✓'} <span class="btn-label">${item.watched ? 'No visto' : 'Visto'}</span>
          </button>
          <button class="icon-btn edit-btn" title="Editar plataformas">✎</button>
          <button class="icon-btn delete-btn" title="Eliminar">✕</button>
        </div>
      </div>
    </div>
  `;
}

// ---- Render: resultados de búsqueda ----
function renderSearchResults(results) {
  if (results.length === 0) {
    els.searchResults.innerHTML = `<p style="grid-column:1/-1;color:var(--text-muted);font-style:italic;padding:20px 0;">Sin resultados.</p>`;
    return;
  }
  els.searchResults.innerHTML = results.map(r => {
    const item = normalizeTMDBItem(r);
    return `
      <button class="result-card" data-tmdb-id="${item.tmdb_id}" data-type="${item.type}">
        <div class="result-poster" style="background-image: url('${TMDB_IMG}${item.poster_path}')"></div>
        <div class="result-info">
          <h4 class="result-title">${escapeHTML(item.title)}</h4>
          <div class="result-meta">${item.type === 'movie' ? 'Peli' : 'Serie'} · ${item.year ?? '—'}</div>
        </div>
      </button>
    `;
  }).join('');

  els.searchResults.querySelectorAll('.result-card').forEach((card, idx) => {
    card.addEventListener('click', () => {
      const tmdbItem = normalizeTMDBItem(results[idx]);
      openAddDialog(tmdbItem);
    });
  });
}

// ---- Modal: añadir / editar plataformas ----
async function openAddDialog(item) {
  state.pendingItem = {
    mode: 'add',
    data: item,
    selected: new Set(),
    seasonNumber: null,  // null = "Toda la serie" (también el valor para películas)
    seasonYear:   null,  // se rellenará si elige una temporada concreta
  };
  fillDialog(item, new Set(), null);
  els.dialog.showModal();

  // Si es serie, traemos las temporadas
  if (item.type === 'tv') {
    showSeasonsLoading();
    try {
      const tvDetails = await fetchTVDetails(item.tmdb_id);
      const seasons = normalizeSeasons(tvDetails);
      renderSeasonOptions(seasons, null);
    } catch (err) {
      console.error(err);
      els.dialogSeasonOptions.innerHTML = '<p style="color:var(--text-muted);font-style:italic;">No se pudo cargar la lista de temporadas. Se guardará como "toda la serie".</p>';
    }
  }
}

async function openEditDialog(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  state.pendingItem = {
    mode: 'edit',
    data: item,
    selected: new Set(item.platforms || []),
    seasonNumber: item.season_number,
    seasonYear:   item.year,
  };
  fillDialog(item, new Set(item.platforms || []), item.season_number);
  els.dialog.showModal();

  if (item.type === 'tv') {
    showSeasonsLoading();
    try {
      const tvDetails = await fetchTVDetails(item.tmdb_id);
      const seasons = normalizeSeasons(tvDetails);
      renderSeasonOptions(seasons, item.season_number);
    } catch (err) {
      console.error(err);
      els.dialogSeasonOptions.innerHTML = '<p style="color:var(--text-muted);font-style:italic;">No se pudo cargar la lista de temporadas.</p>';
    }
  }
}

function fillDialog(item, selected, seasonNumber) {
  const subtitle = seasonNumber
    ? `Serie · T${seasonNumber}`
    : item.type === 'movie' ? 'Película' : 'Serie';
  els.dialogInfo.innerHTML = `
    <div class="mini-poster" style="background-image: url('${item.poster_path ? TMDB_IMG + item.poster_path : ''}')"></div>
    <div class="info-text">
      <p class="info-title">${escapeHTML(item.title)}</p>
      <p class="info-meta">${subtitle} · ${item.year ?? '—'}</p>
    </div>
  `;

  els.dialogSeasonSection.hidden = item.type !== 'tv';

  els.dialogChecks.innerHTML = PLATFORMS.map(p => `
    <label class="platform-check ${selected.has(p.id) ? 'checked' : ''}"
           data-platform="${p.id}" style="--platform-color: ${p.color}">
      <span class="dot"></span>
      <input type="checkbox" ${selected.has(p.id) ? 'checked' : ''} />
      <span>${p.name}</span>
    </label>
  `).join('');

  els.dialogChecks.querySelectorAll('.platform-check').forEach(label => {
    label.addEventListener('click', e => {
      e.preventDefault();
      const id = label.dataset.platform;
      if (state.pendingItem.selected.has(id)) state.pendingItem.selected.delete(id);
      else state.pendingItem.selected.add(id);
      label.classList.toggle('checked');
      label.querySelector('input').checked = state.pendingItem.selected.has(id);
    });
  });
}

function showSeasonsLoading() {
  els.dialogSeasonOptions.classList.add('loading');
  els.dialogSeasonOptions.innerHTML = 'Cargando temporadas…';
}

function renderSeasonOptions(seasons, currentSeasonNumber) {
  els.dialogSeasonOptions.classList.remove('loading');

  // Opción "Toda la serie" + cada temporada
  const showYear = state.pendingItem.data.year ?? '—';
  const allShowChecked = currentSeasonNumber == null;

  const rows = [
    `<label class="season-option ${allShowChecked ? 'checked' : ''}" data-season="all">
       <input type="radio" name="season" ${allShowChecked ? 'checked' : ''} />
       <span class="option-radio"></span>
       <span class="option-label">Toda la serie</span>
       <span class="option-year">${showYear}</span>
     </label>`,
    ...seasons.map(s => {
      const checked = s.number === currentSeasonNumber;
      return `<label class="season-option ${checked ? 'checked' : ''}" data-season="${s.number}" data-year="${s.year}">
        <input type="radio" name="season" ${checked ? 'checked' : ''} />
        <span class="option-radio"></span>
        <span class="option-label">Temporada ${s.number}</span>
        <span class="option-year">${s.year}</span>
      </label>`;
    }),
  ];
  els.dialogSeasonOptions.innerHTML = rows.join('');

  els.dialogSeasonOptions.querySelectorAll('.season-option').forEach(label => {
    label.addEventListener('click', e => {
      e.preventDefault();
      const seasonAttr = label.dataset.season;
      const isAll = seasonAttr === 'all';
      state.pendingItem.seasonNumber = isAll ? null : parseInt(seasonAttr, 10);
      state.pendingItem.seasonYear   = isAll ? state.pendingItem.data.year : parseInt(label.dataset.year, 10);

      els.dialogSeasonOptions.querySelectorAll('.season-option').forEach(l => {
        l.classList.remove('checked');
        l.querySelector('input').checked = false;
      });
      label.classList.add('checked');
      label.querySelector('input').checked = true;
    });
  });
}

function closeDialog() {
  els.dialog.close();
  state.pendingItem = null;
}

async function saveDialog() {
  if (!state.pendingItem) return;
  const { mode, data, selected, seasonNumber, seasonYear } = state.pendingItem;
  const platforms = Array.from(selected);

  if (mode === 'add') {
    await addItem({
      ...data,
      platforms,
      season_number: seasonNumber,
      year: seasonYear ?? data.year,
    });
  } else {
    await updateItem(data.id, {
      platforms,
      season_number: seasonNumber,
      year: seasonYear ?? data.year,
    });
  }
  closeDialog();
}

// ---- Autenticación ----
async function initAuth() {
  // Listener para cambios de sesión (login, logout, expiración del token)
  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      showApp(session.user);
    } else {
      showLogin();
    }
  });

  // Comprobación inicial: ¿hay sesión activa guardada en localStorage?
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) showApp(session.user);
  else showLogin();
}

function showLogin() {
  els.loginSection.hidden = false;
  els.appMain.hidden = true;
  els.userBar.hidden = true;
  state.items = [];                    // limpiar la lista por si había otro usuario
}

function showApp(user) {
  els.loginSection.hidden = true;
  els.appMain.hidden = false;
  els.userBar.hidden = false;
  els.userEmail.textContent = user.email;
  loadItems();
}

async function handleLogin(e) {
  e.preventDefault();
  els.loginError.hidden = true;
  els.loginSubmit.disabled = true;
  els.loginSubmit.textContent = 'Entrando…';

  const { error } = await supabase.auth.signInWithPassword({
    email:    els.loginEmail.value.trim(),
    password: els.loginPassword.value,
  });

  els.loginSubmit.disabled = false;
  els.loginSubmit.textContent = 'Entrar';

  if (error) {
    els.loginError.textContent = 'Email o contraseña incorrectos.';
    els.loginError.hidden = false;
    return;
  }
  // Si va bien, onAuthStateChange disparará showApp() automáticamente.
  els.loginPassword.value = '';
}

async function handleLogout() {
  await supabase.auth.signOut();
  // onAuthStateChange disparará showLogin() automáticamente.
}

// ---- Operaciones de base de datos ----
async function loadItems() {
  if (!supabase) { els.loadingState.hidden = true; return; }
  const { data, error } = await supabase
    .from('watchlist_items')
    .select('*')
    .order('added_at', { ascending: false });
  if (error) { console.error(error); return; }
  state.items = data || [];
  renderList();
}

async function addItem(item) {
  if (!supabase) return alert('Configura primero config.js');

  // Comprobación local antes de llamar al servidor (considera la temporada)
  const duplicate = state.items.find(
    i => i.tmdb_id === item.tmdb_id
      && i.type === item.type
      && i.season_number === item.season_number
  );
  if (duplicate) {
    const label = item.season_number ? `${item.title} (T${item.season_number})` : item.title;
    alert(`"${label}" ya está en tu lista.`);
    return;
  }

  const { data, error } = await supabase
    .from('watchlist_items')
    .insert({
      tmdb_id:       item.tmdb_id,
      type:          item.type,
      title:         item.title,
      poster_path:   item.poster_path,
      year:          item.year,
      platforms:     item.platforms,
      genres:        item.genres,
      season_number: item.season_number ?? null,
    })
    .select()
    .single();
  if (error) {
    // 23505 = unique_violation en PostgreSQL (red de seguridad por si el chequeo local falla)
    if (error.code === '23505') {
      const label = item.season_number ? `${item.title} (T${item.season_number})` : item.title;
      alert(`"${label}" ya está en tu lista.`);
    } else {
      alert('Error: ' + error.message);
    }
    return;
  }
  state.items.unshift(data);
  renderList();
  // limpiar búsqueda
  els.searchInput.value = '';
  els.searchResults.innerHTML = '';
}

async function toggleWatched(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  const newValue = !item.watched;
  item.watched = newValue;
  renderList();
  const { error } = await supabase
    .from('watchlist_items')
    .update({ watched: newValue })
    .eq('id', id);
  if (error) { item.watched = !newValue; renderList(); alert('Error: ' + error.message); }
}

async function updateItem(id, updates) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  // Guardar valores anteriores para revertir si falla
  const prev = {};
  for (const k of Object.keys(updates)) prev[k] = item[k];

  Object.assign(item, updates);
  renderList();

  const { error } = await supabase
    .from('watchlist_items')
    .update(updates)
    .eq('id', id);
  if (error) {
    Object.assign(item, prev);
    renderList();
    if (error.code === '23505') {
      alert('Ya tienes esa temporada en tu lista.');
    } else {
      alert('Error: ' + error.message);
    }
  }
}

async function deleteItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  if (!confirm(`¿Eliminar "${item.title}" de la lista?`)) return;
  state.items = state.items.filter(i => i.id !== id);
  renderList();
  const { error } = await supabase
    .from('watchlist_items')
    .delete()
    .eq('id', id);
  if (error) { alert('Error: ' + error.message); loadItems(); }
}

// ---- Búsqueda con debounce ----
let searchTimeout;
function onSearchInput() {
  clearTimeout(searchTimeout);
  const q = els.searchInput.value.trim();
  if (!q) {
    els.searchResults.innerHTML = '';
    els.searchStatus.textContent = '';
    return;
  }
  els.searchStatus.textContent = '…';
  searchTimeout = setTimeout(async () => {
    try {
      const results = await searchTMDB(q);
      els.searchStatus.textContent = '';
      renderSearchResults(results);
    } catch (err) {
      console.error(err);
      els.searchStatus.textContent = 'error';
    }
  }, 350);
}

// ---- Listeners globales ----
function setupListeners() {
  els.searchInput.addEventListener('input', onSearchInput);

  els.typeFilters.forEach(btn => {
    btn.addEventListener('click', () => {
      els.typeFilters.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.typeFilter = btn.dataset.type;
      renderList();
    });
  });

  els.showWatched.addEventListener('change', e => {
    state.showWatched = e.target.checked;
    renderList();
  });

  els.sortSelect.addEventListener('change', e => {
    state.sortBy = e.target.value;
    renderList();
  });

  els.viewButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      els.viewButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderList();
    });
  });

  els.dialogSave.addEventListener('click',   saveDialog);
  els.dialogCancel.addEventListener('click', closeDialog);
  els.dialogClose.addEventListener('click',  closeDialog);
  els.dialog.addEventListener('cancel', closeDialog);

  // Autenticación
  els.loginForm.addEventListener('submit', handleLogin);
  els.logoutBtn.addEventListener('click',  handleLogout);
}

// ---- Utilidades ----
function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

// ---- Arranque ----
renderPlatformFilters();
setupListeners();
if (supabase) initAuth();
