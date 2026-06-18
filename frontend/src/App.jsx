import { useState, useRef, useCallback } from 'react'
import { Toaster, toast } from 'sonner'
import TripForm    from './TripForm'
import RouteMap    from './RouteMap'
import ELDLogSheet from './ELDLogSheet'
import StopList    from './StopList'
import './App.css'

const MIN_ELD_H = 140
const DEFAULT_ELD_H = 320

export default function App() {
  const [loading,       setLoading]       = useState(false)
  const [result,        setResult]        = useState(null)
  const [eldH,          setEldH]          = useState(DEFAULT_ELD_H)
  const [startLocation, setStartLocation] = useState(null)

  const isDragging = useRef(false)
  const startY     = useRef(0)
  const startH     = useRef(0)

  const onDragStart = useCallback((e) => {
    e.preventDefault()
    isDragging.current = true
    startY.current = e.clientY
    startH.current = eldH

    const onMove = (ev) => {
      if (!isDragging.current) return
      const delta = startY.current - ev.clientY
      const maxH  = window.innerHeight - 48
      setEldH(Math.max(MIN_ELD_H, Math.min(maxH, startH.current + delta)))
    }
    const onUp = () => {
      isDragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [eldH])

  async function handleSubmit(formData) {
    setLoading(true)
    setResult(null)
    setStartLocation(formData.current_location)
    try {
      const base = import.meta.env.VITE_API_URL ?? ''
      const res  = await fetch(`${base}/api/plan-trip/`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(formData),
      })
      let data = {}
      try { data = await res.json() } catch { /* non-JSON body */ }
      if (!res.ok) {
        toast.error(data.error ?? `Server error ${res.status}.`)
      } else {
        setResult(data)
        toast.success(`Route planned — ${data.route.total_miles} mi · ${data.route.total_days} days`)
      }
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }

  const route = result?.route

  return (
    <div className="app">
      {/* ── Full-screen map (base layer) ── */}
      <RouteMap polyline={route?.polyline} stops={route?.stops} />

      {/* ── Left floating panel ── */}
      <aside className="panel panel--left">
        <TripForm onSubmit={handleSubmit} loading={loading} />

        {route?.stops?.length > 0 && (
          <StopList
            stops={route.stops}
            totalMiles={route.total_miles}
            totalDays={route.total_days}
            startLocation={startLocation}
          />
        )}

        {result?.cycle_warning && (
          <div className="cycle-warn">
            <span className="cycle-warn__dot" />
            {result.cycle_warning}
          </div>
        )}
      </aside>

      {/* ── Bottom ELD panel (draggable height) ── */}
      {result?.eld_logs?.length > 0 && (
        <section className="panel panel--eld" style={{ height: eldH }}>
          <div
            className="eld-drag"
            onMouseDown={onDragStart}
            title="Drag to resize"
          />
          <header className="eld-header">
            <span className="eld-header__title">ELD Log Sheets</span>
            <div className="eld-header__meta">
              <span>{result.eld_logs.length} day{result.eld_logs.length !== 1 ? 's' : ''}</span>
              <span className="sep">·</span>
              <span>{route.total_miles} mi</span>
              <span className="sep">·</span>
              <span>{route.total_days} driving day{route.total_days !== 1 ? 's' : ''}</span>
            </div>
          </header>
          <div className="eld-body">
            {result.eld_logs.map(log => (
              <ELDLogSheet key={log.day} day={log} />
            ))}
          </div>
        </section>
      )}

      <Toaster position="top-right" theme="dark" richColors closeButton />
    </div>
  )
}
