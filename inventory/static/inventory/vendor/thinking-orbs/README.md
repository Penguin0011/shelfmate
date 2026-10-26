# Thinking Orbs 0.3.2

Unmodified standalone canvas engine from https://libraries.dev/orbs and https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/thinking-orbs, installed from npm thinking-orbs@0.3.2. MIT license retained in LICENSE.

Copy dist/engine.es.js and its shared dist/index-B8WsUNf5.js chunk here after updating the pinned package. orbs.js uses resolvePreset, MODE_FRAMES and paintFrame, as the upstream React component does, without shipping React. The surrounding app owns visibility, reduced motion and its existing GSAP clock.
