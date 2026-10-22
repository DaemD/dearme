// Downscale a doodle data URL to at most MAX_PX on the long side, re-encoded as WebP.
// Falls back to the original if canvas is unavailable or the result is larger.
// Injectable `canvasFactory` for tests (Node has no canvas).

const MAX_PX = 640
const SECOND_PASS_PX = 480
const MAX_CHARS = 250_000
const QUALITY = 0.85

export interface CanvasFactory {
  decode(dataUrl: string): Promise<{ width: number; height: number; source: ImageBitmapSource | HTMLImageElement }>
  encode(source: ImageBitmapSource | HTMLImageElement, w: number, h: number, quality: number): Promise<string>
}

let _factory: CanvasFactory | null = null

/** Tests only: inject a fake canvas implementation. Pass null to remove it. */
export function __setCanvasFactory(f: CanvasFactory | null): void {
  _factory = f
}

async function browserFactory(): Promise<CanvasFactory> {
  return {
    async decode(dataUrl) {
      const img = new Image()
      await new Promise<void>((res, rej) => {
        img.onload = () => res()
        img.onerror = rej
        img.src = dataUrl
      })
      return { width: img.naturalWidth, height: img.naturalHeight, source: img }
    },
    async encode(source, w, h, quality) {
      try {
        const offscreen = new OffscreenCanvas(w, h)
        const ctx = offscreen.getContext("2d") as OffscreenCanvasRenderingContext2D | null
        if (!ctx) throw new Error("no 2d ctx")
        ctx.drawImage(source as CanvasImageSource, 0, 0, w, h)
        const blob = await offscreen.convertToBlob({ type: "image/webp", quality })
        const buf = await blob.arrayBuffer()
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
        return `data:image/webp;base64,${b64}`
      } catch {
        // OffscreenCanvas failed; fall back to HTMLCanvasElement
        const canvas2 = document.createElement("canvas")
        canvas2.width = w
        canvas2.height = h
        const ctx2 = canvas2.getContext("2d")
        if (!ctx2) throw new Error("no 2d ctx")
        ctx2.drawImage(source as CanvasImageSource, 0, 0, w, h)
        return canvas2.toDataURL("image/webp", quality)
      }
    },
  }
}

async function getFactory(): Promise<CanvasFactory> {
  if (_factory) return _factory
  return browserFactory()
}

async function pass(factory: CanvasFactory, dataUrl: string, maxPx: number): Promise<string> {
  const { width, height, source } = await factory.decode(dataUrl)
  const long = Math.max(width, height)
  if (long <= maxPx && dataUrl.length <= MAX_CHARS) return dataUrl
  const scale = maxPx / long
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  return factory.encode(source, w, h, QUALITY)
}

/** Downscale to at most 640 px (then 480 px if still > 250 000 chars). Falls back to the original. */
export async function downscale(dataUrl: string): Promise<string> {
  try {
    const factory = await getFactory()
    const first = await pass(factory, dataUrl, MAX_PX)
    if (first.length <= MAX_CHARS) return first
    const second = await pass(factory, first, SECOND_PASS_PX)
    return second.length <= MAX_CHARS ? second : dataUrl
  } catch {
    return dataUrl
  }
}
