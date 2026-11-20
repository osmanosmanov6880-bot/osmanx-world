/* OSMANX / 1000 DOORS — public editorial data only.
   Never copy CRM contacts, private notes, live location or draft interview transcripts here. */
(function () {
  'use strict';
  const titles = [
    ['Чужой город', 'Начало экспедиции: первая проверка того, насколько незнакомый рынок готов к разговору.'],
    ['Цена отказа', 'Что можно понять из отказов — и каких выводов нельзя делать без данных.'],
    ['Человек с ключом', 'Поиск профессионального партнёра, который помогает исследовать отрасль.'],
    ['За закрытой дверью', 'Как меняется разговор, когда собеседник принимает решения.'],
    ['Миллион за приложение', 'Когда разработка оправдана экономикой, а когда лучше отказаться.'],
    ['У нас всё уже работает', 'Проверка гипотез без нападок на действующие процессы.'],
    ['Первое испытание', 'Попытка договориться о честном измеримом тесте.'],
    ['Люди Москвы', 'Согласованные встречи, добровольные интродукции и совместные дела.'],
    ['Последние переговоры', 'Что реально получилось согласовать к финалу экспедиции.'],
    ['После тысячи дверей', 'Итоговая воронка, ограничения исследования и следующие 30 дней.']
  ];
  window.OSMANX_PUBLIC_DATA = Object.freeze({
    version: 'r1',
    project: {
      name: '1000 ДВЕРЕЙ. НОЛЬ ГАРАНТИЙ.',
      status: 'preparation', // preparation | active | completed
      researchTarget: 1000,
      dayTarget: 10,
      budgetTargetRub: 100000,
      // Only explicitly reviewed and approved public aggregates go here.
      // null means no approved data, NOT zero achieved.
      approvedStatistics: null,
      approvedDaySummaries: []
    },
    // Existing, unrelated staged OSMANX STORIES film: never call it documentary evidence.
    archiveFilm: {
      title: 'Цена невидимых потерь',
      label: 'Постановочная AI-видеоистория OSMANX STORIES · не хроника экспедиции',
      src: '/assets/stories/media/00-osmanx-film.mp4',
      poster: '/assets/stories/cards/00-intro.png',
      durationSeconds: 49
    },
    episodes: titles.map(([title, description], index) => ({
      id: String(index + 1).padStart(2, '0'),
      day: index + 1,
      title,
      description,
      status: 'planned', // planned | editing | published
      publishedAt: null,
      video: null, // after rights verification: {src, poster, subtitles, chapters: [{time,title}]}
      approvedFacts: [],
      publicRelatedLinks: []
    }))
  });
})();
