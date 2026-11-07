import { CinemaView } from './cinema3d.js';

/* Booking UI state. Hall coordinates are shared with the WebGL scene. */
const $ = (id) => document.getElementById(id);
const state = { catalog: null, cinema: null, movie: null, date: null, show: null, seats: [], selected: null, ticket: null, audio: null, busy: false, view3d: null, viewMode: 'seat', heatMap: false, user: null, ticketCount: 0, authMode: 'register', pendingCheckout: false };
const money = (n) => `${Number(n).toLocaleString('ru-RU')} ₽`;
const plural = (n, forms) => forms[n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 1 : 2];
const dateLabel = (day) => new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(new Date(`${day}T12:00:00`)).replace('.', '');
const longDate = (stamp) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(stamp));
const seatLabel = (seat) => seat.kind === 'sofa' ? `Ряд ${seat.row_number}, диван ${seat.seat_number}` : `Ряд ${seat.row_number}, место ${seat.seat_number}`;
const movieById = (id) => state.catalog.movies.find((m) => m.id === id);
const cinemaById = (id) => state.catalog.cinemas.find((c) => c.id === id);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
let toastTimer;
let installPrompt = null;

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 4200);
}
async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  let body;
  try { body = await response.json(); } catch { throw new Error('Сервер вернул неверный ответ.'); }
  if (!response.ok) throw Object.assign(new Error(body.error || 'Ошибка запроса.'), { status: response.status });
  return body;
}

async function start() {
  bindEvents();
  setupHeroVideo();
  updateWalletCount();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
  try {
    const [catalog, auth] = await Promise.all([api('/api/catalog'), api('/api/auth/me')]);
    state.catalog = catalog;
    state.user = auth.user;
    updateAccountUI();
    if (state.user) refreshTicketCount();
    state.cinema = state.catalog.cinemas[0]?.id;
    const match = location.pathname.match(/^\/film\/(ks-\d+)\/?$/);
    state.movie = match?.[1] || null;
    if (state.movie && movieById(state.movie)) {
      renderFilmPage(); renderCinema(); renderMovies(); renderDates(); await renderTimes();
    } else {
      if (match) toast('Фильм не найден. Показываем афишу.');
      renderCatalog();
    }
    const token = new URLSearchParams(location.search).get('ticket');
    if (token) {
      try { showTicket(await api(`/api/tickets/${encodeURIComponent(token)}`)); }
      catch { toast('Не удалось открыть билет по этой ссылке.'); }
    }
  } catch (error) { toast(`Не удалось загрузить расписание: ${error.message}`); }
  setInterval(() => { if (state.show && document.visibilityState === 'visible' && !$('checkout-modal').hidden) return; if (state.show && document.visibilityState === 'visible') refreshSeats(true); }, 12000);
  document.addEventListener('visibilitychange', () => {
    state.view3d?.setVisible(document.visibilityState === 'visible' && !$('preview-section').hidden);
    if (document.visibilityState === 'visible' && state.show) refreshSeats(true);
  });
}

function renderCatalog() {
  $('home-intro').hidden = false; $('films').hidden = false; $('how').hidden = false;
  $('film-hero').hidden = true; $('booking').hidden = true; $('preview-section').hidden = true;
  document.title = 'Афиша · Экран — билет с видом';
  $('catalog-count').textContent = `${state.catalog.movies.length} ${plural(state.catalog.movies.length, ['история', 'истории', 'историй'])}`;
  renderSpotlight();
  let filter = 'all';
  const list = $('film-grid');
  const render = () => {
    const search = $('film-search').value.trim().toLocaleLowerCase('ru');
    const movies = state.catalog.movies.filter((movie) =>
      (filter === 'all' || (filter === 'animation') === movie.is_animation) &&
      `${movie.title} ${movie.genre}`.toLocaleLowerCase('ru').includes(search));
    list.replaceChildren(); $('catalog-empty').hidden = movies.length > 0;
    for (const movie of movies) {
      const card = document.createElement('a'); card.className = 'film-card'; card.href = `/film/${movie.id}`;
      const art = document.createElement('span'); art.className = 'film-card-art';
      const poster = document.createElement('img'); poster.src = movie.poster; poster.alt = ''; poster.loading = 'lazy';
      const badge = document.createElement('span'); badge.className = 'film-card-badge'; badge.textContent = movie.age;
      art.append(poster, badge);
      const details = document.createElement('span'); details.className = 'film-card-details';
      const genre = document.createElement('small'); genre.textContent = movie.is_animation ? 'МУЛЬТФИЛЬМ' : movie.genre.toUpperCase();
      const title = document.createElement('strong'); title.textContent = movie.title;
      const meta = document.createElement('span'); meta.textContent = `${movie.duration_min} мин · ${movie.trailer_url ? 'трейлер в 3D' : 'постер в 3D'}`;
      const action = document.createElement('b'); action.textContent = 'Выбрать место ↗';
      details.append(genre, title, meta, action); card.append(art, details); list.append(card);
    }
  };
  $('film-search').addEventListener('input', render);
  document.querySelectorAll('.catalog-filters button').forEach((button) => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('.catalog-filters button').forEach((item) => item.classList.toggle('active', item === button));
    render();
  }));
  render();
}

