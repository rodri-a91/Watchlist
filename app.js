// ==========================================
// Watchlist — lógica de la aplicación
// ==========================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';
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
  };
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
function fetchMovieDetails(tmdbId) {
  return tmdbGet(`/movie/${tmdbId}`);
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
};

// ---- Preferencias (por navegador) ----
// Vista, orden y "Mostrar vistos" se recuerdan entre visitas. localStorage puede
// no estar disponible (modo privado, bloqueado…): en ese caso se usan los valores por defecto.
const PREFS_KEY = 'watchlist:prefs';
const SORT_OPTIONS = ['added_desc', 'year_desc', 'year_asc', 'duration_desc', 'duration_asc'];

function loadPrefs() {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch {}
  if (prefs.viewMode === 'grid' || prefs.viewMode === 'list') state.viewMode = prefs.viewMode;
  if (SORT_OPTIONS.includes(prefs.sortBy)) state.sortBy = prefs.sortBy;
  if (typeof prefs.showWatched === 'boolean') state.showWatched = prefs.showWatched;
}

function savePrefs() {
  const { viewMode, sortBy, showWatched } = state;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ viewMode, sortBy, showWatched })); } catch {}
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
  viewButtons:      document.querySelectorAll('.view-btn'),
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

  const genreLine = (item.genres && item.genres.length)
    ? `<div class="item-genres">${item.genres.map(escapeHTML).join(' · ')}</div>`
    : '';

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
  const metaLine = metaParts.join(' · ');

  return `
    <div class="item-card ${item.watched ? 'watched' : ''}"
         data-id="${item.id}"
         style="animation-delay: ${Math.min(i * 25, 400)}ms">
      ${poster}
      <div class="item-info">
        <h3 class="item-title item-open">${escapedTitle}${seasonBadge}</h3>
        <div class="item-year">${metaLine}</div>
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
    const badge = inListLabel(item);
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
      const tmdbItem = normalizeTMDBItem(results[idx]);
      openAddDialog(tmdbItem);
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
    renderDetailActions(id, findTrailer(details));
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
  return parts.join('');
}

// Tráiler de YouTube: preferimos en español y oficial
function findTrailer(details) {
  const videos = (details.videos?.results || [])
    .filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
  const score = v => (v.iso_639_1 === 'es' ? 4 : 0) + (v.type === 'Trailer' ? 2 : 0) + (v.official ? 1 : 0);
  const best = videos.sort((a, b) => score(b) - score(a))[0];
  return best ? `https://www.youtube.com/watch?v=${encodeURIComponent(best.key)}` : null;
}

// Botones de la ficha. Se re-renderizan al marcar como visto.
function renderDetailActions(id, trailerURL) {
  const box = $('detail-actions');
  const item = state.items.find(i => i.id === id);
  if (!box || !item || detailItemId !== id) return;
  if (trailerURL !== undefined) box.dataset.trailer = trailerURL || '';
  const trailer = box.dataset.trailer;
  box.innerHTML = `
    ${trailer ? `<a class="btn-ghost detail-trailer" href="${escapeHTML(trailer)}" target="_blank" rel="noopener">▶ Ver tráiler</a>` : ''}
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

  els.dialogSeasonOptions.querySelectorAll('.season-option').forEach(label => {
    label.addEventListener('click', e => {
      e.preventDefault();
      const seasonAttr = label.dataset.season;
      const isAll = seasonAttr === 'all';
      state.pendingItem.seasonNumber = isAll ? null : parseInt(seasonAttr, 10);
      state.pendingItem.seasonYear   = isAll ? state.pendingItem.showYear : parseInt(label.dataset.year, 10);

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

  // Bloquear el botón mientras hacemos las llamadas a TMDB
  els.dialogSave.disabled = true;
  els.dialogSave.textContent = 'Guardando…';

  try {
    // Resolver duración según el tipo y la temporada elegida.
    // En edición, si la temporada no cambia, reutilizamos la duración guardada.
    const keepDuration = mode === 'edit'
      && seasonNumber === data.season_number
      && data.duration_minutes != null;
    const [duration, episodeCount] = await Promise.all([
      keepDuration ? data.duration_minutes : resolveDuration(data, seasonNumber),
      resolveEpisodeCount(data, seasonNumber),  // usa los detalles de la serie ya cacheados
    ]);

    const fields = {
      platforms,
      season_number:    seasonNumber,
      year:             seasonYear ?? data.year,
      duration_minutes: duration,
      episode_count:    episodeCount,
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

// Rellena en segundo plano la duración y los capítulos de los títulos que no los tienen
// (p. ej. guardados antes de que existieran esos cálculos). Va de uno en uno para no
// saturar TMDB, y cada título se intenta como mucho una vez por carga de página.
const backfillTried = new Set();
let backfillRunning = false;
const missingDuration = i => i.duration_minutes == null;
const missingEpisodes = i => i.type === 'tv' && i.episode_count == null;

async function backfillMissingInfo() {
  if (backfillRunning) return;
  backfillRunning = true;
  let changed = 0;
  try {
    const pending = state.items.filter(i =>
      (missingDuration(i) || missingEpisodes(i)) && !backfillTried.has(i.id));
    for (const item of pending) {
      backfillTried.add(item.id);
      const season = item.season_number;
      const [duration, episodes] = await Promise.all([
        missingDuration(item) ? resolveDuration(item, season) : null,
        missingEpisodes(item) ? resolveEpisodeCount(item, season) : null,
      ]);
      // Puede haberse editado o borrado mientras esperábamos a TMDB
      const current = state.items.find(i => i.id === item.id);
      if (!current || current.season_number !== season) continue;
      const updates = {};
      if (duration != null && missingDuration(current)) updates.duration_minutes = duration;
      if (episodes != null && missingEpisodes(current)) updates.episode_count = episodes;
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
  // limpiar búsqueda
  els.searchInput.value = '';
  els.searchResults.innerHTML = '';
  return true;
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
  els.detailDialog.addEventListener('close', () => { detailItemId = null; });
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

  els.dialogChecks.addEventListener('click', e => {
    const label = e.target.closest('.platform-check');
    if (!label || !state.pendingItem) return;
    e.preventDefault();
    const pending = state.pendingItem;
    pending.touched = true;  // a partir de aquí las sugerencias no cambian la selección
    toggleInSet(pending.selected, label.dataset.platform);
    const checked = pending.selected.has(label.dataset.platform);
    label.classList.toggle('checked', checked);
    label.querySelector('input').checked = checked;
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

function syncViewButtons() {
  els.viewButtons.forEach(b => b.classList.toggle('active', b.dataset.view === state.viewMode));
}

// Refleja en los controles las preferencias cargadas
function applyPrefsToUI() {
  els.sortSelect.value = state.sortBy;
  els.showWatched.checked = state.showWatched;
  syncViewButtons();
}

// ---- Arranque ----
loadPrefs();
applyPrefsToUI();
renderPlatformFilters();
setupListeners();
if (supabase) initAuth();
