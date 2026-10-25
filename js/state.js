'use strict';

/**
 * Единый объект состояния. Поток данных в одну сторону:
 *   событие → dispatch(действие) → reducer → новое состояние → render.
 * Reducer чистый: ничего не читает из сети и DOM, не меняет прежнее состояние.
 * Сохранение в localStorage подключено к store отдельно (attachPersistence).
 */
import { isNum } from './utils.js';

export const STORAGE_KEY = 'weather-dashboard:v1';
export const MAX_COMPARE = 4;
export const MAX_FAVORITES = 12;
export const MIN_QUERY_LENGTH = 2;

export const SORT_KEYS = ['name', 'temp', 'precip', 'wind'];
export const METRICS = ['temp', 'precip', 'wind'];

export function createInitialState() {
  return {
    favorites: [], // [{id, name, country, admin1, latitude, longitude}]
    forecasts: {}, // {id: {current, daily[]}}
    fetchedAt: null, // время последней успешной загрузки, мс
    load: { status: 'idle', error: null }, // idle | loading | success | error
    search: { query: '', status: 'idle', results: [], error: null }, // idle | loading | success | error
    filter: { text: '', onlyRain: false },
    sort: { key: 'name', dir: 'asc' },
    compare: { ids: [], metric: 'temp' },
  };
}

// ---------- reducer ----------

export function reducer(state, action) {
  switch (action.type) {
    case 'SEARCH_INPUT': {
      const query = action.query;
      // Короткий запрос сбрасывает прежние результаты: сервису он ничего не скажет.
      if (query.trim().length < MIN_QUERY_LENGTH) {
        return { ...state, search: { query, status: 'idle', results: [], error: null } };
      }
      return { ...state, search: { ...state.search, query } };
    }
    case 'SEARCH_START':
      return { ...state, search: { ...state.search, status: 'loading', error: null } };
    case 'SEARCH_SUCCESS':
      return { ...state, search: { ...state.search, status: 'success', results: action.results, error: null } };
    case 'SEARCH_ERROR':
      return { ...state, search: { ...state.search, status: 'error', results: [], error: action.error } };
    case 'SEARCH_CLEAR':
      return { ...state, search: { query: '', status: 'idle', results: [], error: null } };

    case 'FAVORITE_ADD': {
      if (state.favorites.some((city) => city.id === action.city.id)) return state;
      if (state.favorites.length >= MAX_FAVORITES) return state;
      return { ...state, favorites: [...state.favorites, action.city] };
    }
    case 'FAVORITE_REMOVE': {
      const forecasts = { ...state.forecasts };
      delete forecasts[action.id];
      return {
        ...state,
        favorites: state.favorites.filter((city) => city.id !== action.id),
        forecasts,
        compare: { ...state.compare, ids: state.compare.ids.filter((id) => id !== action.id) },
      };
    }

    case 'LOAD_START':
      return { ...state, load: { status: 'loading', error: null } };
    case 'LOAD_SUCCESS':
      return {
        ...state,
        forecasts: action.forecasts,
        fetchedAt: action.at,
        load: { status: 'success', error: null },
      };
    case 'LOAD_CANCEL':
      return state.load.status === 'loading' ? { ...state, load: { status: 'idle', error: null } } : state;
    case 'LOAD_ERROR':
      // Прошлые данные остаются на экране: ошибка не стирает то, что уже загружено.
      return { ...state, load: { status: 'error', error: action.error } };

    case 'SET_FILTER_TEXT':
      return { ...state, filter: { ...state.filter, text: action.text } };
    case 'SET_ONLY_RAIN':
      return { ...state, filter: { ...state.filter, onlyRain: Boolean(action.value) } };
    case 'SET_SORT': {
      if (!SORT_KEYS.includes(action.key)) return state;
      // Повторный выбор того же критерия меняет направление.
      const dir = state.sort.key === action.key && state.sort.dir === 'asc' ? 'desc' : 'asc';
      return { ...state, sort: { key: action.key, dir } };
    }

    case 'COMPARE_TOGGLE': {
      const ids = state.compare.ids;
      if (ids.includes(action.id)) {
        return { ...state, compare: { ...state.compare, ids: ids.filter((id) => id !== action.id) } };
      }
      if (ids.length >= MAX_COMPARE) return state;
      if (!state.favorites.some((city) => city.id === action.id)) return state;
      return { ...state, compare: { ...state.compare, ids: [...ids, action.id] } };
    }
    case 'COMPARE_CLEAR':
      return { ...state, compare: { ...state.compare, ids: [] } };
    case 'SET_METRIC':
      return METRICS.includes(action.metric)
        ? { ...state, compare: { ...state.compare, metric: action.metric } }
        : state;

    default:
      return state;
  }
}

// ---------- store ----------