function renderSpotlight() {
  const movie = state.catalog.movies.find((item) => item.id === 'ks-25242') || state.catalog.movies.find((item) => item.trailer_url);
  if (!movie) return;
  const nextShow = state.catalog.shows.find((show) => show.movie_id === movie.id);
  $('spotlight').hidden = false;
  $('spotlight-title').textContent = movie.title;
  $('spotlight-description').textContent = movie.description || movie.tagline;
  $('spotlight-genre').textContent = `${movie.genre} · ${movie.age}`;
  $('spotlight-time').textContent = nextShow ? `Ближайший демо-сеанс: ${longDate(nextShow.starts_at)}` : `${movie.duration_min} мин`;
  $('spotlight-link').href = `/film/${movie.id}`;
  $('spotlight-backdrop').src = movie.poster;
  $('spotlight-poster').src = movie.poster;
  $('spotlight-poster').alt = `Постер фильма «${movie.title}»`;
}

function renderFilmPage() {
  const movie = movieById(state.movie);
  $('home-intro').hidden = true; $('films').hidden = true; $('how').hidden = true;
  $('film-hero').hidden = false; $('booking').hidden = false;
  $('film-title').textContent = movie.title;
  $('film-poster').src = movie.poster; $('film-poster').alt = `Постер фильма «${movie.title}»`;
  $('film-poster-card').src = movie.poster;
  $('film-meta').textContent = `${movie.genre}  ·  ${movie.duration_min} мин  ·  ${movie.age}${movie.year ? `  ·  ${movie.year}` : ''}`;
  $('film-description').textContent = movie.description || movie.tagline;
  $('film-source').href = movie.source_url;
  $('trailer-status').textContent = movie.trailer_url ? 'В 3D-зале на экране идёт трейлер этого фильма. Звук включается по нажатию.' : 'В афише кинотеатра нет ссылки на трейлер этого фильма. В 3D-зале показан постер.';
  $('sound-button').disabled = !movie.trailer_url;
  $('viewport-sound').disabled = !movie.trailer_url;
  $('sound-caption').textContent = movie.trailer_url ? 'Нажмите, чтобы услышать' : 'Трейлер не опубликован';
  document.title = `${movie.title} · Выбрать место · Экран`;
}

function setupHeroVideo() {
  const video = $('hero-video'), button = $('hero-sound'), label = $('hero-sound-label');
  if (/^\/film\//.test(location.pathname)) return;
  const source = video.querySelector('source');
  source.src = source.dataset.src;
  video.load();
  let visible = false;
  let soundRequested = true;
  video.volume = .85;

  function updateSoundButton() {
    const audible = !video.muted;
    button.setAttribute('aria-pressed', String(audible));
    label.textContent = audible ? 'Выключить звук' : 'Включить звук';
  }

  async function playWhenVisible() {
    if (!visible || document.hidden) return;
    video.muted = !soundRequested;
    updateSoundButton();
    try {
      await video.play();
    } catch {
      // Browsers commonly block autoplay with sound. Keep the film moving and
      // let the visitor enable its narration with the visible button.
      soundRequested = false;
      video.muted = true;
      updateSoundButton();
      try { await video.play(); } catch { /* The poster remains visible. */ }
    }
  }

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) playWhenVisible();
    else video.pause();
  }, { threshold: 0 }).observe(video);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else playWhenVisible();
  });

  button.addEventListener('click', () => {
    const enablingSound = video.muted;
    soundRequested = enablingSound;
    video.muted = !soundRequested;
    if (enablingSound) video.currentTime = 0;
    updateSoundButton();
    playWhenVisible();
  });

  video.addEventListener('error', () => {
    button.disabled = true;
    label.textContent = 'Видео недоступно';
  });
  updateSoundButton();
}

