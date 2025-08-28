import { useEffect, useMemo, useRef, useState } from 'react'

type State = {
  current: { url: string; username?: string } | null
  queue_size: number
  idle?: boolean // opcional si el backend lo envía
}

type Dim = { w: number; h: number }

// === Carrusel (nuevo) ===
type DefaultsItem = { url: string; order: number; duration_ms: number }
type DefaultsPayload = { items: DefaultsItem[] }

const ASPECT = 4 / 3

export default function Screen() {
  const params = new URLSearchParams(location.search)
  const event = params.get('event') || 'default'
  const fitParam = (params.get('fit') || 'contain').toLowerCase() as 'cover' | 'contain'
  // Fallback global de duración cuando el backend no la provee por slide
  const dMsFallback = Math.max(500, parseInt(params.get('dMs') || '8000', 10))
  const ignoreBackendDefault = params.get('ignoreBackendDefault') === '1'

  // (DEPRECATED) Fallback estático que ya tenías; lo dejo por compat en caso de error del endpoint.
  const dPrefix = '/static/defaults/default_'
  const dPad    = parseInt(params.get('dPad') || '2', 10)
  const dStart  = parseInt(params.get('dStart') || '0', 10)
  const dEnd    = parseInt(params.get('dEnd') || '15', 10)
  const dExt    = params.get('dExt') || '.jpg'

  const [state, setState] = useState<State | null>(null)
  const [size, setSize]   = useState<Dim | null>(null)

  // Carrusel desde backend
  const [defaults, setDefaults] = useState<DefaultsItem[]>([])
  const [dIndex, setDIndex] = useState(0)
  const dTimerRef = useRef<number | null>(null)

  // Fallback estático si /api/screen/defaults falla
  const staticFallbackList = useMemo(() => {
    const out: string[] = []
    for (let n = dStart; n <= dEnd; n++) {
      const num = String(n).padStart(dPad, '0')
      out.push(`${dPrefix}${num}${dExt}`)
    }
    return out
  }, [dPrefix, dStart, dEnd, dPad, dExt])

  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(0)

  const PADDING = { top: 5, side: 5, bottom: 5 }

  // -- helpers
  const buildBackendOrigin = () => {
    if (import.meta.env.DEV) {
      return (import.meta.env as any).VITE_BACKEND_ORIGIN ?? `${location.protocol}//localhost:8000`
    }
    return `${location.protocol}//${location.host}`
  }
  const abs = (u?: string | null) => {
    if (!u) return null
    const s = u.trim()
    if (!s) return null
    if (/^https?:\/\//i.test(s)) return s
    if (s.startsWith('/')) return `${buildBackendOrigin()}${s}`
    return s
  }
  const wsUrl = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const host = import.meta.env.DEV
      ? ((import.meta.env as any).VITE_BACKEND_HOST ?? 'localhost:8000')
      : location.host
    return `${proto}://${host}/api/ws/screen?event=${encodeURIComponent(event)}`
  }
  const fetchState = async () => {
    const r = await fetch(`/api/screen/state?event=${encodeURIComponent(event)}`)
    const json: State = await r.json()
    setState(json)
  }

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch(`/api/screen/defaults?event=${encodeURIComponent(event)}`)
        const json: DefaultsPayload = await r.json()
  
        const raw = Array.isArray(json) ? json : (json.items || [])
        const ok = (url: string) => /\.(jpe?g|png|webp)(\?|#|$)/i.test(url)
        const natural = (s: string) => {
          const m = String(s).match(/(\d+)/)
          return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER
        }
  
        const ordered = raw
          .filter(x => x && typeof x.url === 'string' && ok(x.url))
          .sort((a, b) => {
            if (typeof a.order === 'number' || typeof b.order === 'number') {
              return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
            }
            return natural(a.url) - natural(b.url)
          })
          .map((x, i) => ({
            url: x.url,
            order: typeof x.order === 'number' ? x.order : i,
            duration_ms: typeof x.duration_ms === 'number'
              ? x.duration_ms
              : (typeof (x as any).duration === 'number' ? (x as any).duration : undefined)
          }))
  
        if (!ordered.length) throw new Error('Lista de defaults vacía')
  
        // --- conservar índice si es posible ---
        setDefaults(prev => {
          const same =
            prev.length === ordered.length &&
            prev.every((it, idx) => it.url === ordered[idx].url)
  
          if (same) {
            // misma lista: no toco dIndex
            return ordered
          } else {
            // lista distinta: ajusto índice al nuevo tamaño
            setDIndex(i => ordered.length ? i % ordered.length : 0)
            return ordered
          }
        })
      } catch (e) {
        console.warn('No pude cargar /api/screen/defaults, uso fallback estático', e)
        const mapped: DefaultsItem[] = staticFallbackList.map((url, i) => ({
          url,
          order: i,
          duration_ms: dMsFallback
        }))
        setDefaults(prev => {
          const same =
            prev.length === mapped.length &&
            prev.every((it, idx) => it.url === mapped[idx].url)
          if (!same) setDIndex(i => mapped.length ? i % mapped.length : 0)
          return mapped
        })
      }
    }
    load()
    // (opcional) si no cambia a menudo, subí el refresh a 300s o desactivalo
    const id = window.setInterval(load, 300000)
    return () => window.clearInterval(id)
  }, [event, staticFallbackList, dMsFallback])
  

  // WS
  useEffect(() => {
    const ws = new WebSocket(wsUrl())
    wsRef.current = ws
    ws.onopen = () => { retryRef.current = 0; fetchState() }
    ws.onmessage = () => fetchState()
    ws.onerror = (e) => console.warn('WS error', e)
    ws.onclose = () => {
      const retryMs = Math.min(10000, (retryRef.current + 1) * 1000)
      retryRef.current += 1
      setTimeout(() => { const w = new WebSocket(wsUrl()); wsRef.current = w }, retryMs)
    }
    return () => ws.close()
  }, [event])

  // no scroll
  useEffect(() => {
    const html = document.documentElement, body = document.body
    const ph = html.style.overflow, pbo = body.style.overflow, pbm = body.style.margin
    html.style.overflow = 'hidden'; body.style.overflow = 'hidden'; body.style.margin = '0'
    return () => { html.style.overflow = ph; body.style.overflow = pbo; body.style.margin = pbm }
  }, [])

  // calcular tamaño 4:3
  const recalc = () => {
    const availW = window.innerWidth  - (PADDING.side * 2)
    const availH = window.innerHeight - (PADDING.top + PADDING.bottom)
    if (availW <= 0 || availH <= 0) { setSize(null); return }
    const viewportAspect = availW / availH
    let w: number, h: number
    if (viewportAspect >= ASPECT) { h = availH; w = Math.floor(h * ASPECT) }
    else { w = availW; h = Math.floor(w / ASPECT) }
    setSize({ w: Math.floor(w), h: Math.floor(h) })
  }
  useEffect(() => {
    recalc()
    const onResize = () => recalc()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ¿Idle?
  const backendCurrentLooksDefault = !!state?.current?.url && /\/default/i.test(state.current.url)
  const derivedIdle = !!state && state.current === null && (state.queue_size ?? 0) === 0
  const isIdle = (state?.idle === true) || (derivedIdle) || (!!state && ignoreBackendDefault && backendCurrentLooksDefault && (state.queue_size ?? 0) === 0)

  // Timer del carrusel (usa duration_ms si viene; si no, fallback)
  useEffect(() => {
    if (dTimerRef.current) {
      window.clearTimeout(dTimerRef.current)
      dTimerRef.current = null
    }
    if (isIdle && defaults.length > 0) {
      const ms = Math.max(250, defaults[dIndex]?.duration_ms ?? dMsFallback)
      dTimerRef.current = window.setTimeout(() => {
        setDIndex(i => (i + 1) % defaults.length)
      }, ms)
    }

    return () => {
      if (dTimerRef.current) {
        window.clearTimeout(dTimerRef.current)
        dTimerRef.current = null
      }
    }
  }, [isIdle, defaults, dIndex, dMsFallback])

  // precarga del próximo slide
  useEffect(() => {
    if (!isIdle || defaults.length <= 1) return
    const next = defaults[(dIndex + 1) % defaults.length]?.url
    if (!next) return
    const pre = new Image()
    pre.src = abs(next) ?? next
  }, [isIdle, dIndex, defaults])

  // imagen activa — si estamos idle (o forceIdle), SIEMPRE usar carrusel
  const activeImg = (() => {
    if (isIdle && defaults.length) {
      const u = defaults[dIndex]?.url
      return abs(u) ?? u
    }
    if (state?.current) {
      const u = abs(state.current.url)
      if (u) return u
    }
    return null
  })()

  const username = state?.current?.username || ''

  // Persistir índice por evento
  useEffect(() => {
    // guardo cada cambio
    localStorage.setItem(`screen:dIndex:${event}`, String(dIndex))
  }, [dIndex, event])

  // Restaurar índice 1 sola vez cuando ya tengo defaults
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    if (defaults.length === 0) return
    const saved = parseInt(localStorage.getItem(`screen:dIndex:${event}`) || '0', 10)
    if (!Number.isNaN(saved)) {
      setDIndex(saved % defaults.length)
    }
    restoredRef.current = true
  }, [defaults.length, event])

  return (
    <div
      style={{
        width: '100vw', height: '100vh', boxSizing: 'border-box',
        paddingTop: PADDING.top, paddingLeft: PADDING.side,
        paddingRight: PADDING.side, paddingBottom: PADDING.bottom,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'Great Vibes', cursive, 'Poppins', sans-serif",
        overflow: 'hidden',
        background: 'black'
      }}
    >
      <div
        style={{
          width: size?.w ?? 0,
          height: size?.h ?? 0,
          position: 'relative',
          display: size ? 'block' : 'none',
          background: 'black'
        }}
      >
        {activeImg && (
          <img
            key={activeImg}
            src={activeImg}
            alt=""
            onError={() => {
              // saltar a la siguiente del carrusel si falla (solo cuando idle)
              if (isIdle && defaults.length > 1) {
                setDIndex(i => (i + 1) % defaults.length)
              }
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: fitParam,
              objectPosition: 'center',
              display: 'block',
              position: 'relative',
              zIndex: 1
            }}
          />
        )}

        {username && !(ignoreBackendDefault && backendCurrentLooksDefault) && (
          <div
            style={{
              position: 'absolute',
              right: 10, bottom: 8,
              fontSize: 20, fontWeight: 600,
              color: 'white',
              background: 'rgba(0,0,0,0.5)',
              padding: '2px 8px', borderRadius: 8,
              textShadow: '0 1px 3px rgba(0,0,0,0.5)',
              backdropFilter: 'blur(2px)',
              zIndex: 3
            }}
          >
            {username}
          </div>
        )}
      </div>
    </div>
  )
}
