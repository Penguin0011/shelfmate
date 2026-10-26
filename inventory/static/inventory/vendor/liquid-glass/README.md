# Liquid glass attribution

Source: https://github.com/dashersw/liquid-glass-js/blob/main/container.js
License: MIT, retained in LICENSE.

Shelfmate uses the upstream Container shader on the search form only. Adaptations:
- accepts a procedural decorative texture instead of capturing the document through html2canvas;
- uses a microtask for layout sizing and exposes render to the shared GSAP ticker instead of a scroll listener;
- the integration in atmosphere.js supplies native HTML controls, context-loss fallback, visibility and reduced-motion handling.

shortcut: the lens refracts a static procedural atmosphere, not live page content; revisit only if the background becomes dynamic.