function renderCinema() {
  const select = $('cinema-select'); select.replaceChildren();
  for (const cinema of state.catalog.cinemas) {
    const option = document.createElement('option'); option.value = cinema.id; option.textContent = cinema.name; select.append(option);
  }
  select.value = state.cinema || '';
  const cinema = cinemaById(state.cinema);
  $('cinema-address').textContent = cinema?.address || '';
  $('hall-name').textContent = cinema?.hall || '';
}
function renderMovies() {
  const list = $('movie-list'); list.replaceChildren();
  const movie = movieById(state.movie);
  if (movie) {
    const button = document.createElement('div'); button.className = 'movie-card active';
    const art = document.createElement('span'); art.className = `movie-art ${movie.theme}`;
    const poster = document.createElement('img'); poster.src = movie.poster; poster.alt = ''; art.append(poster);
    const words = document.createElement('span'); words.className = 'movie-text';
    const title = document.createElement('strong'); title.textContent = movie.title;
    const meta = document.createElement('small'); meta.textContent = `${movie.genre} · ${movie.duration_min} мин`;
    words.append(title, meta);
    const age = document.createElement('span'); age.className = 'movie-age'; age.textContent = movie.age;
    button.append(art, words, age);
    list.append(button);
  }
  const current = movieById(state.movie);
  $('movie-tagline').textContent = current?.tagline || '';
}
function relevantShows() { return state.catalog.shows.filter((s) => s.cinema_id === state.cinema && s.movie_id === state.movie); }
function renderDates() {
  const days = [...new Set(relevantShows().map((s) => s.starts_at.slice(0, 10)))];
  if (!days.includes(state.date)) state.date = days[0] || null;
  const list = $('date-list'); list.replaceChildren();
  for (const day of days) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `date-chip${day === state.date ? ' active' : ''}`;
    button.setAttribute('aria-pressed', String(day === state.date));
    const dayName = document.createElement('small'); dayName.textContent = day === today() ? 'сегодня' : dateLabel(day);
    const number = document.createElement('b'); number.textContent = String(Number(day.slice(8, 10)));
    button.append(dayName, number);
    button.addEventListener('click', async () => { state.date = day; state.show = null; state.selected = null; hidePreview(); renderDates(); await renderTimes(); });
    list.append(button);
  }
}
async function renderTimes() {
  const shows = relevantShows().filter((s) => s.starts_at.startsWith(state.date));
  if (!shows.some((s) => s.id === state.show)) state.show = shows[0]?.id || null;
  const list = $('time-list'); list.replaceChildren();
  for (const show of shows) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `time-chip${show.id === state.show ? ' active' : ''}`;
    button.setAttribute('aria-pressed', String(show.id === state.show)); button.textContent = show.starts_at.slice(11, 16);
    button.addEventListener('click', async () => { state.show = show.id; state.selected = null; hidePreview(); await refreshSeats(); renderTimesWithoutFetch(); });
    list.append(button);
  }
  await refreshSeats();
}
function renderTimesWithoutFetch() {
  for (const button of $('time-list').children) {
    const show = relevantShows().find((s) => s.starts_at.startsWith(state.date) && s.starts_at.slice(11, 16) === button.textContent);
    button.classList.toggle('active', show?.id === state.show); button.setAttribute('aria-pressed', String(show?.id === state.show));
  }
}

async function refreshSeats(silent = false) {
  if (!state.show) { state.seats = []; renderSeats(); return; }
  const requested = state.show;
  try {
    const result = await api(`/api/shows/${requested}`);
    if (requested !== state.show) return;
    state.seats = result.seats;
    if (state.selected) {
      const updated = state.seats.find((s) => s.id === state.selected.id);
      if (!updated || updated.occupied) {
        state.selected = null; hidePreview();
        if (updated?.occupied) toast('Выбранное место уже купили. Выберите другое.');
      } else state.selected = updated;
    }
    renderSeats(); updateSummary();
    if (!$('preview-section').hidden) drawView();
  } catch (error) { if (!silent) toast(`Не удалось загрузить места: ${error.message}`); }
}
function renderSeats() {
  const map = $('seat-map'); map.replaceChildren();
  map.classList.toggle('view-map', state.heatMap);
  $('view-map-toggle').setAttribute('aria-pressed', String(state.heatMap));
  $('view-map-legend').hidden = !state.heatMap;
  const groups = new Map();
  for (const seat of state.seats) { if (!groups.has(seat.row_number)) groups.set(seat.row_number, []); groups.get(seat.row_number).push(seat); }
  for (const [rowNumber, seats] of groups) {
    const row = document.createElement('div'); row.className = 'seat-row';
    const label = document.createElement('span'); label.className = 'row-label'; label.textContent = rowNumber; row.append(label);
    for (const [index, seat] of seats.entries()) {
      if (index === Math.floor(seats.length / 2)) { const aisle = document.createElement('span'); aisle.className = 'row-aisle'; aisle.setAttribute('aria-hidden', 'true'); row.append(aisle); }
      const button = document.createElement('button'); button.type = 'button';
      button.className = `seat${seat.kind === 'sofa' ? ' sofa' : ''}${seat.occupied ? ' occupied' : ''}${seat.id === state.selected?.id ? ' selected' : ''}`;
      const score = viewScore(seat);
      button.style.setProperty('--heat-color', score >= 80 ? '#8ed9bf' : score >= 60 ? '#eeb987' : '#d58182');
      button.disabled = Boolean(seat.occupied);
      button.setAttribute('aria-label', `${seatLabel(seat)}, ${seat.occupied ? 'занято' : money(seat.price_rub)}${state.heatMap && !seat.occupied ? `, ориентир обзора ${score} из 100` : ''}`);
      button.setAttribute('aria-pressed', String(seat.id === state.selected?.id));
      button.title = `${seatLabel(seat)} · ${seat.occupied ? 'Занято' : money(seat.price_rub)}`;
      button.addEventListener('click', () => selectSeat(seat));
      row.append(button);
    }
    map.append(row);
  }
  const free = state.seats.filter((s) => !s.occupied).length;
  $('seat-count').textContent = state.seats.length ? `${free} ${plural(free, ['место', 'места', 'мест'])} свободно` : 'Нет мест';
}

