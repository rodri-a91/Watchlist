// ==========================================
// Próximos — lógica pura del calendario de series seguidas
// Sin DOM ni red: lo importan app.js y los tests (node --test test/)
// ==========================================

// Las fechas van siempre como texto 'YYYY-MM-DD'. En ese formato el orden
// alfabético coincide con el cronológico, así que se comparan con < y >.

const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG  = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
                      'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ---- Fechas ----

// Fecha local de hoy. toISOString() daría la fecha en UTC, que en España
// entre medianoche y la 1-2 de la mañana todavía es "ayer".
export function todayISO(now = new Date()) {
  return toISO(now);
}

function toISO(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);  // medianoche local
}

export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// "12 mar"; con el año solo si no es el de hoy: "12 mar 2027"
export function formatShortDate(iso, today) {
  const [y, m, d] = iso.split('-').map(Number);
  const base = `${d} ${MONTHS_SHORT[m - 1]}`;
  return today && today.slice(0, 4) === iso.slice(0, 4) ? base : `${base} ${y}`;
}

// ---- Calendario mensual ----

// Celdas de semanas completas (lunes a domingo) que cubren el mes 'YYYY-MM'
export function monthGrid(ym) {
  const [y, m] = ym.split('-').map(Number);
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;  // lunes = 0
  const daysInMonth = new Date(y, m, 0).getDate();
  const total = Math.ceil((offset + daysInMonth) / 7) * 7;
  return Array.from({ length: total }, (_, i) => {
    const d = new Date(y, m - 1, 1 - offset + i);
    return { iso: toISO(d), inMonth: d.getMonth() === m - 1 };
  });
}

export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return toISO(new Date(y, m - 1 + n, 1)).slice(0, 7);
}

