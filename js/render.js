'use strict';

/**
 * Рендеринг. Функции берут состояние и перестраивают свою часть страницы.
 * Они ничего не меняют в состоянии и не ходят в сеть. Пользователь влияет на
 * приложение только через события, которые перехватывает main.js.
 */
import { h, mount } from './dom.js';
import { describeWeather } from './weather-codes.js';
import {
  MAX_COMPARE,
  MAX_FAVORITES,
  MIN_QUERY_LENGTH,
  selectCompareCities,
  selectVisibleFavorites,
} from './state.js';
import {
  formatDay,
  formatPercent,
  formatPrecip,
  formatTemp,
  formatTime,
  formatWind,
} from './utils.js';

const SORT_LABELS = { name: 'Название', temp: 'Температура', precip: 'Осадки', wind: 'Ветер' };
const METRIC_LABELS = { temp: 'Температура', precip: 'Осадки', wind: 'Ветер' };

const cityTitle = (city) => [city.name, city.admin1, city.country].filter(Boolean).join(', ');

function messageBox(kind, title, text, actions = []) {
  return h(
    'div',
    { class: `message message--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('p', { class: 'message__title', text: title }),
    text ? h('p', { class: 'message__text', text }) : null,
    actions.length ? h('div', { class: 'message__actions' }, actions) : null
  );
}

const button = (label, action, extra = {}, cls = 'btn') =>
  h('button', { type: 'button', class: cls, dataset: { action, ...extra } }, label);

// ---------- поиск города ----------

export function renderSearch(state, root) {
  const { query, status, results, error } = state.search;
  const length = query.trim().length;

  if (length === 0) return mount(root);
  if (length < MIN_QUERY_LENGTH) {
    return mount(root, h('p', { class: 'hint', text: `Введите хотя бы ${MIN_QUERY_LENGTH} буквы названия` }));
  }

  if (status === 'loading' && results.length === 0) {
    return mount(root, h('p', { class: 'hint', role: 'status', text: 'Ищем…' }));
  }
  if (status === 'error') {
    return mount(
      root,
      messageBox('error', 'Поиск не удался', error, [button('Повторить', 'retry-search')])
    );
  }
  if (status === 'success' && results.length === 0) {
    return mount(
      root,
      messageBox('empty', 'Город не найден', 'Проверьте написание или попробуйте другое название.')
    );
  }
  if (results.length === 0) return mount(root);

  const full = state.favorites.length >= MAX_FAVORITES;
  const items = results.map((city) => {
    const added = state.favorites.some((fav) => fav.id === city.id);
    let action;
    if (added) {
      action = h('span', { class: 'muted', text: 'Уже в избранном' });
    } else if (full) {
      action = h('span', { class: 'muted', text: `Лимит ${MAX_FAVORITES} городов` });
    } else {
      action = button('Добавить', 'add-city', { id: city.id }, 'btn btn--primary');
    }
    return h(
      'li',
      { class: 'result' },
      h(
        'div',
        { class: 'result__name' },
        h('strong', { text: city.name }),
        h('span', { class: 'muted', text: [city.admin1, city.country].filter(Boolean).join(', ') })
      ),
      action
    );
  });
  mount(root, h('ul', { class: 'results', 'aria-label': 'Результаты поиска' }, items));
}

// ---------- панель управления ----------

export function renderControls(state, root) {
  const { key, dir } = state.sort;
  const sortButtons = Object.entries(SORT_LABELS).map(([sortKey, label]) => {
    const active = sortKey === key;
    const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
    return h(
      'button',
      {
        type: 'button',
        class: `chip${active ? ' chip--active' : ''}`,
        dataset: { action: 'sort', key: sortKey },
        'aria-pressed': active ? 'true' : 'false',
      },
      label + arrow
    );
  });
  root.querySelector('[data-slot="sort"]').replaceChildren(...sortButtons);
  root.querySelector('[data-role="only-rain"]').checked = state.filter.onlyRain;
}

// ---------- статус загрузки ----------

export function renderStatus(state, root) {
  const { status, error } = state.load;
  const nodes = [];

  if (status === 'loading') {
    nodes.push(
      h(
        'div',
        { class: 'loader', role: 'status' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('span', { text: 'Загружаем прогноз…' }),
        button('Отмена', 'cancel-load', {}, 'btn btn--small')
      )
    );
  } else if (status === 'error') {
    const stale = state.fetchedAt !== null && Object.keys(state.forecasts).length > 0;
    nodes.push(
      messageBox(
        'error',
        'Не удалось обновить прогноз',
        stale ? `${error}. Показаны данные от ${formatTime(state.fetchedAt)}.` : error,
        [button('Повторить', 'refresh')]
      )
    );
  } else if (state.fetchedAt !== null && state.favorites.length > 0) {
    nodes.push(h('p', { class: 'hint', text: `Обновлено в ${formatTime(state.fetchedAt)}` }));
  }
  mount(root, nodes);
}

// ---------- список избранных городов ----------

function currentBlock(forecast) {
  if (!forecast) {
    return h('p', { class: 'muted', text: 'Данных пока нет' });
  }
  const { current, daily } = forecast;
  const weather = describeWeather(current.code);
  const today = daily[0];
  return h(
    'div',
    { class: 'current' },
    h('span', { class: 'current__icon', 'aria-hidden': 'true', text: weather.icon }),
    h(
      'div',
      { class: 'current__main' },
      h('span', { class: 'current__temp', text: formatTemp(current.temp) }),
      h('span', { class: 'muted', text: weather.label })
    ),
    h(
      'dl',
      { class: 'facts' },
      h('div', {}, h('dt', { text: 'Ощущается' }), h('dd', { text: formatTemp(current.feels) })),
      h('div', {}, h('dt', { text: 'Влажность' }), h('dd', { text: formatPercent(current.humidity) })),
      h('div', {}, h('dt', { text: 'Ветер' }), h('dd', { text: formatWind(current.wind) })),
      today
        ? h('div', {}, h('dt', { text: 'Осадки' }), h('dd', { text: formatPrecip(today.precip) }))
        : null
    )
  );
}

function dailyStrip(forecast) {
  if (!forecast) return null;
  const days = forecast.daily.slice(0, 5).map((day) => {
    const weather = describeWeather(day.code);
    return h(
      'li',
      { class: 'day', title: weather.label },
      h('span', { class: 'day__name', text: formatDay(day.date) }),
      h('span', { class: 'day__icon', 'aria-hidden': 'true', text: weather.icon }),
      h('span', { class: 'day__temp', text: `${formatTemp(day.tmax)} / ${formatTemp(day.tmin)}` })
    );
  });
  return h('ul', { class: 'days', 'aria-label': 'Прогноз на несколько дней' }, days);
}

function cityCard(state, city) {
  const forecast = state.forecasts[city.id];
  const selected = state.compare.ids.includes(city.id);
  const compareFull = !selected && state.compare.ids.length >= MAX_COMPARE;

  return h(
    'li',
    { class: 'card', dataset: { cityId: city.id } },
    h(
      'div',
      { class: 'card__head' },
      h(
        'div',
        {},
        h('h3', { class: 'card__title', text: city.name }),
        h('p', { class: 'muted', text: [city.admin1, city.country].filter(Boolean).join(', ') })
      ),
      button('✕', 'remove-city', { id: city.id }, 'btn btn--icon')
    ),
    currentBlock(forecast),
    dailyStrip(forecast),
    h(
      'label',
      { class: `check${compareFull ? ' check--disabled' : ''}` },
      h('input', {
        type: 'checkbox',
        dataset: { action: 'toggle-compare', id: city.id },
        checked: selected,
        disabled: compareFull,
      }),
      h('span', { text: compareFull ? `В сравнении максимум ${MAX_COMPARE}` : 'Сравнить' })
    )
  );
}

export function renderFavorites(state, root) {
  if (state.favorites.length === 0) {
    return mount(
      root,
      messageBox(
        'empty',
        'Пока нет избранных городов',
        'Найдите город в поле выше и нажмите «Добавить».'
      )
    );
  }

  const visible = selectVisibleFavorites(state);
  if (visible.length === 0) {
    return mount(
      root,
      messageBox('empty', 'Ничего не подошло под фильтр', 'Измените запрос или снимите отметку «Только с осадками».', [
        button('Сбросить фильтр', 'reset-filter'),
      ])
    );
  }

  // Карточки с подтверждённым выбором для сравнения помечаем, чтобы CSS их подсветил.
  const cards = visible.map((city) => {
    const card = cityCard(state, city);
    if (state.compare.ids.includes(city.id)) card.classList.add('card--selected');
    return card;
  });
  mount(root, h('ul', { class: 'cards' }, cards));
}

// ---------- сравнение прогнозов ----------

function metricCell(metric, day) {
  if (!day) return h('td', { class: 'muted', text: '—' });
  const weather = describeWeather(day.code);
  if (metric === 'temp') {
    return h('td', {}, h('span', { 'aria-hidden': 'true', text: weather.icon + ' ' }), `${formatTemp(day.tmax)} / ${formatTemp(day.tmin)}`);
  }
  if (metric === 'precip') return h('td', { text: formatPrecip(day.precip) });
  return h('td', { text: formatWind(day.wind) });
}

export function renderCompare(state, root) {
  const cities = selectCompareCities(state);
  const metricButtons = Object.entries(METRIC_LABELS).map(([metric, label]) =>
    h(
      'button',
      {
        type: 'button',
        class: `chip${state.compare.metric === metric ? ' chip--active' : ''}`,
        dataset: { action: 'metric', metric },
        'aria-pressed': state.compare.metric === metric ? 'true' : 'false',
      },
      label
    )
  );

  const head = h(
    'div',
    { class: 'section__head' },
    h('h2', { text: 'Сравнение прогнозов' }),
    cities.length ? button('Очистить', 'clear-compare', {}, 'btn btn--small') : null
  );

  if (cities.length < 2) {
    return mount(
      root,
      head,
      messageBox(
        'empty',
        cities.length === 0 ? 'Выберите города для сравнения' : 'Нужен ещё хотя бы один город',
        `Отметьте «Сравнить» у карточек, от двух до ${MAX_COMPARE} городов.`
      )
    );
  }

  const withData = cities.filter((city) => state.forecasts[city.id]);
  if (withData.length < 2) {
    return mount(
      root,
      head,
      messageBox('empty', 'Нет данных для сравнения', 'Загрузите прогноз кнопкой «Обновить».')
    );
  }

  const dates = Array.from(
    new Set(
      withData.flatMap((city) => state.forecasts[city.id]?.daily?.map((day) => day.date) ?? [])
    )
  )
    .sort()
    .slice(0, 7);

  const headerRow = h(
    'tr',
    {},
    h('th', { scope: 'col', text: 'День' }),
    cities.map((city) => h('th', { scope: 'col', title: cityTitle(city), text: city.name }))
  );
  const rows = dates.map((date) =>
    h(
      'tr',
      {},
      h('th', { scope: 'row', text: formatDay(date) }),
      cities.map((city) => {
        const day = state.forecasts[city.id]?.daily?.find((item) => item.date === date);
        return metricCell(state.compare.metric, day);
      })
    )
  );

  mount(
    root,
    head,
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Показатель сравнения' }, metricButtons),
    h(
      'div',
      { class: 'table-wrap', tabindex: '0' },
      h('table', { class: 'compare' }, h('thead', {}, headerRow), h('tbody', {}, rows))
    )
  );
}

// ---------- общий вызов ----------

export function renderAll(state, regions) {
  renderSearch(state, regions.search);
  renderControls(state, regions.controls);
  renderStatus(state, regions.status);
  renderFavorites(state, regions.favorites);
  renderCompare(state, regions.compare);
  regions.refresh.disabled = state.favorites.length === 0 || state.load.status === 'loading';
  regions.favoritesCount.textContent = String(state.favorites.length);
}