export function createStore(initialState, rootReducer = reducer) {
  let state = initialState;
  const listeners = new Set();

  return {
    getState: () => state,
    dispatch(action) {
      const next = rootReducer(state, action);
      if (next === state) return;
      state = next;
      listeners.forEach((listener) => listener(state, action));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---------- селекторы (производные данные) ----------

const sortValue = (state, city, key) => {
  const forecast = state.forecasts[city.id];
  if (key === 'name') return city.name.toLocaleLowerCase('ru');
  if (!forecast) return null;
  if (key === 'temp') return isNum(forecast.current.temp) ? forecast.current.temp : null;
  const today = forecast.daily[0];
  if (!today) return null;
  if (key === 'precip') return isNum(today.precip) ? today.precip : null;
  if (key === 'wind') return isNum(today.wind) ? today.wind : null;
  return null;
};

/** Избранные города после фильтра и сортировки. Города без данных идут в конец. */
export function selectVisibleFavorites(state) {
  const text = state.filter.text.trim().toLocaleLowerCase('ru');
  const { key, dir } = state.sort;
  const factor = dir === 'desc' ? -1 : 1;

  const filtered = state.favorites.filter((city) => {
    if (text && !city.name.toLocaleLowerCase('ru').includes(text)) return false;
    if (state.filter.onlyRain) {
      const today = state.forecasts[city.id]?.daily[0];
      if (!today || !isNum(today.precip) || today.precip <= 0) return false;
    }
    return true;
  });

  return filtered
    .map((city, index) => ({ city, index, value: sortValue(state, city, key) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      const order = typeof a.value === 'string' ? a.value.localeCompare(b.value, 'ru') : a.value - b.value;
      return order * factor || a.index - b.index;
    })
    .map((item) => item.city);
}

export function selectCompareCities(state) {
  return state.compare.ids
    .map((id) => state.favorites.find((city) => city.id === id))
    .filter(Boolean);
}

// ---------- localStorage ----------

const cleanString = (value, max = 100) => (typeof value === 'string' ? value.slice(0, max) : '');

function sanitizeCity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanString(raw.name).trim();
  if (!name || typeof raw.id !== 'string' || !raw.id) return null;
  if (!isNum(raw.latitude) || !isNum(raw.longitude)) return null;
  return {
    id: raw.id.slice(0, 40),
    name,
    country: cleanString(raw.country),
    admin1: cleanString(raw.admin1),
    latitude: raw.latitude,
    longitude: raw.longitude,
  };
}

function sanitizeForecasts(raw, favorites) {
  if (!raw || typeof raw !== 'object') return {};
  const result = {};
  for (const city of favorites) {
    const item = raw[city.id];
    if (item && typeof item === 'object' && item.current && Array.isArray(item.daily)) {
      result[city.id] = item;
    }
  }
  return result;
}

/**
 * Собирает состояние из сохранённого JSON. Всё, что не проходит проверку,
 * заменяется значением по умолчанию: испорченное хранилище не должно ломать приложение.
 */
export function hydrate(raw) {
  const state = createInitialState();
  if (!raw || typeof raw !== 'object') return state;

  const favorites = [];
  if (Array.isArray(raw.favorites)) {
    for (const item of raw.favorites) {
      const city = sanitizeCity(item);
      if (city && !favorites.some((c) => c.id === city.id) && favorites.length < MAX_FAVORITES) {
        favorites.push(city);
      }
    }
  }
  state.favorites = favorites;
  state.forecasts = sanitizeForecasts(raw.forecasts, favorites);
  state.fetchedAt = isNum(raw.fetchedAt) ? raw.fetchedAt : null;

  if (raw.filter && typeof raw.filter === 'object') {
    state.filter = { text: cleanString(raw.filter.text, 60), onlyRain: raw.filter.onlyRain === true };
  }
  if (raw.sort && SORT_KEYS.includes(raw.sort.key)) {
    state.sort = { key: raw.sort.key, dir: raw.sort.dir === 'desc' ? 'desc' : 'asc' };
  }
  if (raw.compare && typeof raw.compare === 'object') {
    const ids = Array.isArray(raw.compare.ids) ? raw.compare.ids : [];
    state.compare = {
      ids: ids.filter((id) => favorites.some((c) => c.id === id)).slice(0, MAX_COMPARE),
      metric: METRICS.includes(raw.compare.metric) ? raw.compare.metric : 'temp',
    };
  }
  return state;
}

export function loadState(storage) {
  try {
    const text = storage.getItem(STORAGE_KEY);
    return hydrate(text ? JSON.parse(text) : null);
  } catch {
    // хранилище недоступно или в нём не JSON
    return createInitialState();
  }
}

/** Сохраняет только то, что нужно пережить перезагрузку. Состояние загрузки и поиска не сохраняется. */
export function serialize(state) {
  return JSON.stringify({
    favorites: state.favorites,
    forecasts: state.forecasts,
    fetchedAt: state.fetchedAt,
    filter: state.filter,
    sort: state.sort,
    compare: state.compare,
  });
}

export function attachPersistence(store, storage) {
  let last = null;
  return store.subscribe((state) => {
    try {
      const text = serialize(state);
      if (text === last) return;
      storage.setItem(STORAGE_KEY, text);
      last = text;
    } catch {
      // переполнено или запрещено (приватный режим): работаем без сохранения
    }
  });
}
