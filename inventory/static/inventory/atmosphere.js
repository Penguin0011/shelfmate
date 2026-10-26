import {createGrainient} from './vendor/grainient/grainient.js';

// The background band is React Bits' Grainient, coloured from the CSS palette tokens so the
// palette switch stays in app.css. Without WebGL2 it draws nothing and the CSS gradient shows.
const host = document.querySelector('.silk');
if (host) {
  const css = getComputedStyle(document.documentElement);
  createGrainient(host, {
    colors: [0, 1, 2, 3].map(n => css.getPropertyValue(`--band-${n}`).trim()),
    // dash.clouddev.dad's settings, except the grain animates and the drift keeps its default speed.
    type: 'linear', angle: 40, bands: 2, silk: 1, dpr: 1.5, grainAnimated: true,
    interactive: false, clickSwirl: false, intro: false,
  });
}
