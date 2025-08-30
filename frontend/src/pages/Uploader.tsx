import { useEffect, useRef, useState } from 'react'
import confetti from 'canvas-confetti'

export default function Uploader() {
  const MAX_PREVIEW = 1920
  const params = new URLSearchParams(location.search)
  const event = params.get('event') || 'default'

  // Bloqueo de "back" mientras el usuario está en el flujo de preview/subida
  const blockBackRef = useRef(false);

  // === Ajustes específicos para Android (sin tocar estilos ni UI) ===
  const UA = navigator.userAgent.toLowerCase();
  const IS_ANDROID = UA.includes('android');
  const ANDROID_PREVIEW_MAX = 1280; // target conservador para evitar OOM en selfies

  // ---------- nombre de usuario ----------
  const NAME_KEY = 'uploader_name'
  const [uploaderName, setUploaderName] = useState<string>(() => localStorage.getItem(NAME_KEY) || '')
  const [editingName, setEditingName] = useState(!uploaderName)

  const saveName = () => {
    const v = uploaderName.trim()
    const ok = /^[A-Za-z0-9 _-]{1,32}$/.test(v)   // permito espacio para nombres de invitados
    if (!ok) {
      alert('Nombre inválido. Usá letras/números/espacio/guión/guión_bajo (1 a 32).')
      return
    }
    localStorage.setItem(NAME_KEY, v)
    setUploaderName(v)
    setEditingName(false)
  }

  // ---- device_id persistente (ya existente) ----
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

  function fireWeddingConfetti() {
    const colors = ['#ffffff', '#0b1a39']; // blanco y azul marino
  
    // ráfaga izquierda → derecha
    confetti({
      particleCount: 60,
      angle: 60,
      spread: 60,
      origin: { x: 0, y: 0.6 },
      colors,
      scalar: 1.0
    });
  
    // ráfaga derecha → izquierda (ligero delay para efecto)
    setTimeout(() => {
      confetti({
        particleCount: 60,
        angle: 120,
        spread: 60,
        origin: { x: 1, y: 0.6 },
        colors,
        scalar: 1.0
      });
    }, 120);
  
    // lluvia suave al centro
    setTimeout(() => {
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { x: 0.5, y: 0.3 },
        colors,
        scalar: 0.9,
        ticks: 200
      });
    }, 180);
  }
  
  const deviceId = getDeviceId()

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
    const onPop = (_ev: PopStateEvent) => {
      // Si debemos bloquear, reinsertamos el estado para anular el "back"
      if (blockBackRef.current) {
        history.pushState(null, '', location.href);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []); 

  useEffect(() => {
    const shouldBlock = !!previewUrl || loading;
    blockBackRef.current = shouldBlock;
    // Al habilitar el bloqueo, metemos un estado dummy en el historial
    if (shouldBlock) {
      history.pushState(null, '', location.href);
    }
  }, [previewUrl, loading]);
  

  useEffect(() => {
    return () => { if (currentPreviewRef.current) URL.revokeObjectURL(currentPreviewRef.current) }
  }, [])

  const openCamera = () => cameraInputRef.current?.click()
  const openGallery = () => galleryInputRef.current?.click()

  const resetSelection = () => {
    setFileToUpload(null)
    if (currentPreviewRef.current) { URL.revokeObjectURL(currentPreviewRef.current); currentPreviewRef.current = null }
    setPreviewUrl(null)
    setPreviewLoading(false)
    setLoading(false)
    setDone(false)
    setMessage(null)
    if (cameraInputRef.current) cameraInputRef.current.value = ''
    if (galleryInputRef.current) galleryInputRef.current.value = ''
  }

  async function buildPreviewUrl(
    file: File,
    currentPreviewRef: { current: string | null },
    setPreviewUrl: (u: string | null) => void,
    setPreviewLoading: (b: boolean) => void,
    onReady?: () => void
  ) {
    setPreviewLoading(true)
    const target = IS_ANDROID ? ANDROID_PREVIEW_MAX : MAX_PREVIEW
    let bmp: ImageBitmap | null = null

    try {
      // ⚠️ Solo 'resizeWidth' para mantener aspecto y evitar decodificación gigante
      bmp = await (createImageBitmap as any)(file, {
        resizeWidth: target,
        resizeQuality: 'high',
      })
    } catch {
      const tmpUrl = URL.createObjectURL(file)
      try {
        const img = document.createElement('img')
        img.decoding = 'async'
        img.src = tmpUrl
        await img.decode()
        const maxSide = Math.max(img.naturalWidth, img.naturalHeight)
        const scale = Math.min(1, target / maxSide)
        const outW = Math.max(1, Math.round(img.naturalWidth * scale))
        const outH = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = outW
        canvas.height = outH
        const ctx = canvas.getContext('2d', { alpha: false })!
        ctx.drawImage(img, 0, 0, outW, outH)
        const blob: Blob = await new Promise((res, rej) =>
          canvas.toBlob(b => (b ? res(b) : rej(new Error('toBlob preview falló'))), 'image/webp', IS_ANDROID ? 0.75 : 0.8)
        )
        const newUrl = URL.createObjectURL(blob)
        const oldUrl = currentPreviewRef.current
        currentPreviewRef.current = newUrl
        setPreviewUrl(newUrl)
        ;(handleRevokeOldUrl as any).pending = oldUrl
        setPreviewLoading(false)
        onReady?.()
        return
      } finally {
        URL.revokeObjectURL(tmpUrl)
      }
    }

    const cnv = document.createElement('canvas')
    cnv.width = bmp!.width
    cnv.height = bmp!.height
    const ctx2 = cnv.getContext('2d', { alpha: false })!
    ctx2.drawImage(bmp!, 0, 0)
    try { (bmp as any).close?.() } catch {}

    const blob: Blob = await new Promise((res, rej) =>
      cnv.toBlob(b => (b ? res(b) : rej(new Error('toBlob preview falló'))), 'image/webp', IS_ANDROID ? 0.75 : 0.8)
    )
    const newUrl = URL.createObjectURL(blob)
    const oldUrl = currentPreviewRef.current
    currentPreviewRef.current = newUrl
    setPreviewUrl(newUrl)
    ;(handleRevokeOldUrl as any).pending = oldUrl
    setPreviewLoading(false)
    onReady?.()
  }

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setMessage(null); setDone(false)
    setFileToUpload(f)
    try {
      await buildPreviewUrl(f, currentPreviewRef, setPreviewUrl, setPreviewLoading)
    } catch {
      setPreviewUrl(null)
      setPreviewLoading(false)
      setMessage('No se pudo generar la vista previa (memoria). Podés enviar la foto igual.')
    }
  }

  const handleRevokeOldUrl = () => {
    setPreviewLoading(false)
    const oldUrl = (handleRevokeOldUrl as any).pending as string | null
    if (oldUrl) { try { URL.revokeObjectURL(oldUrl) } catch {} ;(handleRevokeOldUrl as any).pending = null }
  }

  const submit = async () => {
    if (!fileToUpload || !uploaderName) return
    setLoading(true); setDone(false); setMessage(null)

    const fd = new FormData()
    fd.append('event', event)
    fd.append('file', fileToUpload)
    fd.append('device_id', deviceId)
    fd.append('uploader_name', uploaderName)

    try {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/photos', true)
      xhr.setRequestHeader('X-Device-Id', deviceId)
      xhr.setRequestHeader('X-Uploader-Name', uploaderName)

      xhr.onreadystatechange = () => {
        if (xhr.readyState === XMLHttpRequest.DONE) {
          setLoading(false)
          if (xhr.status >= 200 && xhr.status < 300) {
            setDone(true)
            setMessage('¡Listo! Tu foto se proyectará en breve.')
            // 🎉 Confeti con paleta boda
            fireWeddingConfetti();
            // reinicio luego de 3s
            setTimeout(() => { resetSelection() }, 3000)
          } else {
            let errMsg = 'Error al subir la foto'
            try {
              const j = JSON.parse(xhr.responseText)
              if (xhr.status === 429) errMsg = j?.error || 'Rate limit: esperá unos segundos y volvé a intentar.'
              else if (xhr.status === 400) errMsg = j?.detail || j?.error || errMsg
              else errMsg = j?.error || errMsg
            } catch {}
            setMessage(errMsg); setDone(false)
          }
        }
      }

      xhr.onerror = () => { setLoading(false); setDone(false); setMessage('No se pudo conectar al servidor.') }
      xhr.send(fd)
    } catch {
      setLoading(false); setDone(false); setMessage('No se pudo conectar al servidor.')
    }
  }

  return (
    <div className="wdg-page">
      {/* Fuentes + estilos */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Great+Vibes&family=Poppins:wght@400;600;700&display=swap');
  
        :root{
          --wdg-primary: #00008B;   /* rosa elegante */
          --wdg-primary-dark: #d81b60;
          --wdg-gold: #d4af37;      /* dorado */
          --wdg-bg: #fff7fb;        /* blush muy suave */
          --wdg-border: #f3e5f5;
          --wdg-text: #433;         /* gris cálido */
          --wdg-muted: #766;
        }
  
        /* ===== Fondo pantalla completa ===== */
        .wdg-page{
          position: fixed;
          inset: 0;
          background: url('/fondo.jpg') no-repeat center center;
          background-size: cover;   /* ocupa todo sin bandas negras */
          overflow: hidden;         /* sin scroll */
          font-family: 'Poppins','Segoe UI',system-ui,Roboto,sans-serif;
          color: var(--wdg-text);
        }
        /* Velo para contraste (opcional, ajusta opacidad si querés) */
        .wdg-page::before{
          content: "";
          position: absolute; inset: 0;
          background: rgba(0,0,0,0.25);
        }
  
        /* Contenedor que centra y da respiración en bordes */
        .wdg-center{
          position: relative;       /* sobre el overlay */
          z-index: 1;
          min-height: 100vh;
          display: grid;
          place-items: center;      /* centro vertical y horizontal */
          padding: 16px;            /* evita pegar la tarjeta a los bordes en móviles */
          box-sizing: border-box; /* que cuente el padding dentro del ancho total */
        }
  
        /* ===== Tarjeta ===== */
        .wdg-card{
          position: relative;       /* base para corazones internos */
          width: 90%;
          max-width: 560px;
          border: 1px solid var(--wdg-border);
          border-radius: 24px;
          padding: 24px;
          background:
            radial-gradient(80% 60% at 10% 0%, #ffe9f2 0%, transparent 60%),
            radial-gradient(80% 60% at 100% 10%, #fff2e0 0%, transparent 60%),
            linear-gradient(145deg, #fff, var(--wdg-bg));
          box-shadow: 0 10px 28px rgba(0,0,0,0.18);
          overflow: hidden;
        }
  
        /* Corazones SOLO dentro de la tarjeta */
        .wdg-hearts{
          position:absolute; inset:0; pointer-events:none; opacity:.15;
          border-radius: inherit;
          background:
            url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><text x="10" y="45" font-size="28">❤</text></svg>')
            repeat;
          background-size: 40px 40px;
          animation: float 14s linear infinite;
        }
        @keyframes float { from{background-position:0 0} to{background-position:0 200px} }
  
        .wdg-title{
          font-family: 'Great Vibes', cursive;
          font-size: 40px;
          line-height: 1;
          margin: 0 0 4px;
          color: var(--wdg-primary);
          text-shadow: 0 2px 0 rgba(0,0,0,0.04);
          text-align: center;
        }
        .wdg-sub{ font-size: 14px; color: var(--wdg-muted); margin-bottom: 14px; }
        .wdg-event b{ color: var(--wdg-gold); }
  
        .wdg-row{ display:grid; grid-template-columns: 1fr; gap: 10px; margin-top: 14px; }
  
        .wdg-input{
          width: 100%;
          padding: 12px 14px;
          border-radius: 16px;
          border: 1px solid #eadcf1;
          background: #fff;
          outline: none;
          transition: box-shadow .2s, border-color .2s;
          font-size: 15px;
          color: black;
        }
        .wdg-input:focus{
          border-color: var(--wdg-primary);
          box-shadow: 0 0 0 4px rgba(233,30,99,.12);
        }
  
        .wdg-btn{
          padding: 14px 16px;
          border-radius: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: transform .05s ease-out, box-shadow .2s, background .2s;
          border: 0;
        }
        .wdg-btn:active{ transform: translateY(1px); }
  
        .wdg-btn--primary{
          background: var(--wdg-primary);
          color: #fff;
        }
        .wdg-btn--primary:hover{ background: var(--wdg-primary-dark); }
  
        .wdg-btn--secondary{
          background: #f7f7f8;
          color: #333;
          border: 1px solid #e9e9ea;
          z-index: 2;
        }
        .wdg-btn--secondary:hover{ background:#efeff0; }
  
        .wdg-name-row{ display:flex; gap:10px; align-items:center; margin-top: 14px; }
        .wdg-badge{
          background: #fff0f6;
          border: 1px solid #f8bbd0;
          color: #c2185b;
          padding: 6px 12px;
          border-radius: 999px;
          font-size: 14px;
          display:flex; align-items:center; gap:8px;
        }
  
        .wdg-preview{
          margin-top: 14px; border-radius: 20px; border: 1px solid #eee;
          overflow:hidden; background:#fafafa; position:relative;
        }
        .wdg-img{ display:block; width:100%; height:auto; object-fit:contain; max-height:60vh; }
        .wdg-spinner-wrap{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(255,255,255,.65) }
        .wdg-spinner{ width:40px;height:40px;border-radius:50%;border:4px solid #f1f1f1;border-top-color: var(--wdg-primary); animation:spin 1s linear infinite }
        @keyframes spin{ from{transform:rotate(0)} to{transform:rotate(360deg)} }
  
        .wdg-upload-row{ display:flex; gap:10px; margin-top:14px; }
        .wdg-status{ display:flex; align-items:center; gap:10px; margin-top:14px }
        .wdg-check{ width:36px; height:36px; border-radius:50%; background:#4caf50; color:#fff; display:inline-flex; align-items:center; justify-content:center; font-weight:800; font-size:18px }
  
        .wdg-tip{
          font-size: 13px;
          color: white;
          margin-top: 16px;
          text-align: center;
          position: relative;
          z-index: 1; 
        }
  
        .wdg-icon{ font-size: 18px }

        @keyframes pop {
          0% { transform: scale(0); opacity: 0; }
          70% { transform: scale(1.3); opacity: 1; }
          100% { transform: scale(1); }
        }
        .wdg-check {
          animation: pop 0.5s ease-out;
        }
      `}</style>
  
      <div className="wdg-center">
        <div className="wdg-card">
          <div className="wdg-hearts" aria-hidden="true" />
          <h1 className="wdg-title">¡Comparte tu momento!</h1>
          {/* Oculto el nombre del evento en la vista
          <p className="wdg-sub wdg-event">Evento: <b>{event}</b></p>
          */}
  
          {/* Gate de nombre */}
          {editingName ? (
            <div className="wdg-name-row">
              <input
                className="wdg-input"
                placeholder="Ingresa tu nombre"
                value={uploaderName}
                onChange={e => setUploaderName(e.target.value)}
                onKeyDown={e => (e.key === 'Enter' ? saveName() : null)}
              />
              <button type="button" onClick={saveName} className="wdg-btn wdg-btn--primary">
                Confirmar
              </button>
            </div>
          ) : (
            <div className="wdg-name-row">
              <span className="wdg-badge"><span className="wdg-icon">❤</span> Subiendo como: <b>{uploaderName}</b></span>
              <button type="button" onClick={()=>setEditingName(true)} className="wdg-btn wdg-btn--secondary">Cambiar</button>
            </div>
          )}
  
          {/* Acciones (bloqueadas si no hay nombre confirmado) */}
          {!editingName && !previewUrl && (
            <>
              <div className="wdg-row">
                <button type="button" onClick={openCamera} className="wdg-btn wdg-btn--primary">📷 Tomar foto</button>
                <button type="button" onClick={openGallery} className="wdg-btn wdg-btn--secondary">🖼️ Elegir de galería</button>
              </div>
  
              <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handlePick} style={{ display: 'none' }} />
              <input ref={galleryInputRef} type="file" accept="image/*" onChange={handlePick} style={{ display: 'none' }} />
            </>
          )}
  
          {previewUrl && (
            <>
              <div className="wdg-preview">
                <img src={previewUrl} alt="Previsualización" className="wdg-img" onLoad={handleRevokeOldUrl} />
                {previewLoading && (<div className="wdg-spinner-wrap"><div className="wdg-spinner" /></div>)}
              </div>
  
              <div className="wdg-upload-row">
                <button onClick={submit} disabled={loading || !fileToUpload || !uploaderName} className="wdg-btn wdg-btn--primary">
                  {loading ? 'Enviando…' : 'Enviar'}
                </button>
                <button onClick={resetSelection} disabled={loading} className="wdg-btn wdg-btn--secondary">
                  Reemplazar foto
                </button>
              </div>
  
              <div className="wdg-status">
                {loading && <div className="wdg-spinner" aria-label="Subiendo..." />}
                {done && !loading && <div className="wdg-check">✔</div>}
                {message && <div style={{ color: message.startsWith('¡Listo!') ? '#065f46' : 'crimson' }}>{message}</div>}
              </div>
            </>
          )}
        </div>

        <p className="wdg-tip">Tip: 1 de agua cada 1 de alcohol.</p>

      </div>
    </div>
  )
  
}
