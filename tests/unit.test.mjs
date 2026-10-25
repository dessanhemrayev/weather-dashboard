import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialState, createStore, hydrate, loadState, reducer,
  selectVisibleFavorites, serialize, attachPersistence, STORAGE_KEY, MAX_COMPARE,
} from '../js/state.js';
import { ApiError, fetchForecasts, isAbortError, searchCities } from '../js/api.js';
import { debounce, formatDay, formatTemp } from '../js/utils.js';

const city = (id, name, extra = {}) => ({ id, name, country: 'Россия', admin1: '', latitude: 50, longitude: 36, ...extra });
const withCities = (...cities) => cities.reduce((s, c) => reducer(s, { type: 'FAVORITE_ADD', city: c }), createInitialState());
const forecast = (temp, precip, wind) => ({
  current: { temp, feels: temp, humidity: 50, wind, code: 0, time: null },
  daily: [{ date: '2026-10-26', code: 0, tmax: temp, tmin: temp - 5, precip, wind }],
});

const memoryStorage = () => {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, v), data };
};

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  return calls;
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// ---------- reducer ----------

test('избранное: добавление без дублей и удаление чистит сравнение и прогноз', () => {
  let s = withCities(city('1', 'Курск'), city('2', 'Москва'));
  s = reducer(s, { type: 'FAVORITE_ADD', city: city('1', 'Курск') });
  assert.equal(s.favorites.length, 2);
  s = reducer(s, { type: 'COMPARE_TOGGLE', id: '1' });
  s = reducer(s, { type: 'LOAD_SUCCESS', forecasts: { 1: forecast(1, 0, 1), 2: forecast(2, 0, 1) }, at: 5 });
  s = reducer(s, { type: 'FAVORITE_REMOVE', id: '1' });
  assert.deepEqual(s.compare.ids, []);
  assert.equal('1' in s.forecasts, false);
});

test('сравнение: не больше MAX_COMPARE и только избранные города', () => {
  const many = Array.from({ length: 6 }, (_, i) => city(String(i), `Город${i}`));
  let s = withCities(...many);
  for (const c of many) s = reducer(s, { type: 'COMPARE_TOGGLE', id: c.id });
  assert.equal(s.compare.ids.length, MAX_COMPARE);
  assert.equal(reducer(s, { type: 'COMPARE_TOGGLE', id: 'нет-такого' }), s);
});

test('reducer не мутирует прежнее состояние', () => {
  const before = withCities(city('1', 'Курск'));
  const snapshot = JSON.stringify(before);
  reducer(before, { type: 'SET_SORT', key: 'temp' });
  reducer(before, { type: 'FAVORITE_REMOVE', id: '1' });
  assert.equal(JSON.stringify(before), snapshot);
});

test('ошибка загрузки не стирает прежние данные', () => {
  let s = withCities(city('1', 'Курск'));
  s = reducer(s, { type: 'LOAD_SUCCESS', forecasts: { 1: forecast(3, 0, 1) }, at: 10 });
  s = reducer(s, { type: 'LOAD_START' });
  s = reducer(s, { type: 'LOAD_ERROR', error: 'нет сети' });
  assert.equal(s.load.status, 'error');
  assert.ok(s.forecasts['1']);
  assert.equal(s.fetchedAt, 10);
});

test('повторный выбор критерия сортировки меняет направление', () => {
  let s = createInitialState();
  s = reducer(s, { type: 'SET_SORT', key: 'temp' });
  assert.deepEqual(s.sort, { key: 'temp', dir: 'asc' });
  s = reducer(s, { type: 'SET_SORT', key: 'temp' });
  assert.deepEqual(s.sort, { key: 'temp', dir: 'desc' });
  s = reducer(s, { type: 'SET_SORT', key: 'wind' });
  assert.deepEqual(s.sort, { key: 'wind', dir: 'asc' });
  assert.equal(reducer(s, { type: 'SET_SORT', key: 'мусор' }), s);
});

