// ==========================================
// Watchlist — lógica de la aplicación
// ==========================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';
import { SUPABASE_URL, SUPABASE_ANON_KEY, TMDB_API_KEY } from './config.js';
import {
  todayISO, formatShortDate, monthGrid, shiftMonth, monthTitle, seasonsToFetch,
  normalizeShow, mergeSeason, groupDrops, dropLabel, dropShortLabel, bucketFor,
  classifyShow, pendingCount, statusText, pendingText, STATUS_LABELS,
} from './schedule.js';

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
  { id: 'filmin',      name: 'Filmin',       color: 'var(--p-filmin)' },
];
const PLATFORM_MAP = Object.fromEntries(PLATFORMS.map(p => [p.id, p]));

// IDs de proveedor de TMDB (datos de JustWatch, región ES) -> nuestras plataformas.
// Los "Amazon Channel" se ignoran: requieren una suscripción aparte dentro de Prime.
const TMDB_PROVIDERS = {
  8:    'netflix',     1796: 'netflix',   // Netflix, Netflix con anuncios
  1899: 'hbo',
  337:  'disney',
  350:  'apple',
  1773: 'skyshowtime',
  119:  'prime',       2100: 'prime',     // Prime Video, Prime Video con anuncios
  2241: 'movistar',    149:  'movistar',  // Movistar Plus+, Movistar Plus+ Ficción Total
  538:  'plex',
  63:   'filmin',      64:   'filmin',    // Filmin, Filmin Plus
};
const PROVIDER_REGION = 'ES';

// ---- Géneros ----
// Mapeo de IDs de TMDB a nuestros géneros canónicos. Un ID puede mapearse a 1 o 2.
// Cualquier género que se guarde en BBDD debe estar en el CHECK de la tabla (ver README).
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
const TMDB_BACKDROP = 'https://image.tmdb.org/t/p/w780';

async function tmdbGet(path, params = {}, signal) {
  const qs = new URLSearchParams({ api_key: TMDB_API_KEY, language: 'es-ES', ...params });
  const res = await fetch(`${TMDB_BASE}${path}?${qs}`, { signal });
  if (!res.ok) throw new Error('Error consultando TMDB');
  return res.json();
}

async function searchTMDB(query, signal) {
  const data = await tmdbGet('/search/multi', { query, include_adult: 'false' }, signal);
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
    rating:       ratingFrom(r),
  };
}

// Nota media de TMDB con un decimal, o null si nadie ha votado
function ratingFrom(r) {
  return r?.vote_count > 0 ? Math.round(r.vote_average * 10) / 10 : null;
}

// Obtiene los detalles de una serie, incluyendo el array de temporadas.
// Se cachea la promesa para no repetir la llamada entre abrir el modal y guardar.
const tvDetailsCache = new Map();
function fetchTVDetails(tmdbId) {
  if (!tvDetailsCache.has(tmdbId)) {
    const p = tmdbGet(`/tv/${tmdbId}`);
    p.catch(() => tvDetailsCache.delete(tmdbId)); // no cachear errores
    tvDetailsCache.set(tmdbId, p);
  }
  return tvDetailsCache.get(tmdbId);
}

// Plataformas donde el título está incluido en la suscripción (o gratis / con anuncios)
// en España. Alquiler y compra no cuentan. Devuelve un array de ids de PLATFORMS.
async function fetchSuggestedPlatforms(type, tmdbId) {
  const data = await tmdbGet(`/${type}/${tmdbId}/watch/providers`);
  const region = data.results?.[PROVIDER_REGION];
  if (!region) return [];
  const offers = [...(region.flatrate || []), ...(region.ads || []), ...(region.free || [])];
  const ids = new Set(offers.map(o => TMDB_PROVIDERS[o.provider_id]).filter(Boolean));
  return PLATFORMS.map(p => p.id).filter(id => ids.has(id));  // en el orden de PLATFORMS
}

// Detalles completos para la ficha: sinopsis, reparto, tráiler… (cacheado por título)
const fullDetailsCache = new Map();
function fetchFullDetails(type, tmdbId) {
  const key = `${type}:${tmdbId}`;
  if (!fullDetailsCache.has(key)) {
    const p = tmdbGet(`/${type}/${tmdbId}`, {
      append_to_response:     'credits,videos',
      include_video_language: 'es,en',
    });
    p.catch(() => fullDetailsCache.delete(key));
    fullDetailsCache.set(key, p);
  }
  return fullDetailsCache.get(key);
}

// Obtiene los detalles de una película (para runtime)
// Cacheado igual que las series: al guardar se usa para la duración y la nota
const movieDetailsCache = new Map();
function fetchMovieDetails(tmdbId) {
  if (!movieDetailsCache.has(tmdbId)) {
    const p = tmdbGet(`/movie/${tmdbId}`);
    p.catch(() => movieDetailsCache.delete(tmdbId));
    movieDetailsCache.set(tmdbId, p);
  }
  return movieDetailsCache.get(tmdbId);
}

// Obtiene los detalles de una temporada concreta para calcular su duración media
function fetchSeasonDetails(tmdbId, seasonNumber) {
  return tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}`);
}

// Calcula la duración media de los episodios de una temporada (en minutos)
// Devuelve null si no hay datos válidos
function averageEpisodeRuntime(seasonDetails) {
  const runtimes = (seasonDetails.episodes || [])
    .map(e => e.runtime)
    .filter(r => typeof r === 'number' && r > 0);
  if (runtimes.length === 0) return null;
  const avg = runtimes.reduce((a, b) => a + b, 0) / runtimes.length;
  return Math.round(avg);
}

// Formatea una duración en minutos a algo legible
// perEpisode=false: "2h 8min" para películas; true: "~45min" para capítulos
function formatDuration(minutes, perEpisode) {
  if (minutes == null) return '—';
  if (perEpisode) return `~${minutes}min`;
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

// "8 caps" en tarjetas y opciones; "8 capítulos" (long=true) en la ficha
function formatEpisodes(n, long) {
  if (long) return `${n} ${n === 1 ? 'capítulo' : 'capítulos'}`;
  return `${n} ${n === 1 ? 'cap' : 'caps'}`;
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
  tab: 'list',                // 'list' | 'upcoming'
  // Próximos (series seguidas)
  followed: [],               // filas de followed_shows
  schedules: new Map(),       // tmdb_id -> serie normalizada (ver schedule.js)
  upcomingView: 'agenda',     // 'agenda' | 'calendar'
  calMonth: null,             // 'YYYY-MM' que enseña el calendario (null = el actual)
  calDay: null,               // día seleccionado en el calendario
};

// ---- Preferencias (por navegador) ----
// Vista, orden y "Mostrar vistos" se recuerdan entre visitas. localStorage puede
// no estar disponible (modo privado, bloqueado…): en ese caso se usan los valores por defecto.
const PREFS_KEY = 'watchlist:prefs';
const SORT_OPTIONS = ['added_desc', 'year_desc', 'year_asc', 'duration_desc', 'duration_asc', 'rating_desc'];

function loadPrefs() {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch {}
  if (prefs.viewMode === 'grid' || prefs.viewMode === 'list') state.viewMode = prefs.viewMode;
  if (SORT_OPTIONS.includes(prefs.sortBy)) state.sortBy = prefs.sortBy;
  if (typeof prefs.showWatched === 'boolean') state.showWatched = prefs.showWatched;
  if (prefs.tab === 'list' || prefs.tab === 'upcoming') state.tab = prefs.tab;
  if (prefs.upcomingView === 'agenda' || prefs.upcomingView === 'calendar') state.upcomingView = prefs.upcomingView;
}

function savePrefs() {
  const { viewMode, sortBy, showWatched, tab, upcomingView } = state;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ viewMode, sortBy, showWatched, tab, upcomingView }));
  } catch {}
}

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
  viewButtons:      document.querySelectorAll('.view-btn[data-view]'),
  grid:             $('watchlist-grid'),
  emptyState:       $('empty-state'),
  loadingState:     $('loading-state'),
  listCount:        $('list-count'),
  dialog:           $('platform-dialog'),
  dialogInfo:       $('dialog-item-info'),
  dialogChecks:     $('platform-checkboxes'),
  providersNote:    $('providers-note'),
  detailDialog:     $('detail-dialog'),
  detailBody:       $('detail-body'),
  detailClose:      $('detail-close'),
  dialogSeasonSection: $('season-section'),
  dialogSeasonOptions: $('season-options'),
  dialogSave:       $('dialog-save'),
  dialogCancel:     $('dialog-cancel'),
  dialogClose:      $('dialog-close'),
  // Pestañas y Próximos
  tabButtons:       document.querySelectorAll('.tab-btn'),
  watchlistSection: $('watchlist-section'),
  upcomingSection:  $('upcoming-section'),
  upcomingViews:    document.querySelectorAll('[data-upcoming-view]'),
  upcomingRefresh:  $('upcoming-refresh'),
  upcomingBody:     $('upcoming-body'),
  showDialog:       $('show-dialog'),
  showBody:         $('show-body'),
  showClose:        $('show-close'),
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
  themeBtn:         $('theme-btn'),
};

// ---- Render: chips de plataformas para filtrar ----
function renderPlatformFilters() {
  els.platformFilters.innerHTML = PLATFORMS.map(p => `
    <button class="chip platform-chip" data-platform="${p.id}"
            style="--platform-color: ${p.color}">${p.name}</button>
  `).join('');
}

// ---- Render: chips dinámicos de géneros (solo los presentes en la lista) ----
// Solo depende de state.items, así que se llama cuando cambian los items (no en cada filtro)
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
}

// Re-render completo tras cambiar state.items (carga, alta, borrado)
function onItemsChanged(opts) {
  renderGenreFilters();
  renderList(opts);
}

// ---- Render: lista de watchlist ----
// animate=true solo en la carga inicial, para no re-animar todas las tarjetas en cada clic
function renderList({ animate = false } = {}) {
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
      case 'duration_desc':
      case 'duration_asc': {
        // Los items sin duración (null) siempre al final, sea ascendente o descendente
        const da = a.duration_minutes, db = b.duration_minutes;
        if (da == null && db == null) return 0;
        if (da == null) return 1;
        if (db == null) return -1;
        return state.sortBy === 'duration_desc' ? db - da : da - db;
      }
      case 'rating_desc': {
        // Sin nota, al final
        const ra = a.rating, rb = b.rating;
        if (ra == null && rb == null) return 0;
        if (ra == null) return 1;
        if (rb == null) return -1;
        return rb - ra;
      }
      case 'added_desc':
      default:          return (b.added_at || '').localeCompare(a.added_at || '');
    }
  });

  els.listCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'título' : 'títulos'}`;
  els.loadingState.hidden = true;

  // Aplicar la clase de vista al contenedor
  els.grid.classList.toggle('list-view', state.viewMode === 'list');
  els.grid.classList.toggle('animate-in', animate);

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
}

