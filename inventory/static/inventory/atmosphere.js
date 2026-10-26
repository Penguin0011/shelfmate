'use strict';
// The background band: a slowly drifting, mirrored linear gradient blended in OKLab, with soft silk
// shading and animated film grain. Written for Shelfmate to match the dash.clouddev.dad look.
// Colours come from the --band-* tokens so the palette switch stays in app.css. Without WebGL the
// canvas is removed and the CSS corner glows underneath show instead.
(() => {
  const host = document.querySelector('.silk');
  if (!host) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'band-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl', {alpha: false, antialias: false, premultipliedAlpha: false});
  if (!gl) return;
  host.append(canvas);

  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FRAG = `precision highp float;
uniform vec2 res;uniform float time,seed,angle,bands,silk,grain;uniform vec3 lab[4];
float hash(vec2 q){q=fract(q*vec2(123.34,456.21));q+=dot(q,q+45.32);return fract(q.x*q.y);}
float noise(vec2 q){vec2 i=floor(q),f=fract(q);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float field(vec2 uv){
  vec2 w=vec2(noise(uv*1.6+vec2(time,.3*time)),noise(uv*1.6+vec2(5.2-.4*time,1.3+time)));
  uv+=(w-.5)*.55;
  vec2 dir=vec2(cos(angle),sin(angle));
  float t=dot(uv-.5,dir)+.5;
  float f=t*bands;
  return 1.-abs(mod(f,2.)-1.);
}
vec3 ramp(float t){
  float s=clamp(t,0.,1.)*3.;
  vec3 a=s<1.?lab[0]:s<2.?lab[1]:lab[2];
  vec3 b=s<1.?lab[1]:s<2.?lab[2]:lab[3];
  return mix(a,b,smoothstep(0.,1.,fract(min(s,2.999))));
}
vec3 toSrgb(vec3 c){
  float l=c.x+.3963377774*c.y+.2158037573*c.z,m=c.x-.1055613458*c.y-.0638541728*c.z,s=c.x-.0894841775*c.y-1.291485548*c.z;
  l*=l*l;m*=m*m;s*=s*s;
  vec3 lin=vec3(4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s);
  lin=clamp(lin,0.,1.);
  return mix(lin*12.92,1.055*pow(lin,vec3(1./2.4))-.055,step(.0031308,lin));
}
void main(){
  vec2 uv=gl_FragCoord.xy/res;uv.x*=res.x/res.y;uv.x-=.5*(res.x/res.y-1.);
  float f=field(uv),e=.004;
  vec2 g=vec2(field(uv+vec2(e,0))-f,field(uv+vec2(0,e))-f)/e;
  float light=dot(normalize(vec3(-g*.08,1.)),normalize(vec3(-.4,.5,1.)));
  vec3 c=toSrgb(ramp(f));
  c*=mix(1.,.55+.6*light,silk);
  float luma=dot(c,vec3(.2126,.7152,.0722));
  c+=(hash(floor(gl_FragCoord.xy/1.8)+seed)-.5)*grain*(.45+2.2*luma*(1.-luma));
  gl_FragColor=vec4(c,1.);
}`;
  const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { canvas.remove(); return; }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const u = name => gl.getUniformLocation(program, name);

  // sRGB hex to OKLab, so the ramp blends perceptually rather than through muddy midpoints.
  const toLab = hex => {
    const v = hex.replace('#', ''), full = v.length === 3 ? [...v].map(x => x + x).join('') : v;
    const [r, g, b] = [0, 2, 4].map(i => { const c = parseInt(full.slice(i, i + 2), 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
    const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
    const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
    const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
    return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
  };
  const css = getComputedStyle(document.documentElement);
  gl.uniform3fv(u('lab'), [0, 1, 2, 3].flatMap(n => toLab(css.getPropertyValue(`--band-${n}`).trim() || '#0a0a0e')));
  gl.uniform1f(u('angle'), 40 * Math.PI / 180);
  gl.uniform1f(u('bands'), 2);
  gl.uniform1f(u('silk'), 1);
  gl.uniform1f(u('grain'), .08);

  // Rendered at reduced resolution and stretched by CSS: the field is soft, so the saving is free.
  const scale = .5 * Math.min(devicePixelRatio || 1, 1.5);
  const resize = () => {
    canvas.width = Math.max(1, Math.round(innerWidth * scale));
    canvas.height = Math.max(1, Math.round(innerHeight * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u('res'), canvas.width, canvas.height);
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0, grainAt = 0, seed = 0;
  const draw = ms => {
    // Drift is slow on purpose; grain steps at about 24 frames a second like film.
    if (ms - grainAt > 42) { grainAt = ms; seed = (seed + 17.31) % 1000; }
    gl.uniform1f(u('time'), reduced.matches ? 0 : ms * .00004);
    gl.uniform1f(u('seed'), reduced.matches ? 0 : seed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const loop = ms => { raf = 0; if (document.hidden) return; draw(ms); if (!reduced.matches) raf = requestAnimationFrame(loop); };
  const start = () => { if (!raf) raf = requestAnimationFrame(loop); };
  addEventListener('resize', () => { resize(); start(); });
  document.addEventListener('visibilitychange', start);
  reduced.addEventListener('change', start);
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); cancelAnimationFrame(raf); canvas.remove(); });
  resize(); start();
})();
