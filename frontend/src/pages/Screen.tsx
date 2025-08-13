import { useEffect, useRef, useState } from 'react'

type State = {
  current: { url: string, duration: number, started_at: string | null },
  queue_size: number
}

export default function Screen() {
  const params = new URLSearchParams(location.search)
  const event = params.get('event') || 'default'

  const [state, setState] = useState<State | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef<number>(0)

  const fetchState = async () => {
    try {
      const r = await fetch(`/api/screen/state?event=${encodeURIComponent(event)}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json: State = await r.json()
      setState(json)
    } catch (err) {
      console.error('fetchState error:', err)
    }
  }

  // Base del backend para construir URLs absolutas
  const buildBackendOrigin = () => {
    // En dev podés fijar el backend con VITE_BACKEND_ORIGIN, ej: http://localhost:8000
    if (import.meta.env.DEV) {
      return (import.meta.env as any).VITE_BACKEND_ORIGIN ?? `${location.protocol}//localhost:8000`
    }
    // En prod asumimos mismo host donde sirve la pantalla
    return `${location.protocol}//${location.host}`
  }

  // Si la API devuelve una URL relativa (/uploads/...), la volvemos absoluta con el backend
  const toAbsoluteUrl = (u: string | null | undefined) => {
    if (!u) return null
    const trimmed = u.trim()
    if (!trimmed) return null
    if (/^https?:\/\//i.test(trimmed)) return trimmed // ya es absoluta
    if (trimmed.startsWith('/')) return `${buildBackendOrigin()}${trimmed}`
    return trimmed
  }

  const buildWsUrl = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    // En dev, si tu backend corre en otro host/puerto, definí VITE_BACKEND_HOST (p.ej. localhost:8000)
    const host = import.meta.env.DEV
      ? ((import.meta.env as any).VITE_BACKEND_HOST ?? 'localhost:8000')
      : location.host
    return `${proto}://${host}/api/ws/screen?event=${encodeURIComponent(event)}`
  }

  const connect = () => {
    const url = buildWsUrl()
    console.log('WS connecting to', url)
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WS open')
      retryRef.current = 0
      // Estado inicial
      fetchState()
    }

    ws.onmessage = () => {
      // El backend envía {type: 'current_update' | 'queue_update' | 'ping'}
      fetchState()
    }

    ws.onerror = (e) => {
      console.warn('WS error', e)
    }

    ws.onclose = () => {
      console.warn('WS closed')
      // reconexión con backoff (máx 10s)
      const retryMs = Math.min(10000, (retryRef.current + 1) * 1000)
      retryRef.current += 1
      setTimeout(connect, retryMs)
    }
  }

  useEffect(() => {
    connect()
    return () => {
      wsRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event])

  if (!state) return null
  const imgSrc = toAbsoluteUrl(state.current?.url)

  return (
    <div
      style={{
        width:'100vw',
        height:'100vh',
        background:'black',
        display:'flex',
        alignItems:'center',
        justifyContent:'center'
      }}
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          style={{ maxWidth:'100%', maxHeight:'100%', objectFit:'contain' }}
        />
      ) : null}
    </div>
  )
}
