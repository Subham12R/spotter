import { useEffect, useRef } from 'react'
import 'leaflet/dist/leaflet.css'

const STOP_COLORS = {
  pickup:  '#22c55e',
  dropoff: '#ef4444',
  fuel:    '#E8A020',
  rest:    '#3b82f6',
  break:   '#6b7280',
}

/* HugeIcon SVG paths (viewBox 0 0 24 24, stroke white) for each stop type */
const STOP_SVG = {
  pickup: `
    <path d="M2.5 7.5V13.5C2.5 17.27 2.5 19.16 3.67 20.33C4.84 21.5 6.73 21.5 10.5 21.5H13.5C17.27 21.5 19.16 21.5 20.33 20.33C21.5 19.16 21.5 17.27 21.5 13.5V7.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M3.87 5.31L2.5 7.5H21.5L20.25 5.41C19.39 3.99 18.97 3.28 18.28 2.89C17.59 2.5 16.76 2.5 15.1 2.5H8.95C7.33 2.5 6.52 2.5 5.84 2.88C5.16 3.25 4.73 3.94 3.87 5.31Z" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M12 7.5V2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>`,
  dropoff: `
    <path d="M19.5 17.5C19.5 18.88 18.38 20 17 20C15.62 20 14.5 18.88 14.5 17.5C14.5 16.12 15.62 15 17 15C18.38 15 19.5 16.12 19.5 17.5Z" stroke="white" stroke-width="1.5" fill="none"/>
    <path d="M9.5 17.5C9.5 18.88 8.38 20 7 20C5.62 20 4.5 18.88 4.5 17.5C4.5 16.12 5.62 15 7 15C8.38 15 9.5 16.12 9.5 17.5Z" stroke="white" stroke-width="1.5" fill="none"/>
    <path d="M14.5 17.5H9.5M19.5 17.5H20.26C21.37 17.4 21.9 16.87 22 16.19V13C22 9.41 19.09 6.5 15.5 6.5M2 4H12C13.41 4 14.56 4.44 15 7V15.5M2 12.75V15C2 16.4 2.2 16.75 2.75 17.3C3.1 17.5 3.57 17.5 4.5 17.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M2 7H8M2 10H6" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>`,
  fuel: `
    <path d="M4 10H16" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M4 21V9C4 6.17 4 4.76 4.88 3.88C5.76 3 7.17 3 10 3C12.83 3 14.24 3 15.12 3.88C16 4.76 16 6.17 16 9V21H4Z" stroke="white" stroke-width="1.5" fill="none"/>
    <path d="M2 21H18" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M16 14H17.67C17.98 14 18.26 14.03 18.97 14.74C19 14.87 19 15.02 19 15.33V16.5C19 17.33 19.67 18 20.5 18C21.33 18 22 17.33 22 16.5V10.21C22 9.61 21.83 8.74 21.33 7.99L20.55 6.83C20.21 6.31 19.62 6 19 6" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>`,
  rest: `
    <path d="M2 3.5V20.5" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M22 8.5V20.5" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M2 8.5L6 10.5H22" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M2 15.5H6M22 15.5H19" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M6 10.5V16.5C6 18.15 6.35 18.5 8 18.5H17C18.65 18.5 19 18.15 19 16.5V10.5" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>`,
  break: `
    <path d="M5 7L6.76 17.4C7.07 19.21 7.22 20.12 7.76 20.74C9.21 22.42 14.79 22.42 16.24 20.74C16.78 20.12 16.93 19.21 17.24 17.4L19 7" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M4 7H20" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <ellipse cx="12" cy="14.5" rx="2" ry="2.5" stroke="white" stroke-width="1.5" fill="none"/>`,
}

function makeMarkerHtml(color, svgPaths) {
  return `<div style="
    width:32px;height:32px;border-radius:50%;
    background:${color};
    border:2.5px solid rgba(255,255,255,0.92);
    box-shadow:0 3px 14px rgba(0,0,0,0.7),0 1px 4px rgba(0,0,0,0.5);
    display:flex;align-items:center;justify-content:center;
  "><svg viewBox="0 0 24 24" width="15" height="15" fill="none" style="display:block">${svgPaths}</svg></div>`
}

function fmt(min) {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${m.toString().padStart(2, '0')} ${ap}`
}

export default function RouteMap({ polyline, stops }) {
  const containerRef = useRef(null)
  const mapRef       = useRef(null)
  const layersRef    = useRef([])

  useEffect(() => {
    let alive = true
    import('leaflet').then(({ default: L }) => {
      if (!alive || mapRef.current || !containerRef.current) return
      const map = L.map(containerRef.current, {
        center: [39.5, -98.35],
        zoom: 4,
        minZoom: 2,
        maxZoom: 18,
        maxBounds: [[-85.05, -180], [85.05, 180]],
        maxBoundsViscosity: 0.9,
        zoomControl: false,
      })
      L.control.zoom({ position: 'bottomright' }).addTo(map)

      L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        {
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
          subdomains: 'abcd',
          minZoom: 1,
          maxZoom: 19,
          noWrap: false,
        },
      ).addTo(map)
      mapRef.current = map
    })
    return () => {
      alive = false
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
    }
  }, [])

  useEffect(() => {
    if (!mapRef.current || !polyline?.length) return
    import('leaflet').then(({ default: L }) => {
      const map = mapRef.current
      layersRef.current.forEach(l => map.removeLayer(l))
      layersRef.current = []

      const line = L.polyline(polyline, {
        color: '#E8A020',
        weight: 3.5,
        opacity: 0.9,
        lineJoin: 'round',
        lineCap: 'round',
      }).addTo(map)
      layersRef.current.push(line)

      stops?.forEach(stop => {
        const color    = STOP_COLORS[stop.type] ?? '#6b7280'
        const svgPaths = STOP_SVG[stop.type] ?? STOP_SVG.break
        const icon     = L.divIcon({
          className: '',
          html: makeMarkerHtml(color, svgPaths),
          iconSize: [32, 32],
          iconAnchor: [16, 16],
          popupAnchor: [0, -18],
        })
        const marker = L.marker([stop.lat, stop.lng], { icon })
        marker.bindPopup(`
          <div style="font-family:system-ui,sans-serif;font-size:12px;min-width:150px;line-height:1.5">
            <div style="font-weight:700;margin-bottom:4px;font-size:13px">${stop.label}</div>
            <div style="opacity:0.7;margin-bottom:4px">${stop.location}</div>
            <div style="opacity:0.55;font-size:11px">Day ${stop.day} · ${fmt(stop.time_of_day_min)}</div>
            <div style="opacity:0.55;font-size:11px">${stop.duration_min} min · ${stop.miles_mark} mi mark</div>
          </div>
        `, { className: 'eld-popup', maxWidth: 220 })
        marker.addTo(map)
        layersRef.current.push(marker)
      })

      map.fitBounds(line.getBounds(), { padding: [56, 56], maxZoom: 10 })
    })
  }, [polyline, stops])

  return (
    <div className="map-wrap">
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}