function itemCardHTML(item, i) {
  // El póster abre la ficha de detalle (también con teclado)
  const openAttrs = `role="button" tabindex="0" aria-label="Ver ficha de ${escapeHTML(item.title)}"`;
  const poster = item.poster_path
    ? `<div class="item-poster item-open" ${openAttrs} style="background-image: url('${posterURL(item.poster_path)}')">
         <span class="item-type-badge">${item.type === 'movie' ? 'Película' : 'Serie'}</span>
         <div class="watched-stamp">visto</div>
       </div>`
    : `<div class="item-poster item-open no-image" ${openAttrs}>
         <span class="item-type-badge">${item.type === 'movie' ? 'Película' : 'Serie'}</span>
         <em>?</em>
         <div class="watched-stamp">visto</div>
       </div>`;

  const platformTags = (item.platforms || []).map(pid => {
    const p = PLATFORM_MAP[pid];
    if (!p) return '';
    return `<span class="platform-tag" style="--platform-color: ${p.color}">${p.name}</span>`;
  }).join('');

  const escapedTitle = escapeHTML(item.title);
  const seasonBadge = item.season_number
    ? `<span class="season-badge">T${item.season_number}</span>`
    : '';
  const perEpisode = item.type === 'tv';
  const durationStr = item.duration_minutes != null
    ? formatDuration(item.duration_minutes, perEpisode)
    : null;
  const metaParts = [item.year ?? '—'];
  if (item.episode_count != null) metaParts.push(formatEpisodes(item.episode_count));
  if (durationStr) metaParts.push(durationStr);
  // La nota se pinta dos veces: en rejilla junto a las plataformas, en lista tras la meta (ver CSS)
  const ratingText = item.rating != null ? `★ ${Number(item.rating).toFixed(1)}` : '';
  const metaLine = metaParts.join(' · ')
    + (ratingText ? `<span class="item-rating item-rating-meta">${ratingText}</span>` : '');
  const ratingTag = ratingText ? `<span class="item-rating item-rating-row">${ratingText}</span>` : '';

  return `
    <div class="item-card ${item.watched ? 'watched' : ''}"
         data-id="${item.id}"
         style="animation-delay: ${Math.min(i * 25, 400)}ms">
      ${poster}
      <div class="item-info">
        <h3 class="item-title item-open">${escapedTitle}${seasonBadge}</h3>
        <div class="item-year">${metaLine}</div>
        <div class="item-platforms">${ratingTag}${platformTags}</div>
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
// Se guardan para volver a pintarlos al cambiar de pestaña (en Próximos solo salen series)
let lastResults = null;

function renderSearchResults(results) {
  lastResults = results;
  const upcoming = state.tab === 'upcoming';
  const shown = upcoming ? results.filter(r => r.media_type === 'tv') : results;
  if (shown.length === 0) {
    els.searchResults.innerHTML = `<p style="grid-column:1/-1;color:var(--text-muted);font-style:italic;padding:20px 0;">Sin resultados.</p>`;
    return;
  }
  els.searchResults.innerHTML = shown.map(r => {
    const item = normalizeTMDBItem(r);
    const badge = upcoming ? (followedRow(item.tmdb_id) ? 'Siguiendo' : null) : inListLabel(item);
    return `
      <button class="result-card ${badge ? 'in-list' : ''}" data-tmdb-id="${item.tmdb_id}" data-type="${item.type}">
        <div class="result-poster" style="background-image: url('${posterURL(item.poster_path)}')">
          ${badge ? `<span class="in-list-badge">${badge}</span>` : ''}
        </div>
        <div class="result-info">
          <h4 class="result-title">${escapeHTML(item.title)}</h4>
          <div class="result-meta">${item.type === 'movie' ? 'Peli' : 'Serie'} · ${item.year ?? '—'}</div>
        </div>
      </button>
    `;
  }).join('');

  els.searchResults.querySelectorAll('.result-card').forEach((card, idx) => {
    card.addEventListener('click', () => {
      const tmdbItem = normalizeTMDBItem(shown[idx]);
      if (!upcoming) return openAddDialog(tmdbItem);
      // En Próximos se sigue directamente; si ya la sigues, se abre su ficha
      if (followedRow(tmdbItem.tmdb_id)) return openShowDialog(tmdbItem.tmdb_id);
      followShow(tmdbItem).then(ok => { if (ok) clearSearch(); });
    });
  });
}

// Texto del distintivo para un resultado de búsqueda que ya está en la lista, o null.
// Para series con temporadas sueltas indica cuáles: "T1 · T3 en tu lista".
function inListLabel(item) {
  const entries = state.items.filter(i => i.tmdb_id === item.tmdb_id && i.type === item.type);
  if (entries.length === 0) return null;
  if (entries.some(i => i.season_number == null)) return 'En tu lista';
  const seasons = entries.map(i => i.season_number).sort((a, b) => a - b);
  return `${seasons.map(n => `T${n}`).join(' · ')} en tu lista`;
}

// ---- Ficha de detalle ----
let detailItemId = null;  // título abierto en la ficha (para descartar respuestas tardías)

async function openDetailDialog(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  detailItemId = id;

  // Primero lo que ya tenemos en local; sinopsis, reparto, etc. llegan después
  els.detailBody.innerHTML = detailHeaderHTML(item) + `
    <div id="detail-extra"><p class="detail-loading">Cargando ficha…</p></div>
    <div class="detail-actions" id="detail-actions"></div>`;
  renderDetailActions(id);
  if (!els.detailDialog.open) els.detailDialog.showModal();

  try {
    const [details, season] = await Promise.all([
      fetchFullDetails(item.type, item.tmdb_id),
      item.season_number != null
        ? fetchSeasonDetails(item.tmdb_id, item.season_number).catch(() => null)
        : null,
    ]);
    if (detailItemId !== id) return;  // se cerró o se abrió otro título
    if (details.backdrop_path) {
      els.detailBody.querySelector('.detail-hero').style.backgroundImage =
        `url('${escapeHTML(TMDB_BACKDROP + details.backdrop_path)}')`;
    }
    $('detail-extra').innerHTML = detailExtraHTML(item, details, season);
  } catch (err) {
    console.error(err);
    if (detailItemId !== id) return;
    $('detail-extra').innerHTML = '<p class="detail-loading">No se pudo cargar la ficha de TMDB.</p>';
  }
}

function detailHeaderHTML(item) {
  const typeLabel = item.type === 'movie' ? 'Película' : 'Serie';
  const meta = [typeLabel, item.year ?? '—'];
  if (item.season_number) meta.push(`Temporada ${item.season_number}`);
  if (item.episode_count != null) meta.push(formatEpisodes(item.episode_count, true));
  if (item.duration_minutes != null) meta.push(formatDuration(item.duration_minutes, item.type === 'tv'));
  const platforms = (item.platforms || []).map(pid => {
    const p = PLATFORM_MAP[pid];
    return p ? `<span class="platform-tag" style="--platform-color: ${p.color}">${p.name}</span>` : '';
  }).join('');
  return `
    <div class="detail-hero">
      <div class="detail-poster" style="background-image: url('${item.poster_path ? posterURL(item.poster_path) : ''}')"></div>
      <div class="detail-heading">
        <h2 class="detail-title">${escapeHTML(item.title)}</h2>
        <p class="detail-meta">${meta.map(escapeHTML).join(' · ')}</p>
        ${item.genres?.length ? `<p class="detail-genres">${item.genres.map(escapeHTML).join(' · ')}</p>` : ''}
        ${platforms ? `<div class="item-platforms">${platforms}</div>` : ''}
      </div>
    </div>`;
}

function detailExtraHTML(item, details, season) {
  const parts = [];

  if (details.vote_count > 0) {
    parts.push(`<p class="detail-rating"><span class="star">★</span> ${details.vote_average.toFixed(1)}
      <span class="detail-votes">(${details.vote_count.toLocaleString('es-ES')} votos en TMDB)</span></p>`);
  }
  if (details.tagline) {
    parts.push(`<p class="detail-tagline">${escapeHTML(details.tagline)}</p>`);
  }

  // Si es una temporada concreta y tiene sinopsis propia, se usa esa
  const seasonOverview = season?.overview?.trim();
  const overview = seasonOverview || details.overview?.trim();
  parts.push(`
    <h3 class="dialog-section-title">${seasonOverview ? `Sinopsis · Temporada ${item.season_number}` : 'Sinopsis'}</h3>
    <p class="detail-overview">${overview ? escapeHTML(overview) : '<em>Sin sinopsis en español.</em>'}</p>`);

  const people = item.type === 'movie'
    ? { label: 'Dirección', names: (details.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name) }
    : { label: 'Creación',  names: (details.created_by || []).map(c => c.name) };
  if (people.names.length) {
    parts.push(`<h3 class="dialog-section-title">${people.label}</h3>
      <p class="detail-people">${people.names.map(escapeHTML).join(', ')}</p>`);
  }

  const cast = (details.credits?.cast || []).slice(0, 8);
  if (cast.length) {
    parts.push(`<h3 class="dialog-section-title">Reparto</h3>
      <p class="detail-people">${cast.map(c => escapeHTML(c.name)).join(', ')}</p>`);
  }

  const trailerKey = findTrailer(details);
  if (trailerKey) {
    // youtube-nocookie: no deja cookies hasta que se da a reproducir.
    // YouTube rechaza embeds sin Referer, de ahí el referrerpolicy.
    parts.push(`<h3 class="dialog-section-title">Tráiler</h3>
      <div class="detail-trailer">
        <iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailerKey)}?rel=0"
          title="Tráiler de ${escapeHTML(item.title)}" loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>
      </div>`);
  }
  return parts.join('');
}

// Tráiler de YouTube: preferimos en español y oficial
function findTrailer(details) {
  const videos = (details.videos?.results || [])
    .filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
  const score = v => (v.iso_639_1 === 'es' ? 4 : 0) + (v.type === 'Trailer' ? 2 : 0) + (v.official ? 1 : 0);
  const best = videos.sort((a, b) => score(b) - score(a))[0];
  return best?.key ?? null;
}

// Botones de la ficha. Se re-renderizan al marcar como visto.
function renderDetailActions(id) {
  const box = $('detail-actions');
  const item = state.items.find(i => i.id === id);
  if (!box || !item || detailItemId !== id) return;
  const follow = item.type === 'tv'
    ? `<button type="button" class="btn-ghost" data-action="follow">
         ${followedRow(item.tmdb_id) ? 'Dejar de seguir' : '+ Seguir en Próximos'}
       </button>`
    : '';
  box.innerHTML = `
    ${follow}
    <button type="button" class="btn-ghost" data-action="watched">
      ${item.watched ? '↺ Marcar como no visto' : '✓ Marcar como visto'}
    </button>
    <button type="button" class="btn-primary" data-action="edit">Editar</button>`;
}

// ---- Modal: añadir / editar plataformas ----
function openAddDialog(item) {
  openDialog({
    mode: 'add',
    data: item,
    selected: new Set(),
    seasonNumber: null,  // null = "Toda la serie" (también el valor para películas)
    seasonYear:   null,  // se rellenará si elige una temporada concreta
  }, 'No se pudo cargar la lista de temporadas. Se guardará como "toda la serie".');
}

function openEditDialog(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  openDialog({
    mode: 'edit',
    data: item,
    selected: new Set(item.platforms || []),
    seasonNumber: item.season_number,
    seasonYear:   item.year,
  }, 'No se pudo cargar la lista de temporadas.');
}

async function openDialog(pending, seasonsErrorMsg) {
  const item = pending.data;
  state.pendingItem = pending;
  fillDialog(item, pending.seasonNumber);
  els.dialog.showModal();

  // En paralelo con las temporadas
  loadPlatformSuggestions(pending);

  // Si es serie, traemos las temporadas
  if (item.type !== 'tv') return;
  showSeasonsLoading();
  try {
    const tvDetails = await fetchTVDetails(item.tmdb_id);
    // El modal puede haberse cerrado (o abierto otro título) mientras esperábamos
    if (state.pendingItem !== pending) return;
    // En edición, item.year puede ser el de una temporada: el de la serie sale de TMDB
    const firstAir = tvDetails.first_air_date;
    pending.showYear = firstAir ? parseInt(firstAir.slice(0, 4), 10) : item.year;
    pending.totalEpisodes = tvDetails.number_of_episodes || null;
    renderSeasonOptions(normalizeSeasons(tvDetails), pending.seasonNumber);
  } catch (err) {
    console.error(err);
    if (state.pendingItem !== pending) return;
    els.dialogSeasonOptions.classList.remove('loading');
    els.dialogSeasonOptions.innerHTML = `<p style="color:var(--text-muted);font-style:italic;">${seasonsErrorMsg}</p>`;
  }
}

// Marca las plataformas donde TMDB/JustWatch dice que está el título.
// Al añadir, las preselecciona (salvo que el usuario ya haya tocado alguna);
// al editar, solo las señala para no pisar lo que ya tenía guardado.
async function loadPlatformSuggestions(pending) {
  let suggested;
  try {
    suggested = await fetchSuggestedPlatforms(pending.data.type, pending.data.tmdb_id);
  } catch (err) {
    console.error('Error obteniendo plataformas:', err);
    return;
  }
  if (state.pendingItem !== pending || suggested.length === 0) return;
  pending.suggested = new Set(suggested);
  if (pending.mode === 'add' && !pending.touched) {
    suggested.forEach(id => pending.selected.add(id));
  }
  renderPlatformChecks();
  els.providersNote.textContent = pending.mode === 'add' && !pending.touched
    ? 'Preseleccionadas según JustWatch. Revísalas antes de guardar.'
    : 'Las marcadas como “disponible” lo están según JustWatch.';
  els.providersNote.hidden = false;
}

function renderPlatformChecks() {
  const { selected, suggested } = state.pendingItem;
  els.dialogChecks.innerHTML = PLATFORMS.map(p => `
    <label class="platform-check ${selected.has(p.id) ? 'checked' : ''}"
           data-platform="${p.id}" style="--platform-color: ${p.color}">
      <span class="dot"></span>
      <input type="checkbox" ${selected.has(p.id) ? 'checked' : ''} />
      <span>${p.name}</span>
      ${suggested?.has(p.id) ? '<span class="suggested-tag">disponible</span>' : ''}
    </label>
  `).join('');
}

function fillDialog(item, seasonNumber) {
  const subtitle = seasonNumber
    ? `Serie · T${seasonNumber}`
    : item.type === 'movie' ? 'Película' : 'Serie';
  els.dialogInfo.innerHTML = `
    <div class="mini-poster" style="background-image: url('${item.poster_path ? posterURL(item.poster_path) : ''}')"></div>
    <div class="info-text">
      <p class="info-title">${escapeHTML(item.title)}</p>
      <p class="info-meta">${subtitle} · ${item.year ?? '—'}</p>
    </div>
  `;

  els.dialogSeasonSection.hidden = item.type !== 'tv';

  els.providersNote.hidden = true;
  renderPlatformChecks();
}

function showSeasonsLoading() {
  els.dialogSeasonOptions.classList.add('loading');
  els.dialogSeasonOptions.innerHTML = 'Cargando temporadas…';
}

function renderSeasonOptions(seasons, currentSeasonNumber) {
  els.dialogSeasonOptions.classList.remove('loading');

  // Opción "Toda la serie" + cada temporada
  const showYear = state.pendingItem.showYear ?? '—';
  const totalEpisodes = state.pendingItem.totalEpisodes;
  const allShowChecked = currentSeasonNumber == null;
  const epsHTML = n => n ? `<span class="option-eps">· ${formatEpisodes(n)}</span>` : '';

  const rows = [
    `<label class="season-option ${allShowChecked ? 'checked' : ''}" data-season="all">
       <input type="radio" name="season" ${allShowChecked ? 'checked' : ''} />
       <span class="option-radio"></span>
       <span class="option-label">Toda la serie ${epsHTML(totalEpisodes)}</span>
       <span class="option-year">${showYear}</span>
     </label>`,
    ...seasons.map(s => {
      const checked = s.number === currentSeasonNumber;
      return `<label class="season-option ${checked ? 'checked' : ''}" data-season="${s.number}" data-year="${s.year}">
        <input type="radio" name="season" ${checked ? 'checked' : ''} />
        <span class="option-radio"></span>
        <span class="option-label">Temporada ${s.number} ${epsHTML(s.episodeCount)}</span>
        <span class="option-year">${s.year}</span>
      </label>`;
    }),
  ];
  els.dialogSeasonOptions.innerHTML = rows.join('');
}

function closeDialog() {
  els.dialog.close();
  state.pendingItem = null;
}

async function saveDialog() {
  if (!state.pendingItem) return;
  const { mode, data, selected, seasonNumber, seasonYear } = state.pendingItem;
  const platforms = Array.from(selected);

  // Bloquear el botón mientras hacemos las llamadas a TMDB
  els.dialogSave.disabled = true;
  els.dialogSave.textContent = 'Guardando…';

  try {
    // Resolver duración según el tipo y la temporada elegida.
    // En edición, si la temporada no cambia, reutilizamos la duración guardada.
    const keepDuration = mode === 'edit'
      && seasonNumber === data.season_number
      && data.duration_minutes != null;
    const [duration, episodeCount, rating] = await Promise.all([
      keepDuration ? data.duration_minutes : resolveDuration(data, seasonNumber),
      resolveEpisodeCount(data, seasonNumber),  // usa los detalles de la serie ya cacheados
      resolveRating(data),                      // al editar, refresca la nota
    ]);

    const fields = {
      platforms,
      season_number:    seasonNumber,
      year:             seasonYear ?? data.year,
      duration_minutes: duration,
      episode_count:    episodeCount,
      rating:           rating ?? data.rating ?? null,
    };
    const ok = mode === 'add'
      ? await addItem({ ...data, ...fields })
      : await updateItem(data.id, fields);
    // Si falla (duplicado, error de red…), el modal sigue abierto con la selección
    if (ok) closeDialog();
  } finally {
    els.dialogSave.disabled = false;
    els.dialogSave.textContent = 'Guardar';
  }
}

// Resuelve la duración en minutos según el tipo y la temporada
// Devuelve null si TMDB no tiene el dato
async function resolveDuration(item, seasonNumber) {
  try {
    if (item.type === 'movie') {
      const details = await fetchMovieDetails(item.tmdb_id);
      return details.runtime || null;
    }

    // Serie: si hay temporada concreta, calculamos la media real de esa temporada
    if (seasonNumber != null) {
      const seasonDetails = await fetchSeasonDetails(item.tmdb_id, seasonNumber);
      const avg = averageEpisodeRuntime(seasonDetails);
      if (avg != null) return avg;
    }

    // Serie completa, o temporada sin episodios con runtime: media general de la serie
    const tvDetails = await fetchTVDetails(item.tmdb_id);
    const generalRuntime = tvDetails.episode_run_time;
    if (Array.isArray(generalRuntime) && generalRuntime.length > 0) {
      return generalRuntime[0];
    }

    // TMDB suele dejar episode_run_time vacío: usamos la media de la última temporada
    // emitida (si no es la que ya hemos consultado arriba)
    const lastSeason = tvDetails.last_episode_to_air?.season_number;
    if (lastSeason != null && lastSeason !== seasonNumber) {
      const avg = averageEpisodeRuntime(await fetchSeasonDetails(item.tmdb_id, lastSeason));
      if (avg != null) return avg;
    }
    return null;
  } catch (err) {
    console.error('Error obteniendo duración:', err);
    return null;
  }
}

// Número de capítulos de la temporada elegida, o de toda la serie. null para películas
// o si TMDB no lo sabe (las temporadas anunciadas vienen con 0).
async function resolveEpisodeCount(item, seasonNumber) {
  if (item.type !== 'tv') return null;
  try {
    const tvDetails = await fetchTVDetails(item.tmdb_id);
    if (seasonNumber != null) {
      return tvDetails.seasons?.find(s => s.season_number === seasonNumber)?.episode_count || null;
    }
    return tvDetails.number_of_episodes || null;
  } catch (err) {
    console.error('Error obteniendo capítulos:', err);
    return null;
  }
}

// Nota media actual en TMDB (detalles cacheados). null si no hay votos o falla.
async function resolveRating(item) {
  try {
    const details = item.type === 'movie'
      ? await fetchMovieDetails(item.tmdb_id)
      : await fetchTVDetails(item.tmdb_id);
    return ratingFrom(details);
  } catch (err) {
    console.error('Error obteniendo nota:', err);
    return null;
  }
}

// ---- Autenticación ----
// undefined = aún no sabemos nada; null = sin sesión. Así el primer evento sin sesión
// (INITIAL_SESSION con session=null) también muestra el login.
let currentUserId = undefined;

function initAuth() {
  // onAuthStateChange emite INITIAL_SESSION al suscribirse (sesión guardada en localStorage),
  // así que no hace falta llamar a getSession(). TOKEN_REFRESHED llega cada ~1h con el
  // mismo usuario: en ese caso no recargamos la lista.
  supabase.auth.onAuthStateChange((_event, session) => {
    const user = session?.user ?? null;
    if ((user?.id ?? null) === currentUserId) return;
    currentUserId = user?.id ?? null;
    // Diferido: Supabase recomienda no lanzar consultas dentro del callback (puede bloquearse)
    setTimeout(() => (user ? showApp(user) : showLogin()), 0);
  });
}

function showLogin() {
  els.loginSection.hidden = false;
  els.appMain.hidden = true;
  els.userBar.hidden = true;
  // limpiar la lista (estado y DOM) por si había otro usuario
  state.items = [];
  els.grid.innerHTML = '';
  els.genreFilters.innerHTML = '';
  els.loadingState.hidden = false;
  els.loadingState.textContent = 'Cargando tu lista…';
  // y las series seguidas; followedGen descarta cargas que sigan en marcha
  followedGen++;
  state.followed = [];
  state.schedules.clear();
  els.upcomingBody.innerHTML = '';
  if (els.showDialog.open) els.showDialog.close();
  clearSearch();
}

function showApp(user) {
  els.loginSection.hidden = true;
  els.appMain.hidden = false;
  els.userBar.hidden = false;
  els.userEmail.textContent = user.email;
  loadItems();
  loadFollowed();
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
  if (error) {
    console.error(error);
    els.loadingState.hidden = false;
    els.loadingState.textContent = 'No se pudo cargar tu lista. Recarga la página para reintentarlo.';
    return;
  }
  state.items = data || [];
  onItemsChanged({ animate: true });
  backfillMissingInfo();
}

// Rellena en segundo plano la duración, los capítulos y la nota de los títulos que no los tienen
// (p. ej. guardados antes de que existieran esos cálculos). Va de uno en uno para no
// saturar TMDB, y cada título se intenta como mucho una vez por carga de página.
const backfillTried = new Set();
let backfillRunning = false;
const missingDuration = i => i.duration_minutes == null;
const missingEpisodes = i => i.type === 'tv' && i.episode_count == null;
const missingRating   = i => i.rating == null;

async function backfillMissingInfo() {
  if (backfillRunning) return;
  backfillRunning = true;
  let changed = 0;
  try {
    const pending = state.items.filter(i =>
      (missingDuration(i) || missingEpisodes(i) || missingRating(i)) && !backfillTried.has(i.id));
    for (const item of pending) {
      backfillTried.add(item.id);
      const season = item.season_number;
      const [duration, episodes, rating] = await Promise.all([
        missingDuration(item) ? resolveDuration(item, season) : null,
        missingEpisodes(item) ? resolveEpisodeCount(item, season) : null,
        missingRating(item)   ? resolveRating(item) : null,
      ]);
      // Puede haberse editado o borrado mientras esperábamos a TMDB
      const current = state.items.find(i => i.id === item.id);
      if (!current || current.season_number !== season) continue;
      const updates = {};
      if (duration != null && missingDuration(current)) updates.duration_minutes = duration;
      if (episodes != null && missingEpisodes(current)) updates.episode_count = episodes;
      if (rating != null && missingRating(current))     updates.rating = rating;
      if (Object.keys(updates).length === 0) continue;
      const { error } = await supabase
        .from('watchlist_items')
        .update(updates)
        .eq('id', item.id);
      if (error) { console.error('Error guardando duración/capítulos:', error); continue; }
      Object.assign(current, updates);
      changed++;
    }
  } finally {
    backfillRunning = false;
  }
  if (changed > 0) renderList();
}

// Devuelve true si se ha guardado
async function addItem(item) {
  if (!supabase) { alert('Configura primero config.js'); return false; }

  // Comprobación local antes de llamar al servidor (considera la temporada)
  const duplicate = state.items.find(
    i => i.tmdb_id === item.tmdb_id
      && i.type === item.type
      && i.season_number === item.season_number
  );
  if (duplicate) {
    const label = item.season_number ? `${item.title} (T${item.season_number})` : item.title;
    alert(`"${label}" ya está en tu lista.`);
    return false;
  }

  const { data, error } = await supabase
    .from('watchlist_items')
    .insert({
      tmdb_id:          item.tmdb_id,
      type:             item.type,
      title:            item.title,
      poster_path:      item.poster_path,
      year:             item.year,
      platforms:        item.platforms,
      genres:           item.genres,
      season_number:    item.season_number ?? null,
      duration_minutes: item.duration_minutes ?? null,
      episode_count:    item.episode_count ?? null,
      rating:           item.rating ?? null,
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
    return false;
  }
  state.items.unshift(data);
  onItemsChanged();
  clearSearch();
  return true;
}

function clearSearch() {
  clearTimeout(searchTimeout);
  searchController?.abort();
  searchController = null;
  els.searchInput.value = '';
  els.searchResults.innerHTML = '';
  els.searchStatus.textContent = '';
  lastResults = null;
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

// Devuelve true si se ha guardado
async function updateItem(id, updates) {
  const item = state.items.find(i => i.id === id);
  if (!item) return false;
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
    return false;
  }
  return true;
}

async function deleteItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  if (!confirm(`¿Eliminar "${item.title}" de la lista?`)) return;
  state.items = state.items.filter(i => i.id !== id);
  onItemsChanged();
  const { error } = await supabase
    .from('watchlist_items')
    .delete()
    .eq('id', id);
  if (error) { alert('Error: ' + error.message); loadItems(); }
}

// ==========================================
// Próximos: series seguidas (tabla followed_shows)
// ==========================================
// Lista propia, independiente de la Watchlist. De cada serie se guarda un puntero
// "voy por TxEy" (seen_season / seen_episode) solo para saber si vas al día.

const followedRow = tmdbId => state.followed.find(f => f.tmdb_id === tmdbId);

// Limita las peticiones simultáneas a TMDB: con muchas series seguidas,
// cargar los calendarios supone decenas de llamadas
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const tmdbLimit = createLimiter(6);

// ---- Caché de calendarios (por navegador) ----
// La serie ya normalizada, 12 h. Son datos públicos de TMDB, no hace falta borrarlos al salir.
const SCHEDULE_TTL = 12 * 60 * 60 * 1000;
const scheduleKey = tmdbId => `watchlist:schedule:${tmdbId}`;

function readScheduleCache(tmdbId) {
  try {
    const cached = JSON.parse(localStorage.getItem(scheduleKey(tmdbId)));
    if (cached?.show?.loaded && Date.now() - cached.fetchedAt < SCHEDULE_TTL) return cached.show;
  } catch {}
  return null;
}

function writeScheduleCache(show) {
  try {
    localStorage.setItem(scheduleKey(show.tmdbId), JSON.stringify({ fetchedAt: Date.now(), show }));
  } catch {}
}

async function loadSchedule(row, force) {
  if (!force) {
    const cached = readScheduleCache(row.tmdb_id);
    if (cached) return cached;
  } else {
    tvDetailsCache.delete(row.tmdb_id);  // si no, "Actualizar" reutilizaría la ficha en memoria
  }
  const details = await tmdbLimit(() => fetchTVDetails(row.tmdb_id));
  const numbers = seasonsToFetch(details, row.seen_season, todayISO());
  const seasons = await Promise.all(numbers.map(n =>
    tmdbLimit(() => fetchSeasonDetails(row.tmdb_id, n)).catch(() => null)));
  const show = normalizeShow(details, seasons);
  writeScheduleCache(show);
  return show;
}

// Carga los capítulos de una temporada que aún no estaba (p. ej. al elegirla en la ficha)
async function ensureSeasonLoaded(tmdbId, seasonNumber) {
  const show = state.schedules.get(tmdbId);
  if (!show || seasonNumber == null || show.loaded.includes(seasonNumber)) return;
  try {
    const detail = await tmdbLimit(() => fetchSeasonDetails(tmdbId, seasonNumber));
    const current = state.schedules.get(tmdbId);
    if (!current) return;  // dejada de seguir o cierre de sesión mientras tanto
    const merged = mergeSeason(current, detail);
    state.schedules.set(tmdbId, merged);
    writeScheduleCache(merged);
  } catch (err) {
    console.error('Error cargando temporada:', err);
    return;
  }
  if (showDialogId === tmdbId) renderShowDialog();
  renderUpcoming();
}

// ---- Operaciones de base de datos ----
let followedGen = 0;          // sube al cerrar sesión: las cargas antiguas se descartan
let schedulesLoading = false;

async function loadFollowed() {
  if (!supabase) return;
  const gen = ++followedGen;
  els.upcomingBody.innerHTML = '<p class="loading-state">Cargando series…</p>';
  const { data, error } = await supabase
    .from('followed_shows')
    .select('*')
    .order('added_at', { ascending: true });
  if (gen !== followedGen) return;
  if (error) {
    console.error(error);
    els.upcomingBody.innerHTML = '<p class="loading-state">No se pudieron cargar tus series. Recarga la página para reintentarlo.</p>';
    return;
  }
  state.followed = data || [];
  // Lo que haya en caché se pinta ya; el resto llega con refreshSchedules
  state.followed.forEach(row => {
    const cached = readScheduleCache(row.tmdb_id);
    if (cached) state.schedules.set(row.tmdb_id, cached);
  });
  renderUpcoming();
  refreshSchedules(false);
}

async function refreshSchedules(force) {
  const gen = followedGen;
  const rows = state.followed.filter(row => force || !state.schedules.has(row.tmdb_id));
  if (rows.length === 0) return;
  setSchedulesLoading(true);
  await Promise.all(rows.map(async row => {
    try {
      const show = await loadSchedule(row, force);
      if (gen === followedGen && followedRow(row.tmdb_id)) state.schedules.set(row.tmdb_id, show);
    } catch (err) {
      console.error(`Error cargando el calendario de ${row.title}:`, err);
    }
  }));
  if (gen !== followedGen) return;
  setSchedulesLoading(false);
  renderUpcoming();
  if (showDialogId != null) renderShowDialog();
}

function setSchedulesLoading(loading) {
  schedulesLoading = loading;
  els.upcomingRefresh.disabled = loading;
  els.upcomingRefresh.textContent = loading ? 'Actualizando…' : 'Actualizar';
}

// Devuelve true si se ha guardado
const followingNow = new Set();  // evita duplicar la serie con un doble clic
async function followShow(item) {
  if (!supabase) { alert('Configura primero config.js'); return false; }
  if (followedRow(item.tmdb_id) || followingNow.has(item.tmdb_id)) return true;
  followingNow.add(item.tmdb_id);
  try {
    // Plataformas sugeridas por JustWatch, solo para colorear el calendario
    const platforms = await fetchSuggestedPlatforms('tv', item.tmdb_id).catch(err => {
      console.error('Error obteniendo plataformas:', err);
      return [];
    });
    const { data, error } = await supabase
      .from('followed_shows')
      .insert({ tmdb_id: item.tmdb_id, title: item.title, poster_path: item.poster_path, platforms })
      .select()
      .single();
    if (error) {
      alert(error.code === '23505' ? `Ya sigues "${item.title}".` : 'Error: ' + error.message);
      return false;
    }
    state.followed.push(data);
    renderUpcoming();
    refreshSchedules(false);
    return true;
  } finally {
    followingNow.delete(item.tmdb_id);
  }
}

async function unfollowShow(tmdbId) {
  const row = followedRow(tmdbId);
  if (!row) return false;
  if (!confirm(`¿Dejar de seguir "${row.title}"?`)) return false;
  state.followed = state.followed.filter(f => f.tmdb_id !== tmdbId);
  state.schedules.delete(tmdbId);
  renderUpcoming();
  const { error } = await supabase
    .from('followed_shows')
    .delete()
    .eq('id', row.id);
  if (error) { alert('Error: ' + error.message); loadFollowed(); }
  return true;
}

// Fija el puntero "voy por". season/episode a null lo quita.
async function setSeenPointer(tmdbId, season, episode) {
  const row = followedRow(tmdbId);
  if (!row) return;
  const prev = { seen_season: row.seen_season, seen_episode: row.seen_episode };
  const next = { seen_season: season, seen_episode: episode };
  Object.assign(row, next);
  renderShowDialog();
  renderUpcoming();
  const { error } = await supabase
    .from('followed_shows')
    .update(next)
    .eq('id', row.id);
  if (error) {
    Object.assign(row, prev);
    renderShowDialog();
    renderUpcoming();
    alert('Error: ' + error.message);
  }
}

// ---- Render: sección Próximos ----
const AGENDA_BUCKETS = [
  ['past', 'Últimos 7 días'],
  ['today', 'Hoy'],
  ['tomorrow', 'Mañana'],
  ['week', 'Esta semana'],
  ['later', 'Más adelante'],
];
const SUMMARY_GROUPS = [
  ['airing', 'En emisión'],
  ['premiere', 'Próximos estrenos'],
  ['waiting', 'Renovadas sin fecha'],
  ['unknown', 'Sin datos de TMDB'],
  ['ended', 'Finalizadas'],
];
const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
// Si "Más adelante" está desplegado; se conserva entre re-renders (marcar "voy por", Actualizar…)
let laterOpen = false;

function renderUpcoming() {
  els.upcomingViews.forEach(b => b.classList.toggle('active', b.dataset.upcomingView === state.upcomingView));
  if (state.followed.length === 0) {
    els.upcomingBody.innerHTML = '<p class="empty-state">No sigues ninguna serie. Búscala arriba para seguirla.</p>';
    return;
  }
  const today = todayISO();
  const entries = state.followed.map(row => ({ row, show: state.schedules.get(row.tmdb_id) || null }));
  const drops = entries
    .filter(e => e.show)
    .flatMap(e => groupDrops(e.show).map(drop => ({ drop, ...e })));
  els.upcomingBody.innerHTML = state.upcomingView === 'calendar'
    ? calendarHTML(drops, today)
    : agendaHTML(entries, drops, today);
}

// Sin plataforma, gris: el dorado (--accent) queda para los capítulos vistos
function showColor(row) {
  return PLATFORM_MAP[row.platforms?.[0]]?.color ?? 'var(--text-muted)';
}

function platformTagsHTML(platforms) {
  return (platforms || []).map(pid => {
    const p = PLATFORM_MAP[pid];
    return p ? `<span class="platform-tag" style="--platform-color: ${p.color}">${p.name}</span>` : '';
  }).join('');
}

function thumbHTML(row) {
  const bg = row.poster_path ? ` style="background-image: url('${posterURL(row.poster_path)}')"` : '';
  return `<span class="upcoming-thumb"${bg}></span>`;
}

// "quedan 3 · te faltan 2"
function rowStatus(row, show, today) {
  const parts = [];
  const cls = classifyShow(show, today);
  if (cls.state === 'airing' && cls.remaining) parts.push(`quedan ${cls.remaining}`);
  const pending = pendingText(pendingCount(show, row.seen_season, row.seen_episode, today));
  if (pending) parts.push(pending.toLowerCase());
  return parts.join(' · ');
}

function agendaRowHTML({ drop, row, show }, today) {
  const tags = [drop.premiere && !drop.fullSeason ? 'estreno' : '', drop.finale && !drop.fullSeason ? 'final' : '']
    .filter(Boolean).map(t => `<span class="drop-tag">${t}</span>`).join('');
  const status = rowStatus(row, show, today);
  return `
    <button type="button" class="agenda-row ${drop.airDate <= today ? 'aired' : ''}"
            data-show="${row.tmdb_id}" style="--platform-color: ${showColor(row)}">
      ${thumbHTML(row)}
      <span class="agenda-main">
        <span class="agenda-title">${escapeHTML(row.title)}</span>
        <span class="agenda-label">${escapeHTML(dropLabel(drop))}${tags}</span>
        ${status ? `<span class="agenda-status">${escapeHTML(status)}</span>` : ''}
      </span>
      <span class="agenda-side">
        <span class="agenda-date">${formatShortDate(drop.airDate, today)}</span>
        <span class="item-platforms">${platformTagsHTML(row.platforms)}</span>
      </span>
    </button>`;
}

function agendaHTML(entries, drops, today) {
  const buckets = new Map();
  for (const d of drops) {
    const b = bucketFor(d.drop.airDate, today);
    if (!b) continue;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(d);
  }
  const sections = AGENDA_BUCKETS
    .filter(([key]) => buckets.has(key))
    .map(([key, label]) => {
      const list = buckets.get(key);
      const rows = `<div class="agenda-list">${list
        .sort((a, b) => a.drop.airDate.localeCompare(b.drop.airDate))
        .map(d => agendaRowHTML(d, today)).join('')}</div>`;
      // "Más adelante" crece mucho con muchas series: va plegado
      if (key === 'later') {
        return `<details class="summary-group" data-group="later" ${laterOpen ? 'open' : ''}>
          <summary class="dialog-section-title upcoming-heading">${label}
            <span class="summary-count">${list.length}</span></summary>${rows}</details>`;
      }
      return `<h3 class="dialog-section-title upcoming-heading">${label}</h3>${rows}`;
    })
    .join('');

  const loadingAll = schedulesLoading && drops.length === 0;
  const agenda = sections || `<p class="empty-state">${loadingAll
    ? 'Cargando calendario…'
    : 'Nada en los últimos 7 días ni por delante con fecha.'}</p>`;
  return agenda + summaryHTML(entries, today);
}

// Resumen por serie, debajo de la agenda
function summaryHTML(entries, today) {
  const groups = new Map();
  for (const { row, show } of entries) {
    if (!show && schedulesLoading) continue;  // aún cargando
    const cls = show ? classifyShow(show, today) : { state: 'unknown' };
    if (!groups.has(cls.state)) groups.set(cls.state, []);
    groups.get(cls.state).push({ row, show, cls });
  }
  groups.get('premiere')?.sort((a, b) => a.cls.airDate.localeCompare(b.cls.airDate));

  return SUMMARY_GROUPS
    .filter(([key]) => groups.has(key))
    .map(([key, label]) => {
      const list = groups.get(key);
      const rows = list.map(({ row, show, cls }) => {
        const pending = show && pendingText(pendingCount(show, row.seen_season, row.seen_episode, today));
        return `
        <button type="button" class="summary-row" data-show="${row.tmdb_id}"
                style="--platform-color: ${showColor(row)}">
          ${thumbHTML(row)}
          <span class="agenda-main">
            <span class="agenda-title">${escapeHTML(row.title)}</span>
            ${cls.state === 'airing' && cls.total
              ? episodeBarHTML(cls, row, today)
              : `<span class="agenda-label">${escapeHTML(statusText(cls, today))}</span>`}
          </span>
          ${pending ? `<span class="pending-badge">${escapeHTML(pending)}</span>` : ''}
        </button>`;
      }).join('');
      const title = `${label} <span class="summary-count">${list.length}</span>`;
      return key === 'ended'
        ? `<details class="summary-group"><summary class="dialog-section-title upcoming-heading">${title}</summary>
             <div class="agenda-list">${rows}</div></details>`
        : `<div class="summary-group"><h3 class="dialog-section-title upcoming-heading">${title}</h3>
             <div class="agenda-list">${rows}</div></div>`;
    }).join('');
}

// Temporada en emisión como cuadrados: dorados los vistos (según "voy por"),
// en el color de la plataforma los emitidos sin ver y vacíos los que faltan por emitir
function episodeBarHTML(cls, row, today) {
  const text = statusText(cls, today);
  const seenUpTo = row.seen_season == null || row.seen_season < cls.season ? 0
    : row.seen_season > cls.season ? cls.total
    : row.seen_episode;
  const squares = Array.from({ length: cls.total }, (_, i) => {
    const state = i < Math.min(seenUpTo, cls.aired) ? 'seen' : i < cls.aired ? 'aired' : '';
    return `<span class="ep-square ${state}"></span>`;
  }).join('');
  return `<span class="episode-bar" role="img" aria-label="${escapeHTML(text)}" title="${escapeHTML(text)}">
      <span class="episode-bar-season">T${cls.season}</span>${squares}
    </span>`;
}

function calendarHTML(drops, today) {
  const month = state.calMonth ?? today.slice(0, 7);
  const byDate = new Map();
  for (const d of drops) {
    if (!byDate.has(d.drop.airDate)) byDate.set(d.drop.airDate, []);
    byDate.get(d.drop.airDate).push(d);
  }
  const selected = state.calDay?.startsWith(month) ? state.calDay
    : today.startsWith(month) ? today : null;

  const cells = monthGrid(month).map(({ iso, inMonth }) => {
    const dayDrops = byDate.get(iso) || [];
    // El final de temporada lleva una bandera (en móvil, un aro alrededor del punto)
    const chips = dayDrops.map(({ drop, row }) => `
      <button type="button" class="cal-chip ${drop.finale ? 'finale' : ''}" data-show="${row.tmdb_id}"
              style="--platform-color: ${showColor(row)}"
              title="${escapeHTML(`${row.title} · ${dropLabel(drop)}${drop.finale ? ' · final de temporada' : ''}`)}">
        <span class="cal-chip-text">${escapeHTML(row.title)} <b>${escapeHTML(dropShortLabel(drop))}</b></span>
        ${drop.finale ? '<span class="cal-finale" aria-label="final de temporada">⚑</span>' : ''}
      </button>`).join('');
    const classes = ['cal-day', inMonth ? '' : 'other-month', iso === today ? 'today' : '',
      iso === selected ? 'selected' : '', dayDrops.length ? 'has-drops' : ''].filter(Boolean).join(' ');
    return `
      <div class="${classes}" data-date="${iso}" role="button" tabindex="0"
           aria-label="${formatShortDate(iso)}${dayDrops.length ? `, ${dayDrops.length} lanzamientos` : ''}">
        <span class="cal-num">${Number(iso.slice(8))}</span>
        <div class="cal-chips">${chips}</div>
      </div>`;
  }).join('');

  const dayList = selected
    ? `<h3 class="dialog-section-title upcoming-heading">${formatShortDate(selected, today)}</h3>
       ${(byDate.get(selected) || []).length
         ? `<div class="agenda-list">${byDate.get(selected).map(d => agendaRowHTML(d, today)).join('')}</div>`
         : '<p class="cal-empty">Nada este día.</p>'}`
    : '';

  return `
    <div class="cal-nav">
      <button type="button" class="view-btn" data-cal="prev" aria-label="Mes anterior">‹</button>
      <h3 class="cal-title">${monthTitle(month)}</h3>
      <button type="button" class="view-btn" data-cal="next" aria-label="Mes siguiente">›</button>
      <button type="button" class="btn-logout" data-cal="today">Hoy</button>
    </div>
    <div class="cal-grid">
      ${WEEKDAYS.map(d => `<span class="cal-weekday">${d}</span>`).join('')}
      ${cells}
    </div>
    ${schedulesLoading && drops.length === 0 ? '<p class="cal-empty">Cargando calendario…</p>' : ''}
    ${dayList}`;
}

// ---- Ficha de serie seguida ----
let showDialogId = null;      // tmdb_id abierto
let showDialogSeason = null;  // temporada que enseña la lista de capítulos

function openShowDialog(tmdbId) {
  const row = followedRow(tmdbId);
  if (!row) return;
  const show = state.schedules.get(tmdbId);
  showDialogId = tmdbId;
  showDialogSeason = row.seen_season ?? show?.lastAired?.season ?? show?.seasons.at(-1)?.number ?? null;
  renderShowDialog();
  if (!els.showDialog.open) els.showDialog.showModal();
  ensureSeasonLoaded(tmdbId, showDialogSeason);
}

function renderShowDialog() {
  if (showDialogId == null) return;  // cerrada
  const row = followedRow(showDialogId);
  if (!row) return;
  const show = state.schedules.get(row.tmdb_id);
  const today = todayISO();

  const meta = show ? [show.network, STATUS_LABELS[show.status] ?? show.status].filter(Boolean) : [];
  const header = `
    <div class="show-header">
      <div class="mini-poster" style="background-image: url('${row.poster_path ? posterURL(row.poster_path) : ''}')"></div>
      <div class="show-heading">
        <h2 class="detail-title">${escapeHTML(row.title)}</h2>
        ${meta.length ? `<p class="detail-meta">${meta.map(escapeHTML).join(' · ')}</p>` : ''}
        <div class="item-platforms">${platformTagsHTML(row.platforms)}</div>
      </div>
    </div>`;

  if (!show) {
    els.showBody.innerHTML = header + `<p class="detail-loading show-pad">${schedulesLoading
      ? 'Cargando capítulos…' : 'No se pudieron cargar los datos de TMDB.'}</p>` + showActionsHTML(row);
    return;
  }

  const pending = pendingCount(show, row.seen_season, row.seen_episode, today);
  const pointer = row.seen_season != null
    ? `Vas por <strong>T${row.seen_season}E${row.seen_episode}</strong> · ${pendingText(pending)}`
    : 'Pulsa un capítulo emitido para fijar por dónde vas';

  const seasonChips = show.seasons.map(s => `
    <button type="button" class="chip ${s.number === showDialogSeason ? 'active' : ''}" data-season="${s.number}">
      T${s.number}
    </button>`).join('');

  const episodes = show.episodes.filter(e => e.season === showDialogSeason);
  let list;
  if (!show.loaded.includes(showDialogSeason)) {
    list = '<p class="detail-loading">Cargando capítulos…</p>';
  } else if (episodes.length === 0) {
    list = '<p class="detail-loading">TMDB aún no tiene los capítulos de esta temporada.</p>';
  } else {
    list = `<ol class="episode-list">${episodes.map(e => {
      const aired = e.airDate && e.airDate <= today;
      const seen = row.seen_season != null && (e.season < row.seen_season
        || (e.season === row.seen_season && e.episode <= row.seen_episode));
      const current = e.season === row.seen_season && e.episode === row.seen_episode;
      const tag = e.type === 'finale' ? 'final' : e.type === 'mid_season' ? 'mitad de temporada' : '';
      return `<li><button type="button" data-ep="${e.episode}" ${aired ? '' : 'disabled'}
          class="episode-row ${aired ? 'aired' : 'future'} ${seen ? 'seen' : ''} ${current ? 'current' : ''}">
        <span class="ep-num">E${e.episode}</span>
        <span class="ep-name">${escapeHTML(e.name || `Capítulo ${e.episode}`)}${tag ? `<span class="drop-tag">${tag}</span>` : ''}</span>
        <span class="ep-date">${e.airDate ? formatShortDate(e.airDate, today) : 'sin fecha'}</span>
      </button></li>`;
    }).join('')}</ol>`;
  }

  els.showBody.innerHTML = header + `
    <div class="show-pad">
      <p class="show-status">${escapeHTML(statusText(classifyShow(show, today), today))}</p>
      <p class="show-pointer">${pointer}</p>
      <div class="filter-group show-seasons">${seasonChips}</div>
      ${list}
    </div>` + showActionsHTML(row);
}

function showActionsHTML(row) {
  return `
    <div class="detail-actions">
      ${row.seen_season != null ? '<button type="button" class="btn-ghost" data-action="clear-pointer">Quitar marca</button>' : ''}
      <button type="button" class="btn-ghost btn-danger" data-action="unfollow">Dejar de seguir</button>
    </div>`;
}

// ---- Búsqueda con debounce ----
let searchTimeout;
let searchController = null;  // cancela la búsqueda anterior para que no pise a la nueva
function onSearchInput() {
  clearTimeout(searchTimeout);
  searchController?.abort();
  searchController = null;
  const q = els.searchInput.value.trim();
  if (!q) {
    els.searchResults.innerHTML = '';
    els.searchStatus.textContent = '';
    lastResults = null;
    return;
  }
  els.searchStatus.textContent = '…';
  searchTimeout = setTimeout(async () => {
    const controller = searchController = new AbortController();
    try {
      const results = await searchTMDB(q, controller.signal);
      if (controller.signal.aborted) return;
      els.searchStatus.textContent = '';
      renderSearchResults(results);
    } catch (err) {
      if (err.name === 'AbortError') return;
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
      els.typeFilters.forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      state.typeFilter = btn.dataset.type;
      renderList();
    });
  });

  // Delegación de eventos: un listener por contenedor en vez de uno por elemento en cada render
  els.platformFilters.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    toggleInSet(state.platformFilters, chip.dataset.platform);
    chip.classList.toggle('active');
    renderList();
  });

  els.genreFilters.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    toggleInSet(state.genreFilters, chip.dataset.genre);
    chip.classList.toggle('active');
    renderList();
  });

  els.grid.addEventListener('click', e => {
    const card = e.target.closest('.item-card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('.item-open')) return openDetailDialog(id);
    const btn = e.target.closest('.icon-btn');
    if (!btn) return;
    if (btn.classList.contains('watched-btn'))     toggleWatched(id);
    else if (btn.classList.contains('edit-btn'))   openEditDialog(id);
    else if (btn.classList.contains('delete-btn')) deleteItem(id);
  });
  // El póster es role="button": que también responda a Enter/Espacio
  els.grid.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const open = e.target.closest('[role="button"].item-open');
    if (!open) return;
    e.preventDefault();
    openDetailDialog(open.closest('.item-card').dataset.id);
  });

  // Ficha de detalle
  els.detailClose.addEventListener('click', () => els.detailDialog.close());
  els.detailDialog.addEventListener('close', () => {
    detailItemId = null;
    // Un iframe oculto sigue sonando: se quita al cerrar
    els.detailBody.querySelector('.detail-trailer')?.remove();
  });
  els.detailDialog.addEventListener('click', e => {
    // Clic en el fondo (fuera del contenido) cierra
    if (e.target === els.detailDialog) return els.detailDialog.close();
    const action = e.target.closest('[data-action]')?.dataset.action;
    const id = detailItemId;
    if (!action || !id) return;
    if (action === 'edit') {
      els.detailDialog.close();
      openEditDialog(id);
    } else if (action === 'watched') {
      toggleWatched(id).then(() => renderDetailActions(id));
      renderDetailActions(id);  // cambio optimista, igual que en la tarjeta
    } else if (action === 'follow') {
      const item = state.items.find(i => i.id === id);
      if (!item) return;
      const done = followedRow(item.tmdb_id) ? unfollowShow(item.tmdb_id) : followShow(item);
      done.then(() => renderDetailActions(id));
    }
  });

  // Pestañas
  els.tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      savePrefs();
      applyTab();
    });
  });

  // Próximos
  els.upcomingViews.forEach(btn => {
    btn.addEventListener('click', () => {
      state.upcomingView = btn.dataset.upcomingView;
      savePrefs();
      renderUpcoming();
    });
  });
  els.upcomingRefresh.addEventListener('click', () => refreshSchedules(true));

  els.upcomingBody.addEventListener('click', e => {
    const showBtn = e.target.closest('[data-show]');
    if (showBtn) return openShowDialog(Number(showBtn.dataset.show));
    const nav = e.target.closest('[data-cal]')?.dataset.cal;
    if (nav) {
      const current = state.calMonth ?? todayISO().slice(0, 7);
      state.calMonth = nav === 'today' ? null : shiftMonth(current, nav === 'next' ? 1 : -1);
      state.calDay = null;
      return renderUpcoming();
    }
    const day = e.target.closest('.cal-day');
    if (day) selectCalendarDay(day.dataset.date);
  });
  // 'toggle' no burbujea: se escucha en fase de captura
  els.upcomingBody.addEventListener('toggle', e => {
    if (e.target.dataset?.group === 'later') laterOpen = e.target.open;
  }, true);
  els.upcomingBody.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const day = e.target.closest('.cal-day');
    if (!day || e.target !== day) return;
    e.preventDefault();
    selectCalendarDay(day.dataset.date);
  });

  // Ficha de serie seguida
  els.showClose.addEventListener('click', () => els.showDialog.close());
  els.showDialog.addEventListener('close', () => { showDialogId = null; });
  els.showDialog.addEventListener('click', e => {
    if (e.target === els.showDialog) return els.showDialog.close();
    const tmdbId = showDialogId;
    if (tmdbId == null) return;
    const seasonBtn = e.target.closest('[data-season]');
    if (seasonBtn) {
      showDialogSeason = Number(seasonBtn.dataset.season);
      renderShowDialog();
      return ensureSeasonLoaded(tmdbId, showDialogSeason);
    }
    const ep = e.target.closest('[data-ep]');
    if (ep) return setSeenPointer(tmdbId, showDialogSeason, Number(ep.dataset.ep));
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'clear-pointer') setSeenPointer(tmdbId, null, null);
    else if (action === 'unfollow') {
      unfollowShow(tmdbId).then(ok => { if (ok) els.showDialog.close(); });
    }
  });

  els.showWatched.addEventListener('change', e => {
    state.showWatched = e.target.checked;
    savePrefs();
    renderList();
  });

  els.sortSelect.addEventListener('change', e => {
    state.sortBy = e.target.value;
    savePrefs();
    renderList();
  });

  els.viewButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      syncViewButtons();
      savePrefs();
      renderList();
    });
  });

  // Casillas y radios nativos: el navegador gestiona clic, toque y teclado; aquí solo
  // escuchamos 'change' para sincronizar el estado y el estilo.
  els.dialogChecks.addEventListener('change', e => {
    const label = e.target.closest('.platform-check');
    if (!label || !state.pendingItem) return;
    const pending = state.pendingItem;
    pending.touched = true;  // a partir de aquí las sugerencias no cambian la selección
    const id = label.dataset.platform;
    if (e.target.checked) pending.selected.add(id);
    else pending.selected.delete(id);
    label.classList.toggle('checked', e.target.checked);
  });

  els.dialogSeasonOptions.addEventListener('change', e => {
    const label = e.target.closest('.season-option');
    if (!label || !state.pendingItem) return;
    const pending = state.pendingItem;
    const isAll = label.dataset.season === 'all';
    pending.seasonNumber = isAll ? null : parseInt(label.dataset.season, 10);
    pending.seasonYear   = isAll ? pending.showYear : parseInt(label.dataset.year, 10);
    els.dialogSeasonOptions.querySelectorAll('.season-option')
      .forEach(l => l.classList.toggle('checked', l === label));
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
function toggleInSet(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

function posterURL(posterPath) {
  return escapeHTML(TMDB_IMG + posterPath);
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

// Mi lista (búsqueda + watchlist) o Próximos (búsqueda de series + calendario)
function applyTab() {
  const upcoming = state.tab === 'upcoming';
  els.tabButtons.forEach(b => {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  els.watchlistSection.hidden = upcoming;
  els.upcomingSection.hidden = !upcoming;
  els.searchInput.placeholder = upcoming ? 'Busca una serie para seguirla…' : 'Busca una película o serie…';
  if (lastResults) renderSearchResults(lastResults);
}

function selectCalendarDay(iso) {
  state.calDay = iso;
  // Un día gris (del mes anterior o siguiente) lleva a su mes
  if (iso.slice(0, 7) !== (state.calMonth ?? todayISO().slice(0, 7))) state.calMonth = iso.slice(0, 7);
  renderUpcoming();
}

function syncViewButtons() {
  els.viewButtons.forEach(b => b.classList.toggle('active', b.dataset.view === state.viewMode));
}

// Refleja en los controles las preferencias cargadas
function applyPrefsToUI() {
  els.sortSelect.value = state.sortBy;
  els.showWatched.checked = state.showWatched;
  syncViewButtons();
  applyTab();
}

// ---- Tema claro / oscuro ----
// El script del <head> ya ha puesto data-theme. El botón cambia al tema contrario; si ese
// coincide con el del sistema, se borra la elección y la app vuelve a seguir al sistema.
const THEME_KEY = 'watchlist:theme';
const systemLight = matchMedia('(prefers-color-scheme: light)');
const systemTheme = () => (systemLight.matches ? 'light' : 'dark');
const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
  <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>`;
const MOON_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
  <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>`;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    if (theme === systemTheme()) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {}
  syncThemeUI();
}

function syncThemeUI() {
  const light = document.documentElement.dataset.theme === 'light';
  // El icono es el del tema al que se cambia
  els.themeBtn.innerHTML = light ? MOON_ICON : SUN_ICON;
  const label = light ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro';
  els.themeBtn.title = label;
  els.themeBtn.setAttribute('aria-label', label);
  // Color de la barra del navegador / del sistema en el móvil
  document.querySelector('meta[name="theme-color"]')
    .setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
}

function setupTheme() {
  els.themeBtn.addEventListener('click', () =>
    setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  // Si no hay tema elegido, seguir los cambios del sistema en directo
  systemLight.addEventListener('change', () => {
    let chosen = null;
    try { chosen = localStorage.getItem(THEME_KEY); } catch {}
    if (!chosen) setTheme(systemTheme());
  });
  syncThemeUI();
}

// ---- Arranque ----
setupTheme();
loadPrefs();
applyPrefsToUI();
renderPlatformFilters();
setupListeners();
if (supabase) initAuth();
