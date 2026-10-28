import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  todayISO, addDays, formatShortDate, monthGrid, shiftMonth, monthTitle,
  seasonsToFetch, normalizeShow, mergeSeason, groupDrops, dropLabel, dropShortLabel,
  bucketFor, classifyShow, pendingCount, statusText, pendingText, isDropSeen,
} from '../schedule.js';

const TODAY = '2026-10-27';  // martes

// --- Datos con la forma de TMDB ---

// Capítulos de una temporada: dates[i] es la fecha del capítulo i+1
function season(number, dates, { finaleAt } = {}) {
  return {
    season_number: number,
    episodes: dates.map((d, i) => ({
      episode_number: i + 1,
      name: `Capítulo ${i + 1}`,
      air_date: d,
      episode_type: i + 1 === finaleAt ? 'finale' : 'standard',
    })),
  };
}

function details({ id = 1, status = 'Returning Series', seasons, last, next }) {
  const ref = r => r && { season_number: r[0], episode_number: r[1], air_date: r[2] };
  return {
    id,
    name: `Serie ${id}`,
    poster_path: '/p.jpg',
    status,
    networks: [{ name: 'Netflix' }],
    seasons: seasons.map(([n, airDate, count]) => ({ season_number: n, air_date: airDate, episode_count: count })),
    last_episode_to_air: ref(last),
    next_episode_to_air: ref(next),
  };
}

const weekly = (start, n) => Array.from({ length: n }, (_, i) => addDays(start, 7 * i));

// Netflix: temporada 2 completa el 30 oct, la 1 ya emitida
const netflixDetails = details({
  seasons: [[0, '2024-01-01', 3], [1, '2025-05-01', 8], [2, '2026-10-30', 8]],
  last: [1, 8, '2025-05-01'],
  next: [2, 1, '2026-10-30'],
});
const netflix = normalizeShow(netflixDetails, [
  season(1, Array(8).fill('2025-05-01')),
  season(2, Array(8).fill('2026-10-30')),
]);

// Semanal a mitad de temporada: T3 de 10 capítulos, salen los martes desde el 15 sep
const weeklyDates = weekly('2026-09-15', 10);  // E7 = 27 oct (hoy), E8 = 3 nov
const weeklyShow = normalizeShow(details({
  id: 2,
  seasons: [[1, '2022-01-01', 10], [2, '2024-01-01', 10], [3, '2026-09-15', 10]],
  last: [3, 6, '2026-10-20'],   // la ficha de TMDB (cacheada) aún no cuenta el de hoy
  next: [3, 7, '2026-10-27'],
}), [season(3, weeklyDates, { finaleAt: 10 })]);

// --- Fechas ---

test('todayISO usa la fecha local, no la UTC', () => {
  // 00:30 del 28 en hora local; en UTC (España, UTC+1/+2) aún sería el 27
  assert.equal(todayISO(new Date(2026, 9, 28, 0, 30)), '2026-10-28');
  assert.equal(todayISO(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('addDays cruza meses y años', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('formatShortDate solo pone el año si no es el actual', () => {
  assert.equal(formatShortDate('2026-03-12', TODAY), '12 mar');
  assert.equal(formatShortDate('2027-03-12', TODAY), '12 mar 2027');
});

test('monthGrid: semanas completas de lunes a domingo', () => {
  const cells = monthGrid('2026-10');  // 1 oct 2026 es jueves
  assert.equal(cells.length % 7, 0);
  assert.equal(cells[0].iso, '2026-09-28');
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[3].iso, '2026-10-01');
  assert.equal(cells.at(-1).iso, '2026-11-01');
  assert.equal(cells.filter(c => c.inMonth).length, 31);
});

test('shiftMonth y monthTitle', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(monthTitle('2026-10'), 'octubre 2026');
});

// --- TMDB ---

test('seasonsToFetch: última, próxima, puntero y futuras, sin especiales', () => {
  const d = details({
    seasons: [[0, '2020-01-01', 2], [1, '2020-01-01', 8], [2, '2022-01-01', 8], [3, '2024-01-01', 8], [4, '2027-02-01', 8]],
    last: [3, 8, '2024-02-01'],
    next: null,
  });
  assert.deepEqual(seasonsToFetch(d, 1, TODAY), [1, 3, 4]);
  assert.deepEqual(seasonsToFetch(d, null, TODAY), [3, 4]);
});

test('normalizeShow descarta la temporada 0 y anota las cargadas', () => {
  assert.deepEqual(netflix.seasons.map(s => s.number), [1, 2]);
  assert.deepEqual(netflix.loaded, [1, 2]);
  assert.equal(netflix.episodes.length, 16);
  assert.equal(netflix.network, 'Netflix');
});

test('mergeSeason sustituye una temporada ya cargada', () => {
  const again = mergeSeason(netflix, season(2, Array(6).fill('2026-11-06')));
  assert.equal(again.episodes.filter(e => e.season === 2).length, 6);
  assert.deepEqual(again.loaded, [1, 2]);
});

// --- Lanzamientos ---

test('groupDrops: una temporada de Netflix es un único bloque completo', () => {
  const drops = groupDrops(netflix).filter(d => d.season === 2);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].fullSeason, true);
  assert.equal(drops[0].count, 8);
  assert.equal(dropLabel(drops[0]), 'T2 completa · 8 caps');
  assert.equal(dropShortLabel(drops[0]), 'T2 ▣ 8');
});

test('groupDrops: semanal, un lanzamiento por capítulo y el final marcado', () => {
  const drops = groupDrops(weeklyShow);
  assert.equal(drops.length, 10);
  assert.equal(dropLabel(drops[6]), 'T3E7 · Capítulo 7');
  assert.equal(dropShortLabel(drops[6]), 'T3E7');
  assert.equal(drops[9].finale, true);
  assert.equal(drops[0].premiere, true);
});

test('groupDrops: bloque parcial de varios capítulos', () => {
  const show = normalizeShow(details({ seasons: [[1, '2026-10-01', 6]], last: [1, 3, '2026-10-01'], next: [1, 4, '2026-10-08'] }),
    [season(1, ['2026-10-01', '2026-10-01', '2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22'])]);
  const [first] = groupDrops(show);
  assert.equal(first.fullSeason, false);
  assert.equal(dropLabel(first), 'T1 · E1–E3');
  assert.equal(dropShortLabel(first), 'T1 E1–3');
});

test('groupDrops: temporada futura con fecha pero sin capítulos en TMDB', () => {
  const show = normalizeShow(details({
    seasons: [[1, '2024-01-01', 8], [2, '2027-03-12', 0]],
    last: [1, 8, '2024-02-01'],
    next: null,
  }), [season(2, [])]);
  const drops = groupDrops(show);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].announced, true);
  assert.equal(dropLabel(drops[0]), 'T2 · estreno');
});