// ---------- фильтр и сортировка ----------

test('сортировка по температуре; города без данных всегда в конце', () => {
  let s = withCities(city('1', 'Анапа'), city('2', 'Бор'), city('3', 'Вологда'));
  s = reducer(s, { type: 'LOAD_SUCCESS', forecasts: { 1: forecast(10, 0, 1), 3: forecast(-2, 0, 1) }, at: 1 });
  s = reducer(s, { type: 'SET_SORT', key: 'temp' });
  assert.deepEqual(selectVisibleFavorites(s).map((c) => c.name), ['Вологда', 'Анапа', 'Бор']);
  s = reducer(s, { type: 'SET_SORT', key: 'temp' }); // по убыванию
  assert.deepEqual(selectVisibleFavorites(s).map((c) => c.name), ['Анапа', 'Вологда', 'Бор']);
});

test('фильтр по тексту без учёта регистра и по осадкам', () => {
  let s = withCities(city('1', 'Курск'), city('2', 'Курган'), city('3', 'Москва'));
  s = reducer(s, { type: 'LOAD_SUCCESS', forecasts: { 1: forecast(1, 2.5, 1), 2: forecast(1, 0, 1), 3: forecast(1, 1, 1) }, at: 1 });
  s = reducer(s, { type: 'SET_FILTER_TEXT', text: 'КУР' });
  assert.deepEqual(selectVisibleFavorites(s).map((c) => c.name), ['Курган', 'Курск']);
  s = reducer(s, { type: 'SET_ONLY_RAIN', value: true });
  assert.deepEqual(selectVisibleFavorites(s).map((c) => c.name), ['Курск']);
});

// ---------- localStorage ----------

test('состояние сохраняется и восстанавливается; поиск и загрузка не сохраняются', () => {
  const storage = memoryStorage();
  const store = createStore(createInitialState());
  attachPersistence(store, storage);
  store.dispatch({ type: 'FAVORITE_ADD', city: city('1', 'Курск') });
  store.dispatch({ type: 'SET_SORT', key: 'wind' });
  store.dispatch({ type: 'SET_FILTER_TEXT', text: 'ку' });
  store.dispatch({ type: 'LOAD_START' });
  store.dispatch({ type: 'SEARCH_INPUT', query: 'Москва' });

  const restored = loadState(storage);
  assert.deepEqual(restored.favorites.map((c) => c.name), ['Курск']);
  assert.equal(restored.sort.key, 'wind');
  assert.equal(restored.filter.text, 'ку');
  assert.equal(restored.load.status, 'idle');
  assert.equal(restored.search.query, '');
});

test('испорченное хранилище не ломает запуск', () => {
  for (const bad of ['{не json', 'null', '"строка"', '[]', '{"favorites":"x","sort":{"key":"зло"},"compare":{"ids":[1]}}']) {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, bad);
    const s = loadState(storage);
    assert.deepEqual(s.favorites, []);
    assert.equal(s.sort.key, 'name');
  }
  const throwing = { getItem() { throw new Error('запрещено'); }, setItem() { throw new Error('запрещено'); } };
  assert.deepEqual(loadState(throwing).favorites, []);
  const store = createStore(createInitialState());
  attachPersistence(store, throwing);
  store.dispatch({ type: 'FAVORITE_ADD', city: city('1', 'Курск') }); // не должно бросить
});

test('hydrate отбрасывает города с неверными координатами и чужие id в сравнении', () => {
  const s = hydrate({
    favorites: [city('1', 'Курск'), { id: '2', name: 'Битый', latitude: 'x', longitude: 1 }, city('1', 'Дубль')],
    compare: { ids: ['1', '2', '99'], metric: 'precip' },
  });
  assert.deepEqual(s.favorites.map((c) => c.id), ['1']);
  assert.deepEqual(s.compare, { ids: ['1'], metric: 'precip' });
  assert.equal(typeof serialize(s), 'string');
});

