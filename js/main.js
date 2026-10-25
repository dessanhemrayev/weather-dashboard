'use strict';

/**
 * Точка входа. Здесь сходятся модули: main.js создаёт store, подписывает на него
 * рендер и сохранение, превращает события DOM в действия и запускает сетевые запросы.
 * Состояние меняется только через store.dispatch.
 */
import { ApiError, fetchForecasts, isAbortError, searchCities } from './api.js';
import {
  attachPersistence,
  createStore,
  loadState,
  MIN_QUERY_LENGTH,
} from './state.js';
import { renderAll } from './render.js';
import { debounce } from './utils.js';

const SEARCH_DELAY_MS = 400;
const FILTER_DELAY_MS = 200;
const REFRESH_DELAY_MS = 300;

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    // доступ к хранилищу может быть запрещён настройками браузера
    return { getItem: () => null, setItem: () => {} };
  }
}

const errorText = (error) =>
  error instanceof ApiError ? error.message : 'Что-то пошло не так. Повторите попытку';

export function start() {
  const $ = (selector) => document.querySelector(selector);
  const regions = {
    search: $('[data-region="search-results"]'),
    controls: $('[data-region="controls"]'),
    status: $('[data-region="status"]'),
    favorites: $('[data-region="favorites"]'),
    compare: $('[data-region="compare"]'),
    refresh: $('[data-action="refresh"]'),
    favoritesCount: $('[data-role="favorites-count"]'),
  };
  const searchInput = $('[data-role="search-input"]');
  const filterInput = $('[data-role="filter-input"]');

  const storage = safeStorage();
  const store = createStore(loadState(storage));
  attachPersistence(store, storage);

  // ---------- перерисовка ----------
  // Несколько действий подряд (например, добавление города и старт загрузки)
  // дают одну перерисовку в конце микрозадачи.
  let renderQueued = false;
  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      renderAll(store.getState(), regions);
    });
  };
  store.subscribe(scheduleRender);

  // ---------- поиск города ----------
  let searchController = null;

  async function runSearch() {
    const query = store.getState().search.query.trim();
    if (searchController) searchController.abort();
    if (query.length < MIN_QUERY_LENGTH) {
      searchController = null;
      return;
    }

    const controller = new AbortController();
    searchController = controller;
    store.dispatch({ type: 'SEARCH_START' });
    try {
      const results = await searchCities(query, { signal: controller.signal });
      if (searchController !== controller) return; // уже идёт более новый запрос
      store.dispatch({ type: 'SEARCH_SUCCESS', results });
    } catch (error) {
      if (isAbortError(error) || searchController !== controller) return;
      store.dispatch({ type: 'SEARCH_ERROR', error: errorText(error) });
    } finally {
      if (searchController === controller) searchController = null;
    }
  }

  const debouncedSearch = debounce(runSearch, SEARCH_DELAY_MS);

  searchInput.addEventListener('input', () => {
    store.dispatch({ type: 'SEARCH_INPUT', query: searchInput.value });
    if (searchController) {
      searchController.abort(); // ответ на прежний текст уже не нужен
      searchController = null;
    }
    debouncedSearch();
  });

  $('[data-role="search-form"]').addEventListener('submit', (event) => {
    event.preventDefault();
    debouncedSearch.cancel();
    runSearch();
  });

  // ---------- загрузка прогноза ----------
  let loadController = null;

  async function loadForecasts() {
    if (loadController) loadController.abort();
    const { favorites } = store.getState();
    if (favorites.length === 0) {
      loadController = null;
      store.dispatch({ type: 'LOAD_CANCEL' });
      return;
    }

    const controller = new AbortController();
    loadController = controller;
    store.dispatch({ type: 'LOAD_START' });
    try {
      const forecasts = await fetchForecasts(favorites, { signal: controller.signal });
      if (loadController !== controller) return;
      store.dispatch({ type: 'LOAD_SUCCESS', forecasts, at: Date.now() });
    } catch (error) {
      if (isAbortError(error) || loadController !== controller) return;
      store.dispatch({ type: 'LOAD_ERROR', error: errorText(error) });
    } finally {
      if (loadController === controller) loadController = null;
    }
  }

  // Города можно быстро добавлять и убирать: один запрос после серии изменений.
  const debouncedLoad = debounce(loadForecasts, REFRESH_DELAY_MS);

  // ---------- фильтр ----------
  const debouncedFilter = debounce((text) => store.dispatch({ type: 'SET_FILTER_TEXT', text }), FILTER_DELAY_MS);
  filterInput.addEventListener('input', () => debouncedFilter(filterInput.value));

  // ---------- делегирование событий ----------
  const handlers = {
    'add-city': ({ id }) => {
      const city = store.getState().search.results.find((item) => item.id === id);
      if (!city) return;
      store.dispatch({ type: 'FAVORITE_ADD', city });
      debouncedLoad();
    },
    'remove-city': ({ id }) => {
      store.dispatch({ type: 'FAVORITE_REMOVE', id });
      debouncedLoad();
    },
    'retry-search': () => runSearch(),
    refresh: () => {
      debouncedLoad.cancel();
      loadForecasts();
    },
    'cancel-load': () => {
      debouncedLoad.cancel();
      if (loadController) loadController.abort();
      loadController = null;
      store.dispatch({ type: 'LOAD_CANCEL' });
    },
    sort: ({ key }) => store.dispatch({ type: 'SET_SORT', key }),
    metric: ({ metric }) => store.dispatch({ type: 'SET_METRIC', metric }),
    'clear-compare': () => store.dispatch({ type: 'COMPARE_CLEAR' }),
    'reset-filter': () => {
      debouncedFilter.cancel();
      filterInput.value = '';
      store.dispatch({ type: 'SET_FILTER_TEXT', text: '' });
      store.dispatch({ type: 'SET_ONLY_RAIN', value: false });
    },
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (!target || target.disabled) return;
    const handler = handlers[target.dataset.action];
    if (handler) handler({ ...target.dataset });
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action === 'toggle-compare') {
      store.dispatch({ type: 'COMPARE_TOGGLE', id: target.dataset.id });
    } else if (target.dataset.role === 'only-rain') {
      store.dispatch({ type: 'SET_ONLY_RAIN', value: target.checked });
    }
  });

  // Сеть вернулась: обновляем данные, если прошлая попытка закончилась ошибкой.
  window.addEventListener('online', () => {
    if (store.getState().load.status === 'error') loadForecasts();
  });

  // ---------- старт ----------
  filterInput.value = store.getState().filter.text;
  renderAll(store.getState(), regions);
  if (store.getState().favorites.length > 0) loadForecasts();

  return { store };
}

if (typeof document !== 'undefined') start();
