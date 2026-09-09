/** A four-cell development atlas: rest, speech, blink, speaking blink. */
export function createAtlasRenderer(node, { id, url, onFailure = () => {} }) {
  let loaded = false, failed = false, disposed = false, last = null;
  const image = new Image();
  node.setAttribute('aria-hidden', 'true');
  node.style.backgroundSize = '200% 200%';
  const render = frame => {
    last = frame;
    const show = loaded && !failed && !disposed && frame.active && frame.characterId === id;
    node.hidden = !show;
    if (!show) return;
    node.style.backgroundPosition = `${frame.mouth > 0.12 ? 100 : 0}% ${frame.blink > 0.5 ? 100 : 0}%`;
    node.style.transform = `rotate(${frame.tilt}deg) translateY(${frame.nod * 0.5}px)`;
  };
  image.onload = () => {
    if (disposed) return;
    if (image.naturalWidth !== image.naturalHeight || image.naturalWidth % 2) {
      failed = true; node.hidden = true; onFailure(); return;
    }
    loaded = true;
    node.style.backgroundImage = `url(${JSON.stringify(url)})`;
    if (last) render(last);
  };
  image.onerror = () => { failed = true; node.hidden = true; if (!disposed) onFailure(); };
  image.src = url;
  return { render, dispose() { disposed = true; image.onload = null; image.onerror = null; node.hidden = true; } };
}
