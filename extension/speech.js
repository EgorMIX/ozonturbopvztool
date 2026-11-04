// speech.js — Content script для озвучки через Web Speech API
// Запускается на всех страницах Ozon, слушает команду от background

'use strict';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'SPEAK') return;

  const text = msg.text || 'Внимание! До конца приёмки осталось пятнадцать минут!';

  // Отменяем всё, что могло быть в очереди
  window.speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang   = 'ru-RU';
  utter.rate   = 0.95;
  utter.pitch  = 1.0;
  utter.volume = typeof msg.volume === 'number' ? Math.min(Math.max(msg.volume, 0), 1) : 1.0;

  // Пробуем выбрать русский голос, если доступен
  const voices = window.speechSynthesis.getVoices();
  const ruVoice = voices.find(v => v.lang.startsWith('ru'));
  if (ruVoice) utter.voice = ruVoice;

  window.speechSynthesis.speak(utter);
});