test('bucketFor: bloques de la agenda', () => {
  assert.equal(bucketFor('2026-10-19', TODAY), null);       // hace 8 días
  assert.equal(bucketFor('2026-10-20', TODAY), 'past');
  assert.equal(bucketFor(TODAY, TODAY), 'today');
  assert.equal(bucketFor('2026-10-28', TODAY), 'tomorrow');
  assert.equal(bucketFor('2026-11-01', TODAY), 'week');     // domingo
  assert.equal(bucketFor('2026-11-02', TODAY), 'later');    // lunes siguiente
});

// --- Estado ---

test('classifyShow: semanal en emisión, contando con los capítulos cargados', () => {
  const cls = classifyShow(weeklyShow, TODAY);
  assert.deepEqual(cls, { state: 'airing', season: 3, aired: 7, total: 10, remaining: 3 });
  assert.equal(statusText(cls, TODAY), 'T3 · va por E7 de 10 · quedan 3');
});

test('classifyShow: nueva temporada con fecha', () => {
  const cls = classifyShow(netflix, TODAY);
  assert.deepEqual(cls, { state: 'premiere', season: 2, airDate: '2026-10-30' });
  assert.equal(statusText(cls, TODAY), 'T2 · 30 oct');
});

test('classifyShow: renovada sin fecha', () => {
  const show = normalizeShow(details({ seasons: [[1, '2024-01-01', 8], [2, null, 0]], last: [1, 8, '2024-02-01'], next: null }));
  assert.deepEqual(classifyShow(show, TODAY), { state: 'waiting' });
  assert.equal(statusText({ state: 'waiting' }, TODAY), 'Renovada, sin fecha');
});

test('classifyShow: finalizada', () => {
  const show = normalizeShow(details({ status: 'Ended', seasons: [[1, '2020-01-01', 8]], last: [1, 8, '2020-03-01'], next: null }));
  assert.deepEqual(classifyShow(show, TODAY), { state: 'ended' });
});

test('isDropSeen: visto solo si el puntero cubre el lanzamiento entero', () => {
  const drop = { season: 3, from: 5, to: 6 };  // E5–E6 el mismo día
  assert.equal(isDropSeen(drop, null, null), false);
  assert.equal(isDropSeen(drop, 3, 4), false);
  assert.equal(isDropSeen(drop, 3, 5), false);  // a mitad: falta E6
  assert.equal(isDropSeen(drop, 3, 6), true);
  assert.equal(isDropSeen(drop, 4, 1), true);   // ya en la temporada siguiente
  assert.equal(isDropSeen(drop, 2, 10), false);
  assert.equal(isDropSeen({ season: 4, from: 1, to: null }, 4, 3), false);  // estreno sin capítulos fechados
});

test('pendingCount: sin puntero, a mitad y al día', () => {
  assert.equal(pendingCount(weeklyShow, null, null, TODAY), null);
  assert.equal(pendingCount(weeklyShow, 3, 4, TODAY), 3);   // emitidos E5, E6 y E7
  assert.equal(pendingCount(weeklyShow, 3, 7, TODAY), 0);
  assert.equal(pendingCount(weeklyShow, 3, 9, TODAY), 0);   // puntero adelantado: nunca negativo
});

test('pendingCount: temporadas intermedias sin cargar cuentan enteras', () => {
  // puntero en T2E8 (T2 sin cargar): faltan T2E9, T2E10 y T3E1–E7
  assert.equal(pendingCount(weeklyShow, 2, 8, TODAY), 2 + 7);
  // puntero en T1E10: T2 entera (10) + 7 de T3
  assert.equal(pendingCount(weeklyShow, 1, 10, TODAY), 10 + 7);
});

test('pendingCount: la temporada de Netflix futura no cuenta todavía', () => {
  assert.equal(pendingCount(netflix, 1, 8, TODAY), 0);
  assert.equal(pendingCount(netflix, 1, 8, '2026-10-30'), 8);
});

test('pendingText', () => {
  assert.equal(pendingText(null), null);
  assert.equal(pendingText(0), 'Al día');
  assert.equal(pendingText(4), 'Te faltan 4');
});
