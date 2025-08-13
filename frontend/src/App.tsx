import { useMemo } from 'react'
import Uploader from './pages/Uploader.tsx'
import Screen from './pages/Screen.tsx'

function useRoute() {
  return useMemo(() => location.pathname.startsWith('/screen') ? 'screen' : 'uploader', [])
}

export default function App() {
  const route = useRoute()
  return route === 'screen' ? <Screen /> : <Uploader />
}
