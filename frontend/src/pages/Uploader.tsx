import { useEffect, useRef, useState } from 'react'

export default function Uploader() {
  // Backend constraints
  const BACKEND_MAX_MB = 10
  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const
  const MAX_DIMENSION = 1920 // px

  const MAX_PREVIEW = 1920// px

  const params = new URLSearchParams(location.search)
  const event = params.get('event') || 'default'

  // ---- device_id persistente (para rate-limit por dispositivo) ----
  function getDeviceId() {
    const KEY = 'uploader_device_id'
    let id = localStorage.getItem(KEY)
    if (!id) {
      const buf = new Uint8Array(16)
      crypto.getRandomValues(buf)
      buf[6] = (buf[6] & 0x0f) | 0x40
      buf[8] = (buf[8] & 0x3f) | 0x80
      const hex = [...buf].map(b => b.toString(16).padStart(2,'0'))
      id = `${hex.slice(0,4).join('')}-${hex.slice(4,6).join('')}-${hex.slice(6,8).join('')}-${hex.slice(8,10).join('')}-${hex.slice(10,16).join('')}`
      localStorage.setItem(KEY, id)
    }
    return id
  }
  const deviceId = getDeviceId()

  const [originalFile, setOriginalFile] = useState<File | null>(null)
  const [fileToUpload, setFileToUpload] = useState<File | null>(null)

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const currentPreviewRef = useRef<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const galleryInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    return () => {
      if (currentPreviewRef.current) URL.revokeObjectURL(currentPreviewRef.current)
    }
  }, [])

  const openCamera = () => cameraInputRef.current?.click()
  const openGallery = () => galleryInputRef.current?.click()

  const resetSelection = () => {
    setOriginalFile(null)
    setFileToUpload(null)
    if (currentPreviewRef.current) {
      URL.revokeObjectURL(currentPreviewRef.current)
      currentPreviewRef.current = null
    }
    setPreviewUrl(null)
    setPreviewLoading(false)
    setLoading(false)
    setDone(false)
    setMessage(null)
    if (cameraInputRef.current) cameraInputRef.current.value = ''
    if (galleryInputRef.current) galleryInputRef.current.value = ''
  }

  // ---------- Conversión / optimización ----------
  async function fileToImageBitmap(file: File): Promise<ImageBitmap> {
    // 1) Intento con resize nativo (bajo consumo de RAM)
  try {
    // Nota: usamos el lado mayor = MAX_DIMENSION y dejamos que el navegador mantenga aspecto
    return await (createImageBitmap as any)(file, {
      resizeWidth: MAX_DIMENSION,
      resizeHeight: MAX_DIMENSION,
      resizeQuality: 'high'
    })
  } catch {
    // 2) Fallback: decodificar con <img> y escalar nosotros en canvas pequeño
    const url = URL.createObjectURL(file)
    try {
      const img = document.createElement('img')
      img.decoding = 'async'
      img.src = url
      await img.decode()

      const maxSide = Math.max(img.naturalWidth, img.naturalHeight)
      const scale = Math.min(1, MAX_DIMENSION / maxSide)
      const outW = Math.max(1, Math.round(img.naturalWidth * scale))
      const outH = Math.max(1, Math.round(img.naturalHeight * scale))

      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('No se pudo crear el contexto de canvas')
      ctx.drawImage(img, 0, 0, outW, outH)

      // Creamos un bitmap desde el canvas ya reducido (muy ligero)
      const bmp = await createImageBitmap(canvas)
      return bmp
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  }

  async function buildPreviewUrl(
    file: File,
    currentPreviewRef: React.MutableRefObject<string | null>,
    setPreviewUrl: (u: string | null) => void,
    setPreviewLoading: (b: boolean) => void,
    onReady?: () => void
  ) {
    setPreviewLoading(true);
    let bmp: ImageBitmap | null = null;
  
    // Intento 1: decodificar ya reducido (usa mucha menos RAM)
    try {
      bmp = await (createImageBitmap as any)(file, {
        resizeWidth: MAX_PREVIEW,
        resizeHeight: MAX_PREVIEW,
        resizeQuality: 'high',
      });
    } catch {
      // Fallback: <img>.decode() + canvas pequeño
      const tmpUrl = URL.createObjectURL(file);
      try {
        const img = document.createElement('img');
        img.decoding = 'async';
        img.src = tmpUrl;
        await img.decode();
  
        const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
        const scale = Math.min(1, MAX_PREVIEW / maxSide);
        const outW = Math.max(1, Math.round(img.naturalWidth * scale));
        const outH = Math.max(1, Math.round(img.naturalHeight * scale));
  
        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('No se pudo crear canvas');
  
        ctx.drawImage(img, 0, 0, outW, outH);
        // Exporto a preview liviano (WebP 80%) — SOLO para mostrar
        const blob: Blob = await new Promise((res, rej) =>
          canvas.toBlob(b => (b ? res(b) : rej(new Error('toBlob preview falló'))), 'image/webp', 0.8)
        );
  
        const newUrl = URL.createObjectURL(blob);
        const oldUrl = currentPreviewRef.current;
        currentPreviewRef.current = newUrl;
        setPreviewUrl(newUrl);
        // Revoco el viejo URL cuando la <img> nueva termina de cargar (ver onLoad en el <img>)
        (handleRevokeOldUrl as any).pending = oldUrl;
        setPreviewLoading(false);
        onReady?.();
        return;
      } finally {
        URL.revokeObjectURL(tmpUrl);
      }
    }
  
    // Si llegamos acá, tenemos un ImageBitmap reducido (intento 1)
    // Lo dibujo a canvas y genero un blob liviano para la preview
    const cnv = document.createElement('canvas');
    cnv.width = bmp!.width;
    cnv.height = bmp!.height;
    const ctx2 = cnv.getContext('2d', { alpha: false });
    if (!ctx2) {
      setPreviewLoading(false);
      throw new Error('No se pudo crear canvas');
    }
    ctx2.drawImage(bmp!, 0, 0);
    const blob: Blob = await new Promise((res, rej) =>
      cnv.toBlob(b => (b ? res(b) : rej(new Error('toBlob preview falló'))), 'image/webp', 0.8)
    );
  
    const newUrl = URL.createObjectURL(blob);
    const oldUrl = currentPreviewRef.current;
    currentPreviewRef.current = newUrl;
    setPreviewUrl(newUrl);
    (handleRevokeOldUrl as any).pending = oldUrl;
    setPreviewLoading(false);
    onReady?.();
  }
  
  async function drawToCanvasAndExport(
    bmp: ImageBitmap,
    opts: { maxDim: number; mime: 'image/webp' | 'image/jpeg'; quality: number }
  ): Promise<Blob> {
    const { width, height } = bmp
    const scale = Math.min(1, opts.maxDim / Math.max(width, height))
    const outW = Math.max(1, Math.round(width * scale))
    const outH = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('No se pudo crear el contexto de canvas')
    ctx.drawImage(bmp, 0, 0, outW, outH)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo exportar la imagen'))),
        opts.mime,
        opts.quality
      )
    })
  }

  async function maybeConvertToAllowed(file: File): Promise<File> {
    // Rechazar otros formatos (ej: HEIC/HEIF)
    if (!ALLOWED_MIME.includes(file.type as any)) {
      throw new Error('Formato no permitido. Solo JPG, PNG o WebP.')
    }

    // Si ya cumple tamaño, subir tal cual
    if (file.size <= BACKEND_MAX_MB * 1024 * 1024) {
      return file
    }

    // Si excede tamaño, reescalar/comprimir manteniendo formatos permitidos
    // Preferimos WEBP/JPEG para bajar tamaño (PNG rara vez comprime)
    let bmp: ImageBitmap
    try {
      bmp = await fileToImageBitmap(file) // <- ya decodifica reducido
    } catch {
      throw new Error('No se pudo preparar la imagen (memoria). Intentá con otra foto.')
    }

    // Exportamos intentando WebP y, si no baja suficiente, pasamos a JPEG
    let quality = 0.9
    let mime: 'image/webp' | 'image/jpeg' = 'image/webp'
    let maxDim = MAX_DIMENSION

    for (let i = 0; i < 6; i++) {
      const blob = await drawToCanvasAndExport(bmp, { maxDim, mime, quality })
      if (blob.size <= BACKEND_MAX_MB * 1024 * 1024) {
        const newName = (file.name.replace(/\.[^.]+$/, '') || 'photo') + (mime === 'image/webp' ? '.webp' : '.jpg')
        return new File([blob], newName, { type: mime, lastModified: Date.now() })
      }
      quality = Math.max(0.5, quality - 0.1)
      maxDim = Math.max(800, Math.round(maxDim * 0.85))
      if (i === 2 && mime === 'image/webp') mime = 'image/jpeg'
    }

    throw new Error('No se pudo comprimir por debajo de 10MB. Probá con una imagen más chica.')
  }

  function makePreviewURL(file: File) {
    setPreviewLoading(true)
    const newUrl = URL.createObjectURL(file)
    const oldUrl = currentPreviewRef.current
    currentPreviewRef.current = newUrl
    setPreviewUrl(newUrl)
    ;(handleRevokeOldUrl as any).pending = oldUrl
  }

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
  
    setMessage(null);
    setDone(false);
  
    // 1) Guardar ORIGINAL para subir (sin tocarlo)
    setOriginalFile(f);
    setFileToUpload(f);
  
    // 2) Construir SOLO la preview reducida (no afecta al archivo de subida)
    try {
      await buildPreviewUrl(f, currentPreviewRef, setPreviewUrl, setPreviewLoading);
    } catch (err: any) {
      // Si el dispositivo no puede ni siquiera generar preview, no bloqueamos el envío
      setPreviewUrl(null);
      setPreviewLoading(false);
      setMessage('No se pudo generar la vista previa (memoria). Podés enviar la foto igual.');
    }
  }
  

  const handleRevokeOldUrl = () => {
    setPreviewLoading(false)
    const oldUrl = (handleRevokeOldUrl as any).pending as string | null
    if (oldUrl) {
      try { URL.revokeObjectURL(oldUrl) } catch {}
      ;(handleRevokeOldUrl as any).pending = null
    }
  }

  // ---------- Subida (spinner + ✔ y auto-volver) ----------
  const submit = async () => {
    if (!fileToUpload) return
    setLoading(true)
    setDone(false)
    setMessage(null)

    const fd = new FormData()
    fd.append('event', event)
    fd.append('file', fileToUpload)
    fd.append('device_id', deviceId)

    try {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/photos', true)
      xhr.setRequestHeader('X-Device-Id', deviceId)

      xhr.onreadystatechange = () => {
        if (xhr.readyState === XMLHttpRequest.DONE) {
          setLoading(false)
          if (xhr.status >= 200 && xhr.status < 300) {
            setDone(true)
            setMessage('¡Listo! Tu foto se proyectará en breve.')
            // Volver al menú principal 2s después (si hay error, no volvemos)
            setTimeout(() => { resetSelection() }, 2000)
          } else {
            let errMsg = 'Error al subir la foto'
            try {
              const j = JSON.parse(xhr.responseText)
              if (xhr.status === 429) {
                errMsg = j?.error || 'Rate limit: esperá unos segundos y volvé a intentar.'
              } else if (xhr.status === 400) {
                errMsg = j?.detail || j?.error || errMsg
              } else {
                errMsg = j?.error || errMsg
              }
            } catch {}
            setMessage(errMsg)
            setDone(false) // mantener en previsualización
          }
        }
      }

      xhr.onerror = () => {
        setLoading(false); setDone(false)
        setMessage('No se pudo conectar al servidor.')
      }

      xhr.send(fd)
    } catch {
      setLoading(false); setDone(false)
      setMessage('No se pudo conectar al servidor.')
    }
  }

  // ---------- Estilos ----------
  const styles = {
    container: { maxWidth: 520, margin: '0 auto', padding: 16, fontFamily: 'system-ui,Segoe UI,Roboto,sans-serif' } as const,
    card: { border: '1px solid #e5e7eb', borderRadius: 16, padding: 16 } as const,
    h1: { fontSize: 20, marginBottom: 6 } as const,
    muted: { color: '#666', fontSize: 14 } as const,
    row: { display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginTop: 12 } as const,
    btnPrimary: { background: '#111', color: '#fff', padding: '12px 14px', borderRadius: 12, border: 0, fontWeight: 600 } as const,
    btnSecondary: {
      background: '#f4f4f5', color: '#111', padding: '12px 14px', borderRadius: 12, border: '1px solid #e5e7eb', fontWeight: 600
    } as const,
    disabled: { opacity: 0.6, cursor: 'not-allowed' } as const,
    previewBox: { marginTop: 12, borderRadius: 16, border: '1px solid #e5e7eb', overflow: 'hidden', background: '#fafafa', position: 'relative' } as const,
    img: { display: 'block', width: '100%', height: 'auto', objectFit: 'contain', maxHeight: '60vh' } as const,
    spinnerWrap: {
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.6)'
    } as const,
    spinner: {
      width: 40, height: 40, borderRadius: '50%',
      border: '4px solid #e5e7eb', borderTopColor: '#111', animation: 'spin 1s linear infinite'
    } as const,
    uploadRow: { display: 'flex', gap: 8, marginTop: 12 } as const,
    statusRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 } as const,
    check: {
      width: 36, height: 36, borderRadius: '50%', background: '#10b981', color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 18
    } as const,
    tip: { fontSize: 13, color: '#666' } as const
  }

  return (
    <div style={styles.container}>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>

      <div style={styles.card}>
        <h1 style={styles.h1}>Subir foto para proyectar</h1>
        <p style={{ ...styles.muted, marginBottom: 8 }}>Evento: <b>{event}</b></p>

        {!previewUrl && (
          <>
            <div style={styles.row as any}>
              <button type="button" onClick={openCamera} style={styles.btnPrimary}>Tomar foto</button>
              <button type="button" onClick={openGallery} style={styles.btnSecondary}>Elegir de galería</button>
            </div>

            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handlePick}
              style={{ display: 'none' }}
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              onChange={handlePick}
              style={{ display: 'none' }}
            />
          </>
        )}

        {previewUrl && (
          <>
            <div style={styles.previewBox}>
              <img src={previewUrl} alt="Previsualización" style={styles.img} onLoad={handleRevokeOldUrl} />
              {previewLoading && (
                <div style={styles.spinnerWrap}><div style={styles.spinner} /></div>
              )}
            </div>

            <div style={styles.uploadRow}>
              <button
                onClick={submit}
                disabled={loading || !fileToUpload}
                style={{ ...styles.btnPrimary, ...(loading || !fileToUpload ? styles.disabled : {}) }}
              >
                {loading ? 'Enviando…' : 'Enviar'}
              </button>
              <button
                onClick={resetSelection}
                disabled={loading}
                style={{ ...styles.btnSecondary, ...(loading ? styles.disabled : {}) }}
              >
                Reemplazar foto
              </button>
            </div>

            <div style={styles.statusRow}>
              {loading && <div style={styles.spinner} aria-label="Subiendo..." />}
              {done && !loading && <div style={styles.check}>✔</div>}
              {message && <div style={{ color: message.startsWith('¡Listo!') ? '#065f46' : 'crimson' }}>{message}</div>}
            </div>
          </>
        )}
      </div>

      <hr style={{ margin: '16px 0' }} />
      <p style={styles.tip}>Tip: generá un QR con <code>http://localhost:5173/uploader?event={event}</code></p>
    </div>
  )
}
