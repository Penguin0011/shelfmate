'use strict';
// One decorative lens; all search input, submission and focus stay native HTML.
function onPage() {
  const form = document.querySelector('.ask');
  if (!form || !window.gsap || typeof Container === 'undefined') return () => {};
  const media = gsap.matchMedia();
  media.add('(min-width: 900px) and (prefers-reduced-motion: no-preference)', () => {
    const probe = document.createElement('canvas').getContext('webgl');
    if (!probe) return;
    probe.getExtension('WEBGL_lose_context')?.loseContext();
    const texture = document.createElement('canvas');
    // shortcut: the lens samples a static atmosphere, update the texture if the background becomes animated.
    texture.width = Math.min(innerWidth, 1920);
    texture.height = Math.min(Math.max(document.body.scrollHeight, innerHeight), 4096);
    const paint = texture.getContext('2d');
    paint.fillStyle = '#14171e';
    paint.fillRect(0, 0, texture.width, texture.height);
    const light = paint.createRadialGradient(texture.width * .3, 0, 0, texture.width * .3, 0, texture.width);
    light.addColorStop(0, '#805e65');
    light.addColorStop(.4, '#484060');
    light.addColorStop(1, '#131820');
    paint.fillStyle = light;
    paint.fillRect(0, 0, texture.width, texture.height);
    Container.pageSnapshot = texture;
    class SearchGlass extends Container {
      createElement() {
        super.createElement();
        this.element.setAttribute('aria-hidden', 'true');
        form.prepend(this.element);
      }
    }
    const lens = new SearchGlass({borderRadius:16, tintOpacity:.08});
    lens.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      lens.element.hidden = true;
    });
    let pendingFrames = 2;
    const resize = new ResizeObserver(() => { pendingFrames = 2; });
    resize.observe(form);
    // The decorative texture travels with the form; scrolling needs no expensive shader redraw.
    const draw = () => {
      if (!pendingFrames || document.hidden || lens.element.hidden || !lens.webglInitialized) return;
      pendingFrames--;
      lens.updateSizeFromDOM();
      lens.render?.();
    };
    gsap.ticker.add(draw);
    return () => {
      gsap.ticker.remove(draw);
      resize.disconnect();
      lens.gl?.getExtension('WEBGL_lose_context')?.loseContext();
      lens.element.remove();
      Container.instances = Container.instances.filter(item => item !== lens);
      Container.pageSnapshot = null;
    };
  });
  return () => media.revert();
}
let endPage = onPage();
addEventListener('pagehide', () => endPage());
addEventListener('pageshow', event => { if (event.persisted) endPage = onPage(); });