function viewScore(seat) {
  const angle = Math.atan2(Math.abs(seat.x), Math.max(1, seat.z - .69)) * 180 / Math.PI;
  const score = Math.round(98 - angle * 1.38 - Math.abs(seat.row_number - 5.5) * 4.2);
  return Math.max(25, Math.min(98, score));
}
function selectSeat(seat) {
  if (!seat || seat.occupied) { toast('Это место уже занято.'); return; }
  state.selected = seat;
  renderSeats(); updateSummary();
  if (!$('preview-section').hidden) { updatePreview(); drawView(); }
}
function recommendSeat(kind) {
  const free = state.seats.filter((seat) => !seat.occupied);
  if (!free.length) { toast('На этом сеансе нет свободных мест.'); return; }
  const rows = cinemaById(state.cinema).rows_count;
  const scores = {
    best: (s) => Math.abs(s.row_number - Math.min(6, rows - 2)) * 1.5 + Math.abs(s.x) * 1.1,
    near: (s) => s.row_number * 2 + Math.abs(s.x) * .7,
    budget: (s) => s.price_rub * .03 + Math.abs(s.x) * .6 + Math.abs(s.row_number - 3) * .3,
  };
  free.sort((a, b) => scores[kind](a) - scores[kind](b));
  selectSeat(free[0]);
  $('selection-summary').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast(`${kind === 'best' ? 'Лучший обзор' : kind === 'near' ? 'Ближе к экрану' : 'Доступная цена'}: ${seatLabel(free[0])}`);
}
function moveSeat(direction) {
  const free = state.seats.filter((seat) => !seat.occupied);
  const index = free.findIndex((seat) => seat.id === state.selected?.id);
  if (!free.length || index < 0) return;
  selectSeat(free[(index + direction + free.length) % free.length]);
  state.viewMode = 'seat'; updateModeButtons(); drawView();
}
function updateSummary() {
  const seat = state.selected;
  $('summary-seat').textContent = seat ? seatLabel(seat) : 'Выберите место на схеме';
  $('summary-context').textContent = seat ? (seat.kind === 'sofa' ? 'Комфортный диван в последнем ряду' : seat.row_number <= 3 ? 'Ближе всего к экрану' : 'Комфортный обзор зала') : 'Чтобы увидеть вид с кресла';
  $('summary-price').textContent = seat ? money(seat.price_rub) : '—';
  $('view-button').disabled = !seat;
  $('view-insight').hidden = !seat;
  if (seat) {
    const score = viewScore(seat);
    const angle = Math.round(Math.atan2(Math.abs(seat.x), Math.max(1, seat.z - .69)) * 180 / Math.PI);
    const distance = seat.row_number <= 3 ? 'Близко' : seat.row_number >= 8 ? 'Далеко' : 'Комфортно';
    const quality = score >= 80 ? 'Почти прямой обзор' : score >= 60 ? 'Хороший обзор с углом' : 'Выразительный боковой ракурс';
    $('view-score').textContent = String(score);
    $('view-score-ring').style.setProperty('--score', `${score}%`);
    $('view-insight-title').textContent = quality;
    $('view-insight-description').textContent = `Экран виден под углом ${angle}°. Оценка рассчитана по положению кресла в демо-зале.`;
    $('view-angle').textContent = `${angle}°`;
    $('view-distance').textContent = distance;
  }
}
function seatDescription(seat) {
  const cinema = cinemaById(state.cinema), center = (cinema.seats_per_row + 1) / 2;
  const side = Math.abs(seat.x) > center * .82 * .55;
  if (seat.kind === 'sofa') return side ? 'Последний ряд, сбоку: экран меньше и виден под углом, зато обзор ничто не закрывает.' : 'Последний ряд: экран виден целиком, а перед вами открыт весь зал.';
  if (seat.row_number <= 3) return side ? 'Близко к экрану и сбоку: большой экран выходит за границы обзора.' : 'Почти у самого экрана: изображение занимает всё поле зрения.';
  return side ? 'Вы сидите сбоку: экран виден под углом, и перед вами ряды кресел.' : 'Центр зала: экран почти без искажений, но головы впереди могут закрывать нижний край.';
}
function updatePreview() {
  const seat = state.selected; if (!seat) return;
  $('preview-title').textContent = `Вид с места ${seat.row_number} / ${seat.seat_number}`;
  $('preview-description').textContent = `${cinemaById(state.cinema).hall} · ${movieById(state.movie).title}`;
  $('aside-seat').textContent = seatLabel(seat);
  $('aside-description').textContent = seatDescription(seat);
  $('aside-price').textContent = money(seat.price_rub);
}
function showPreview() {
  if (!state.selected) return;
  state.viewMode = 'seat'; updateModeButtons();
  updatePreview(); $('preview-section').hidden = false;
  requestAnimationFrame(() => { drawView(); $('preview-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}
function hidePreview() { leavePreviewFullscreen(); $('preview-section').hidden = true; state.view3d?.setVisible(false); stopSound(); }

function previewViewport() { return $('cinema-view').parentElement; }
function updateFullscreenButton() {
  const active = document.fullscreenElement === previewViewport() || previewViewport().classList.contains('pseudo-fullscreen');
  const label = active ? 'Выйти из полного экрана' : 'На весь экран';
  $('fullscreen-button').setAttribute('aria-label', label);
  $('fullscreen-button').title = label;
  $('fullscreen-button').textContent = active ? '✕' : '⛶';
  requestAnimationFrame(() => state.view3d?.resize());
}
function leavePreviewFullscreen() {
  const viewport = previewViewport();
  if (document.fullscreenElement === viewport) document.exitFullscreen().catch(() => {});
  viewport.classList.remove('pseudo-fullscreen');
  document.body.classList.remove('preview-fullscreen-open');
  updateFullscreenButton();
}
async function togglePreviewFullscreen() {
  const viewport = previewViewport();
  if (document.fullscreenElement === viewport || viewport.classList.contains('pseudo-fullscreen')) return leavePreviewFullscreen();
  try {
    if (!viewport.requestFullscreen) throw new Error('Fullscreen API unavailable');
    await viewport.requestFullscreen();
  } catch {
    viewport.classList.add('pseudo-fullscreen');
    document.body.classList.add('preview-fullscreen-open');
  }
  updateFullscreenButton();
}

function updateModeButtons() {
  $('mode-seat').classList.toggle('active', state.viewMode === 'seat');
  $('mode-overview').classList.toggle('active', state.viewMode === 'overview');
  $('mode-seat').setAttribute('aria-pressed', String(state.viewMode === 'seat'));
  $('mode-overview').setAttribute('aria-pressed', String(state.viewMode === 'overview'));
  const compact = window.matchMedia('(max-width: 520px)').matches;
  $('viewport-hint').textContent = state.viewMode === 'seat'
    ? compact ? 'Проведите пальцем, чтобы осмотреться' : 'Потяните мышью или пальцем, чтобы осмотреться · колесо — масштаб'
    : compact ? 'Поверните зал · нажмите на кресло' : 'Потяните для поворота · нажмите на свободное кресло';
}

function drawView() {
  const seat = state.selected;
  if (!seat || $('preview-section').hidden) return;
  try {
    if (!state.view3d) {
      state.view3d = new CinemaView($('cinema-view'), (seatId) => {
        const target = state.seats.find((s) => s.id === seatId);
        if (!target || target.occupied) return toast('Это место уже занято.');
        selectSeat(target); state.viewMode = 'seat'; updateModeButtons(); drawView();
      });
    }
    state.view3d.setHall(cinemaById(state.cinema), state.seats, movieById(state.movie));
    if (state.view3d.selectedId !== seat.id) state.view3d.setSeat(seat);
    if (state.view3d.mode !== state.viewMode) state.view3d.setMode(state.viewMode);
    state.view3d.resize();
    state.view3d.setVisible(document.visibilityState === 'visible');
    $('cinema-view').dataset.engine = 'webgl';
    $('viewport-error').hidden = true;
  } catch (error) {
    console.error('WebGL scene:', error);
    $('viewport-error').hidden = false;
    $('viewport-error').textContent = '3D-сцена недоступна в этом браузере. Включите аппаратное ускорение и обновите страницу.';
  }
}

function updateSoundControls(enabled) {
  $('sound-button').setAttribute('aria-pressed', String(enabled));
  $('sound-caption').textContent = enabled ? 'Звук фильма · нажмите, чтобы выключить' : 'Нажмите, чтобы услышать';
  $('sound-icon').textContent = enabled ? '◉' : '◌';
  $('viewport-sound').setAttribute('aria-pressed', String(enabled));
  $('viewport-sound').setAttribute('aria-label', enabled ? 'Выключить звук кино' : 'Включить звук кино');
  $('viewport-sound').title = enabled ? 'Выключить звук кино' : 'Включить звук кино';
  $('viewport-sound').textContent = enabled ? '◉' : '◖';
}
function stopSound() {
  state.view3d?.disableAudio();
  state.audio = null;
  updateSoundControls(false);
}
async function toggleSound() {
  if (state.audio) { stopSound(); return; }
  if (!state.selected || !state.view3d) return toast('Сначала откройте вид с места.');
  try {
    await state.view3d.enableAudio();
    if ($('preview-section').hidden) return state.view3d.disableAudio();
    state.audio = true;
    updateSoundControls(true);
  } catch (error) {
    console.error('Cinema audio:', error);
    toast('Не удалось включить звук фильма в этом браузере.');
  }
}

function openCheckout() {
  if (!state.selected) return;
  if (!state.user) { state.pendingCheckout = true; openAccount('register'); return; }
  const show = state.catalog.shows.find((s)=>s.id===state.show);
  $('modal-details').textContent = `${movieById(state.movie).title} · ${longDate(show.starts_at)} · ${seatLabel(state.selected)}`;
  $('modal-price').textContent = money(state.selected.price_rub); $('form-error').hidden = true;
  $('checkout-modal').hidden = false; setTimeout(()=>$('test-card').focus(), 20);
}
function closeCheckout() { $('checkout-modal').hidden = true; }
async function submitCheckout(event) {
  event.preventDefault(); if (state.busy || !state.selected) return;
  state.busy = true; $('confirm-button').disabled = true; $('form-error').hidden = true;
  let paymentId = null;
  try {
    $('confirm-button').textContent = 'Проверяем оплату…';
    const payment = await api('/api/payments/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ show_id: state.show, seat_id: state.selected.id }) });
    paymentId = payment.payment_id;
    const result = await api(`/api/payments/${paymentId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ test_card: $('test-card').value.trim() }) });
    const ticket = await api(`/api/tickets/${result.token}`);
    closeCheckout(); showTicket(ticket); state.selected = null; hidePreview(); await refreshSeats(true); refreshTicketCount();
  } catch (error) {
    if (paymentId) api(`/api/payments/${paymentId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    $('form-error').textContent = error.message; $('form-error').hidden = false;
    if (error.status === 409) { closeCheckout(); await refreshSeats(true); toast(error.message); }
  } finally { state.busy = false; $('confirm-button').disabled = false; $('confirm-button').innerHTML = 'Оплатить тестово <span>↗</span>'; }
}
function showTicket(ticket) {
  state.ticket = ticket;
  saveTicketToken(ticket.token);
  $('ticket-movie').textContent = ticket.movie_title;
  $('ticket-when').textContent = `${longDate(ticket.starts_at)} · ${ticket.hall}`;
  $('ticket-cinema').textContent = ticket.cinema_name;
  $('ticket-seat').textContent = ticket.kind === 'sofa' ? `Диван ${ticket.seat_number}, ряд ${ticket.row_number}` : `Ряд ${ticket.row_number}, место ${ticket.seat_number}`;
  $('ticket-name').textContent = ticket.customer_name;
  $('ticket-price').textContent = money(ticket.price_rub);
  $('ticket-code').textContent = ticket.token.slice(0, 12).toUpperCase();
  $('ticket-modal').hidden = false;
}
function closeTicket() { $('ticket-modal').hidden = true; history.replaceState(null, '', location.pathname); }
function walletTokens() {
  try {
    const value = JSON.parse(localStorage.getItem('ekranTickets') || '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(item)) : [];
  } catch { return []; }
}
function saveTicketToken(token) {
  try {
    const tokens = [token, ...walletTokens().filter((item) => item !== token)].slice(0, 30);
    localStorage.setItem('ekranTickets', JSON.stringify(tokens));
    updateWalletCount();
  } catch { /* private browsing can disable local storage */ }
}
function updateWalletCount() {
  const count = state.user ? state.ticketCount : walletTokens().length;
  $('wallet-count').textContent = count ? `(${count})` : '';
}
async function refreshTicketCount() {
  if (!state.user) return;
  try { state.ticketCount = (await api('/api/me/tickets')).tickets.length; updateWalletCount(); }
  catch { /* The wallet can still be opened later. */ }
}
async function openWallet() {
  $('wallet-modal').hidden = false;
  const list = $('wallet-list'); list.replaceChildren();
  const loading = document.createElement('p'); loading.textContent = 'Загружаем билеты…'; list.append(loading);
  let tickets = [];
  try {
    if (state.user) {
      tickets = (await api('/api/me/tickets')).tickets;
      state.ticketCount = tickets.length; updateWalletCount();
    } else {
      const results = await Promise.allSettled(walletTokens().map((token) => api(`/api/tickets/${token}`)));
      tickets = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    }
  } catch (error) { if (!$('wallet-modal').hidden) list.textContent = error.message; return; }
  if ($('wallet-modal').hidden) return;
  list.replaceChildren();
  for (const ticket of tickets) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'wallet-item';
    const title = document.createElement('strong'); title.textContent = ticket.movie_title;
    const meta = document.createElement('small'); meta.textContent = `${longDate(ticket.starts_at)} · ${ticket.cinema_name}`;
    const seat = document.createElement('span'); seat.textContent = ticket.kind === 'sofa' ? `Диван ${ticket.seat_number}` : `Ряд ${ticket.row_number}, место ${ticket.seat_number}`;
    button.append(title, meta, seat);
    button.addEventListener('click', () => { $('wallet-modal').hidden = true; showTicket(ticket); });
    list.append(button);
  }
  if (!list.children.length) list.textContent = 'Билетов пока нет. Выберите фильм, сеанс и место.';
}

function updateAccountUI() {
  $('account-button').textContent = state.user ? state.user.name : 'Войти';
  $('dock-account').querySelector('small').textContent = state.user ? 'Профиль' : 'Войти';
  $('account-form').hidden = Boolean(state.user);
  $('account-signed-in').hidden = !state.user;
  $('account-identity').textContent = state.user ? `${state.user.name}\n${state.user.email}` : '';
  updateWalletCount();
}
function setAuthMode(mode) {
  state.authMode = mode;
  $('auth-register-tab').classList.toggle('active', mode === 'register');
  $('auth-login-tab').classList.toggle('active', mode === 'login');
  $('account-name-wrap').hidden = mode !== 'register';
  $('account-name').required = mode === 'register';
  $('account-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('account-submit').textContent = mode === 'register' ? 'Создать аккаунт ↗' : 'Войти ↗';
  $('account-title').textContent = mode === 'register' ? 'Создайте аккаунт' : 'С возвращением';
  $('account-hint').textContent = mode === 'register' ? 'Тестовая регистрация без подтверждения почты.' : 'Войдите, чтобы открыть ваши билеты на любом устройстве.';
  $('account-error').hidden = true;
}
function openAccount(mode = 'register') {
  setAuthMode(mode);
  updateAccountUI();
  $('account-modal').hidden = false;
  if (!state.user) setTimeout(() => $('account-email').focus(), 20);
}
function closeAccount() {
  $('account-modal').hidden = true;
  if (!state.user) state.pendingCheckout = false;
}
async function submitAccount(event) {
  event.preventDefault();
  const endpoint = state.authMode === 'register' ? 'register' : 'login';
  const data = { email: $('account-email').value.trim(), password: $('account-password').value };
  if (endpoint === 'register') data.name = $('account-name').value.trim();
  $('account-submit').disabled = true; $('account-error').hidden = true;
  try {
    state.user = (await api(`/api/auth/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).user;
    $('account-password').value = '';
    updateAccountUI(); refreshTicketCount();
    $('account-modal').hidden = true;
    toast(`Здравствуйте, ${state.user.name}!`);
    if (state.pendingCheckout) { state.pendingCheckout = false; openCheckout(); }
  } catch (error) { $('account-error').textContent = error.message; $('account-error').hidden = false; }
  finally { $('account-submit').disabled = false; }
}
async function logoutAccount() {
  try {
    await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    state.user = null; state.ticketCount = 0; updateAccountUI(); closeAccount(); toast('Вы вышли из аккаунта.');
  } catch (error) { toast(error.message); }
}
function calendarStamp(stamp, minutes = 0) {
  const date = new Date(`${stamp}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '');
}
function downloadCalendar() {
  const ticket = state.ticket; if (!ticket) return;
  const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ekran//Cinema Ticket//RU', 'BEGIN:VEVENT',
    `UID:${ticket.token}@ekran.local`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART;TZID=Europe/Moscow:${calendarStamp(ticket.starts_at)}`,
    `DTEND;TZID=Europe/Moscow:${calendarStamp(ticket.starts_at, ticket.movie_duration_min || 120)}`,
    `SUMMARY:${escape(`Кино: ${ticket.movie_title}`)}`,
    `LOCATION:${escape(`${ticket.cinema_name}, ${ticket.address}`)}`,
    `DESCRIPTION:${escape(`${ticket.hall}; ряд ${ticket.row_number}; место ${ticket.seat_number}`)}`,
    'END:VEVENT', 'END:VCALENDAR', ''
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `ekran-${ticket.movie_title.toLowerCase().replace(/\s+/g, '-')}.ics`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function bindEvents() {
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
  window.addEventListener('appinstalled', () => { installPrompt = null; $('install-app').hidden = true; toast('Приложение установлено.'); });
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('install-app').hidden = true;
  $('install-app').addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
    } else if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      toast('В Safari нажмите «Поделиться» → «На экран Домой».');
    } else {
      toast('Откройте меню браузера и выберите «Установить приложение». Для телефона нужен HTTPS.');
    }
  });
  $('my-tickets').addEventListener('click', openWallet);
  $('wallet-mobile').addEventListener('click', openWallet);
  $('dock-tickets').addEventListener('click', openWallet);
  $('dock-account').addEventListener('click', () => openAccount(state.user ? 'login' : 'register'));
  $('account-button').addEventListener('click', () => openAccount(state.user ? 'login' : 'register'));
  $('account-close').addEventListener('click', closeAccount);
  $('account-modal').addEventListener('click', (event) => { if (event.target === $('account-modal')) closeAccount(); });
  $('auth-register-tab').addEventListener('click', () => setAuthMode('register'));
  $('auth-login-tab').addEventListener('click', () => setAuthMode('login'));
  $('account-form').addEventListener('submit', submitAccount);
  $('logout-button').addEventListener('click', logoutAccount);
  document.querySelectorAll('[data-demo-card]').forEach((button) => button.addEventListener('click', () => { $('test-card').value = button.dataset.demoCard; $('test-card').focus(); }));
  $('test-card').addEventListener('input', () => { $('demo-card-number').textContent = $('test-card').value || '•••• •••• •••• 4242'; });
  $('wallet-close').addEventListener('click', () => { $('wallet-modal').hidden = true; });
  $('wallet-modal').addEventListener('click', (event) => { if (event.target === $('wallet-modal')) $('wallet-modal').hidden = true; });
  $('best-seat').addEventListener('click', () => recommendSeat('best'));
  $('near-seat').addEventListener('click', () => recommendSeat('near'));
  $('budget-seat').addEventListener('click', () => recommendSeat('budget'));
  $('view-map-toggle').addEventListener('click', () => { state.heatMap = !state.heatMap; renderSeats(); });
  $('cinema-select').addEventListener('change', async (event) => {
    state.cinema = event.target.value; state.movie = state.catalog.movies.find((m)=>state.catalog.shows.some((s)=>s.cinema_id===state.cinema && s.movie_id===m.id))?.id;
    state.date = null; state.show = null; state.selected = null; hidePreview(); renderCinema(); renderMovies(); renderDates(); await renderTimes();
  });
  $('view-button').addEventListener('click', showPreview);
  $('previous-seat').addEventListener('click', () => moveSeat(-1));
  $('next-seat').addEventListener('click', () => moveSeat(1));
  $('back-button').addEventListener('click', () => { hidePreview(); $('seat-map').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('mode-seat').addEventListener('click', () => { state.viewMode = 'seat'; updateModeButtons(); drawView(); });
  $('mode-overview').addEventListener('click', () => { state.viewMode = 'overview'; updateModeButtons(); drawView(); });
  $('look-left').addEventListener('click', () => state.view3d?.nudge(-.18, 0));
  $('look-right').addEventListener('click', () => state.view3d?.nudge(.18, 0));
  $('look-reset').addEventListener('click', () => state.view3d?.resetLook());
  $('cinema-view').addEventListener('keydown', (event) => {
    const directions = { ArrowLeft: [-.12, 0], ArrowRight: [.12, 0], ArrowUp: [0, .1], ArrowDown: [0, -.1] };
    if (directions[event.key]) { event.preventDefault(); state.view3d?.nudge(...directions[event.key]); }
    if (event.key.toLowerCase() === 'r') { event.preventDefault(); state.view3d?.resetLook(); }
  });
  $('sound-button').addEventListener('click', toggleSound);
  $('viewport-sound').addEventListener('click', toggleSound);
  $('fullscreen-button').addEventListener('click', togglePreviewFullscreen);
  document.addEventListener('fullscreenchange', updateFullscreenButton);
  $('checkout-button').addEventListener('click', openCheckout);
  $('modal-close').addEventListener('click', closeCheckout);
  $('checkout-modal').addEventListener('click', (event) => { if (event.target === $('checkout-modal')) closeCheckout(); });
  $('checkout-form').addEventListener('submit', submitCheckout);
  $('ticket-close').addEventListener('click', closeTicket);
  $('done-ticket').addEventListener('click', () => { closeTicket(); $('booking').scrollIntoView({ behavior: 'smooth' }); });
  $('ticket-modal').addEventListener('click', (event) => { if (event.target === $('ticket-modal')) closeTicket(); });
  $('copy-ticket').addEventListener('click', async () => {
    if (!state.ticket) return;
    const url = new URL(location.pathname, location.origin); url.searchParams.set('ticket', state.ticket.token);
    try { await navigator.clipboard.writeText(url.toString()); toast('Ссылка на билет скопирована.'); }
    catch { toast('Не удалось скопировать. Откройте билет по адресу: ' + url.toString()); }
  });
  $('calendar-ticket').addEventListener('click', downloadCalendar);
  $('print-ticket').addEventListener('click', () => window.print());
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { if (previewViewport().classList.contains('pseudo-fullscreen')) leavePreviewFullscreen(); closeCheckout(); closeTicket(); closeAccount(); $('wallet-modal').hidden = true; } });
  window.addEventListener('resize', () => { if (!$('preview-section').hidden) { updateModeButtons(); drawView(); } });
}
start();