export function monthTitle(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

// ---- Datos de TMDB ----

// Temporadas que hay que pedir a TMDB: la del último capítulo emitido, la del
// próximo, la del puntero "voy por" y las que tienen estreno futuro. Nunca la 0 (especiales).
export function seasonsToFetch(details, seenSeason, today) {
  const nums = new Set();
  const candidates = [
    details.last_episode_to_air?.season_number,
    details.next_episode_to_air?.season_number,
    seenSeason,
  ];
  candidates.forEach(n => { if (n > 0) nums.add(n); });
  (details.seasons || []).forEach(s => {
    if (s.season_number > 0 && s.air_date && s.air_date > today) nums.add(s.season_number);
  });
  return [...nums].sort((a, b) => a - b);
}

// Serie normalizada a partir de /tv/{id} y de las temporadas pedidas (/tv/{id}/season/{n}).
// `loaded` dice qué temporadas tienen sus capítulos en `episodes`.
export function normalizeShow(details, seasonDetails = []) {
  const show = {
    tmdbId:    details.id,
    title:     details.name,
    poster:    details.poster_path ?? null,
    status:    details.status ?? null,
    network:   details.networks?.[0]?.name ?? null,
    seasons:   (details.seasons || [])
      .filter(s => s.season_number > 0)
      .map(s => ({ number: s.season_number, airDate: s.air_date || null, episodeCount: s.episode_count || 0 }))
      .sort((a, b) => a.number - b.number),
    lastAired: episodeRef(details.last_episode_to_air),
    nextToAir: episodeRef(details.next_episode_to_air),
    episodes:  [],
    loaded:    [],
  };
  return seasonDetails.filter(Boolean).reduce(mergeSeason, show);
}

function episodeRef(e) {
  return e ? { season: e.season_number, episode: e.episode_number, airDate: e.air_date || null } : null;
}

// Añade (o sustituye) los capítulos de una temporada. Devuelve una serie nueva.
export function mergeSeason(show, seasonDetail) {
  const number = seasonDetail.season_number;
  const episodes = (seasonDetail.episodes || []).map(e => ({
    season:  number,
    episode: e.episode_number,
    name:    e.name || '',
    airDate: e.air_date || null,
    type:    e.episode_type || 'standard',  // 'finale' | 'mid_season' | 'standard'
  }));
  return {
    ...show,
    episodes: [...show.episodes.filter(e => e.season !== number), ...episodes]
      .sort((a, b) => a.season - b.season || a.episode - b.episode),
    loaded: [...new Set([...show.loaded, number])].sort((a, b) => a - b),
  };
}

// ---- Lanzamientos ----

// Agrupa los capítulos de una serie que salen el mismo día en un "lanzamiento".
// Así una temporada de Netflix (todos los capítulos a la vez) es un único bloque.
export function groupDrops(show) {
  const seasonInfo = new Map(show.seasons.map(s => [s.number, s]));
  const groups = new Map();
  for (const e of show.episodes) {
    if (!e.airDate) continue;
    const key = `${e.season}|${e.airDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const drops = [...groups.values()].map(eps => {
    const first = eps[0];
    const last = eps[eps.length - 1];
    const total = seasonInfo.get(first.season)?.episodeCount || 0;
    return {
      tmdbId:     show.tmdbId,
      airDate:    first.airDate,
      season:     first.season,
      from:       first.episode,
      to:         last.episode,
      count:      eps.length,
      name:       eps.length === 1 ? first.name : null,
      fullSeason: eps.length > 1 && first.episode === 1 && eps.length >= total,
      premiere:   first.episode === 1,
      finale:     eps.some(e => e.type === 'finale') || (total > 0 && last.episode === total),
      announced:  false,
    };
  });

  // Temporadas aún no emitidas con fecha pero sin capítulos fechados en TMDB:
  // se muestra el estreno igualmente, sin detalle de capítulos
  const dated = new Set(show.episodes.filter(e => e.airDate).map(e => e.season));
  const lastSeason = show.lastAired?.season ?? 0;
  for (const s of show.seasons) {
    if (!s.airDate || dated.has(s.number) || s.number <= lastSeason) continue;
    drops.push({
      tmdbId: show.tmdbId, airDate: s.airDate, season: s.number, from: 1, to: null,
      count: s.episodeCount, name: null, fullSeason: false, premiere: true, finale: false, announced: true,
    });
  }

  return drops.sort((a, b) => a.airDate.localeCompare(b.airDate) || a.season - b.season);
}

const caps = n => `${n} ${n === 1 ? 'cap' : 'caps'}`;

// Etiqueta larga (agenda): "T2 completa · 8 caps", "T2 · E1–E3", "T2E5 · Título"
export function dropLabel(drop) {
  const t = `T${drop.season}`;
  if (drop.announced) return drop.count ? `${t} · estreno · ${caps(drop.count)}` : `${t} · estreno`;
  if (drop.fullSeason) return `${t} completa · ${caps(drop.count)}`;
  if (drop.count > 1) return `${t} · E${drop.from}–E${drop.to}`;
  return drop.name ? `${t}E${drop.from} · ${drop.name}` : `${t}E${drop.from}`;
}

// Etiqueta corta (chips del calendario): "T2 ▣ 8", "T2 E1–3", "T2E5", "T3 ★"
export function dropShortLabel(drop) {
  const t = `T${drop.season}`;
  if (drop.announced) return `${t} ★`;
  if (drop.fullSeason) return `${t} ▣ ${drop.count}`;
  if (drop.count > 1) return `${t} E${drop.from}–${drop.to}`;
  return `${t}E${drop.from}`;
}

// Bloque de la agenda para una fecha, o null si queda fuera (más de 7 días atrás)
export function bucketFor(iso, today) {
  if (iso < addDays(today, -7)) return null;
  if (iso < today) return 'past';
  if (iso === today) return 'today';
  if (iso === addDays(today, 1)) return 'tomorrow';
  const daysToSunday = 6 - (fromISO(today).getDay() + 6) % 7;
  if (iso <= addDays(today, daysToSunday)) return 'week';
  return 'later';
}

// ---- Estado de la serie ----

const ENDED_STATUSES = ['Ended', 'Canceled'];

export const STATUS_LABELS = {
  'Returning Series': 'En curso',
  'In Production':    'En producción',
  'Planned':          'Planeada',
  'Pilot':            'Piloto',
  'Ended':            'Finalizada',
  'Canceled':         'Cancelada',
};

// Último capítulo emitido de una temporada (su número), con los capítulos cargados
// si los hay y, si no, con lo que dice la ficha de la serie.
export function airedInSeason(show, season, today) {
  if (show.loaded.includes(season.number)) {
    return show.episodes
      .filter(e => e.season === season.number && e.airDate && e.airDate <= today)
      .reduce((max, e) => Math.max(max, e.episode), 0);
  }
  const last = show.lastAired;
  if (!last || season.number > last.season) return 0;
  if (season.number < last.season) return season.episodeCount;
  return last.episode;
}

// airing:   temporada en curso         { season, aired, total, remaining }
// premiere: próxima temporada con fecha { season, airDate }
// waiting:  renovada, sin fecha
// ended:    finalizada o cancelada
export function classifyShow(show, today) {
  const last = show.lastAired;
  const next = show.nextToAir;

  if (next && last && next.season === last.season) {
    const season = show.seasons.find(s => s.number === last.season)
      ?? { number: last.season, episodeCount: 0 };
    const aired = airedInSeason(show, season, today);
    const total = season.episodeCount || null;
    const remaining = total != null && total > aired ? total - aired : null;
    return { state: 'airing', season: last.season, aired, total, remaining };
  }
  if (next?.airDate) {
    return { state: 'premiere', season: next.season, airDate: next.airDate };
  }
  const upcoming = show.seasons.find(s => s.airDate && s.airDate > today);
  if (upcoming) {
    return { state: 'premiere', season: upcoming.number, airDate: upcoming.airDate };
  }
  if (ENDED_STATUSES.includes(show.status)) return { state: 'ended' };
  return { state: 'waiting' };
}

// Si el "voy por" cubre todos los capítulos del lanzamiento (si cae a mitad, aún queda algo por ver)
export function isDropSeen(drop, seenSeason, seenEpisode) {
  if (seenSeason == null) return false;
  if (seenSeason !== drop.season) return seenSeason > drop.season;
  return drop.to != null && seenEpisode >= drop.to;
}

// Capítulos ya emitidos después del puntero "voy por". null si no hay puntero.
export function pendingCount(show, seenSeason, seenEpisode, today) {
  if (seenSeason == null) return null;
  let total = 0;
  for (const s of show.seasons) {
    if (s.number < seenSeason) continue;
    const aired = airedInSeason(show, s, today);
    total += s.number === seenSeason ? Math.max(0, aired - seenEpisode) : aired;
  }
  return total;
}

// "va por E5 de 8 · quedan 3", "T3 · 12 mar", "Renovada, sin fecha", "Finalizada"
export function statusText(cls, today) {
  switch (cls.state) {
    case 'airing': {
      const of = cls.total ? ` de ${cls.total}` : '';
      const left = cls.remaining ? ` · quedan ${cls.remaining}` : '';
      return `T${cls.season} · va por E${cls.aired}${of}${left}`;
    }
    case 'premiere': return `T${cls.season} · ${formatShortDate(cls.airDate, today)}`;
    case 'waiting':  return 'Renovada, sin fecha';
    case 'ended':    return 'Finalizada';
    default:         return '';
  }
}

// null sin puntero: en ese caso no se muestra nada
export function pendingText(n) {
  if (n == null) return null;
  if (n === 0) return 'Al día';
  return `Te faltan ${n}`;
}