// ---------- сеть ----------

test('searchCities: разбирает результаты и пропускает мусор', async () => {
  const calls = mockFetch(() => json({ results: [
    { id: 1, name: 'Курск', country: 'Россия', admin1: 'Курская область', latitude: 51.73, longitude: 36.19 },
    { id: 2, name: '', latitude: 1, longitude: 1 },
    { id: 3, name: 'Без координат' },
    null,
  ] }));
  const result = await searchCities('  Курск ');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '1');
  assert.match(calls[0], /name=%D0%9A%D1%83%D1%80%D1%81%D0%BA/);
});

test('searchCities: пустой ответ без поля results — это пустой список, не ошибка', async () => {
  mockFetch(() => json({ generationtime_ms: 0.4 }));
  assert.deepEqual(await searchCities('ъъъъ'), []);
});

test('ошибки сети: сеть, HTTP-коды, не-JSON', async () => {
  mockFetch(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(searchCities('курск'), (e) => e instanceof ApiError && e.kind === 'network');

  mockFetch(() => json({}, 500));
  await assert.rejects(searchCities('курск'), (e) => e.kind === 'http' && e.status === 500);

  mockFetch(() => json({}, 429));
  await assert.rejects(searchCities('курск'), (e) => e.kind === 'http' && /Слишком много/.test(e.message));

  mockFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }));
  await assert.rejects(searchCities('курск'), (e) => e.kind === 'parse');
});

test('отмена через AbortController даёт AbortError, а не ApiError', async () => {
  mockFetch((_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const controller = new AbortController();
  const pending = searchCities('курск', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => isAbortError(e));

  const already = new AbortController();
  already.abort();
  await assert.rejects(searchCities('курск', { signal: already.signal }), (e) => isAbortError(e));
});

test('fetchForecasts: один город (объект), несколько (массив), пропуски в данных', async () => {
  const item = (t) => ({
    current: { time: '2026-10-25T12:00', temperature_2m: t, apparent_temperature: t - 1, relative_humidity_2m: 70, weather_code: 3, wind_speed_10m: 5 },
    daily: { time: ['2026-10-25', '2026-10-26'], weather_code: [3, null], temperature_2m_max: [t, null], temperature_2m_min: [t - 4], precipitation_sum: [0.2, 1], wind_speed_10m_max: [8, 9] },
  });
  const cities = [city('a', 'А'), city('b', 'Б')];

  mockFetch(() => json([item(4), item(7)]));
  const many = await fetchForecasts(cities);
  assert.equal(many.a.current.temp, 4);
  assert.equal(many.b.daily[1].tmax, null);
  assert.equal(many.b.daily[1].tmin, null);

  mockFetch(() => json(item(9)));
  const one = await fetchForecasts([cities[0]]);
  assert.equal(one.a.current.temp, 9);

  mockFetch(() => json([item(1), { reason: 'нет данных' }]));
  const partial = await fetchForecasts(cities);
  assert.deepEqual(Object.keys(partial), ['a']);

  mockFetch(() => json([{}, {}]));
  await assert.rejects(fetchForecasts(cities), (e) => e.kind === 'data');

  assert.deepEqual(await fetchForecasts([]), {});
});

// ---------- утилиты ----------

test('debounce: вызывает функцию один раз с последними аргументами', async () => {
  const seen = [];
  const d = debounce((v) => seen.push(v), 30);
  d(1); d(2); d(3);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seen, [3]);

  d(4); d.cancel();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, [3]);

  d(5); d.flush();
  assert.deepEqual(seen, [3, 5]);
});

test('форматирование: пропуски и даты без сдвига часового пояса', () => {
  assert.equal(formatTemp(null), '—');
  assert.equal(formatTemp(-0.4), '0°'); // без «-0»
  assert.equal(formatTemp(-3.6), '-4°');
  assert.equal(formatDay('не дата'), '—');
  assert.match(formatDay('2026-11-04'), /4/);
});
