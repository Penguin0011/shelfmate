import {resolvePreset, MODE_FRAMES, paintFrame} from './vendor/thinking-orbs/engine.es.js';

// Use the upstream engine and presets, with the app's single clock and native buttons.
function mountOrbs() {
  const orbs = new Map();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const orb = orbs.get(entry.target);
      if (orb) orb.visible = entry.isIntersecting;
    }
  });
  function scan() {
    for (const [canvas] of orbs) {
      if (!canvas.isConnected) { visibility.unobserve(canvas); orbs.delete(canvas); }
    }
    document.querySelectorAll('.analyzing').forEach(status => {
      if (status.querySelector('[data-orb]')) return;
      const canvas = document.createElement('canvas');
      canvas.dataset.orb = '240';
      canvas.setAttribute('aria-hidden', 'true');
      status.prepend(canvas);
    });
    document.querySelectorAll('canvas[data-orb]').forEach(canvas => {
      if (orbs.has(canvas)) return;
      const size = Number(canvas.dataset.orb);
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = size * dpr; canvas.height = size * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      orbs.set(canvas, {ctx, size, dpr, visible:true, previous:'', painted:0});
      visibility.observe(canvas);
    });
    draw(0);
  }
  function draw(time) {
    for (const [canvas, orb] of orbs) {
      if (!orb.visible || document.hidden) continue;
      const state = canvas.closest('.analyzing:not(.error)') || canvas.dataset.busy === '1' || document.querySelector('#search-form[aria-busy=true]')
        ? 'searching' : canvas.closest('.listening') ? 'listening' : 'breathing';
      const changed = orb.previous !== state;
      if (!changed && (state === 'breathing' || reduced.matches || time - orb.painted < 1 / 30)) continue;
      // The engine ships tuned presets for 20, 32 and 64px only.
      if (changed) { orb.preset = resolvePreset(state, orb.size >= 48 ? 64 : orb.size >= 26 ? 32 : 20); canvas.dataset.orbState = state; }
      orb.previous = state; orb.painted = time;
      const {mode, speed, opts} = orb.preset;
      orb.ctx.setTransform(orb.dpr, 0, 0, orb.dpr, 0, 0);
      orb.ctx.clearRect(0, 0, orb.size, orb.size);
      paintFrame(orb.ctx, MODE_FRAMES[mode](orb.size, reduced.matches || state === 'breathing' ? .6 : time * speed, opts), true);
    }
  }
  const observer = new MutationObserver(scan);
  observer.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['class','hidden','aria-busy','aria-pressed']});
  const redraw = () => { for (const orb of orbs.values()) orb.previous = ''; draw(0); };
  reduced.addEventListener('change', redraw);
  scan();
  // One requestAnimationFrame loop drives every orb; the engine takes seconds.
  let raf = requestAnimationFrame(function tick(ms) { draw(ms / 1000); raf = requestAnimationFrame(tick); });
  return () => { cancelAnimationFrame(raf); observer.disconnect(); visibility.disconnect(); reduced.removeEventListener('change', redraw); };
}
let unmount = mountOrbs();
addEventListener('pagehide', () => unmount());
addEventListener('pageshow', event => { if (event.persisted) unmount = mountOrbs(); });
