/* Resize and JPEG-encode off the main thread (OffscreenCanvas).
   scale: file bytes -> ImageBitmap, long edge <= maxPx.
   encode: ImageBitmap -> JPEG bytes, long edge <= maxPx. */
self.onmessage = async (e) => {
  const d = e.data || {};
  const reply = (o, transfer) => self.postMessage(Object.assign({ id: d.id }, o), transfer || []);
  try {
    if (d.op === 'scale') {
      const blob = new Blob([d.buf], { type: d.type || 'image/jpeg' });
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const canvas = fitCanvas(bmp, d.maxPx);
      bmp.close();
      const out = canvas.transferToImageBitmap();
      reply({ bitmap: out, width: out.width, height: out.height }, [out]);
      return;
    }
    if (d.op === 'encode') {
      const canvas = fitCanvas(d.bitmap, d.maxPx);
      if (d.bitmap && d.bitmap.close) d.bitmap.close();
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: d.quality || 0.8 });
      const buf = await blob.arrayBuffer();
      reply({ buf, width: canvas.width, height: canvas.height }, [buf]);
      return;
    }
    reply({ error: 'unknown op' });
  } catch (err) {
    reply({ error: String(err && err.message || err) });
  }
};

function fitCanvas(bmp, maxPx) {
  const long = Math.max(bmp.width, bmp.height);
  const s = Math.min(1, (maxPx || long) / long);
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return canvas;
}
