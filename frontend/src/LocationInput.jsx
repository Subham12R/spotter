import { useState, useRef, useEffect } from 'react'
import { Location03Icon, DeliveryBox01Icon, DeliveryTruck01Icon, MapingIcon } from 'hugeicons-react'

const LABEL_ICONS = {
  start:   MapingIcon,
  pickup:  DeliveryBox01Icon,
  dropoff: DeliveryTruck01Icon,
}

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const UA = 'ELDTripPlanner/1.0 (contact@eldplanner.app)'

async function search(query) {
  try {
    const res = await fetch(
      `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1&countrycodes=us`,
      { headers: { 'User-Agent': UA } },
    )
    if (!res.ok) return []
    return (await res.json()).map(item => {
      const a = item.address ?? {}
      const city  = a.city || a.town || a.village || a.municipality || a.county || ''
      const state = a.state || ''
      return { label: [city, state].filter(Boolean).join(', ') || item.display_name.split(',')[0].trim() }
    })
  } catch {
    return []
  }
}

async function reverseGeocode(lat, lng) {
  try {
    const res  = await fetch(`${NOMINATIM}/reverse?lat=${lat}&lon=${lng}&format=json`, {
      headers: { 'User-Agent': UA },
    })
    const data = await res.json()
    const a    = data.address ?? {}
    const city  = a.city || a.town || a.village || ''
    const state = a.state || ''
    return [city, state].filter(Boolean).join(', ')
  } catch {
    return ''
  }
}

export default function LocationInput({ id, label, labelType, placeholder, value, onChange, detectGeo }) {
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen]               = useState(false)
  const [searching, setSearching]     = useState(false)
  const [detecting, setDetecting]     = useState(false)
  const [activeIdx, setActiveIdx]     = useState(-1)
  const timerRef = useRef(null)
  const wrapRef  = useRef(null)

  useEffect(() => {
    const close = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  function handleChange(e) {
    const v = e.target.value
    onChange(v)
    setActiveIdx(-1)
    clearTimeout(timerRef.current)
    if (v.length < 3) { setSuggestions([]); setOpen(false); return }
    setSearching(true)
    timerRef.current = setTimeout(async () => {
      const res = await search(v)
      setSuggestions(res)
      setOpen(res.length > 0)
      setSearching(false)
    }, 480)
  }

  function pick(lbl) {
    onChange(lbl)
    setSuggestions([])
    setOpen(false)
    setActiveIdx(-1)
  }

  function handleKey(e) {
    if (!open) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); pick(suggestions[activeIdx].label) }
    else if (e.key === 'Escape') setOpen(false)
  }

  async function detect() {
    if (!navigator.geolocation) return
    setDetecting(true)
    try {
      const pos = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 }),
      )
      const lbl = await reverseGeocode(pos.coords.latitude, pos.coords.longitude)
      if (lbl) onChange(lbl)
    } catch { /* user denied or timeout */ }
    finally { setDetecting(false) }
  }

  const LabelIcon = labelType ? LABEL_ICONS[labelType] : null

  return (
    <div className="loc" ref={wrapRef}>
      <label className="loc__label" htmlFor={id}>
        {LabelIcon && (
          <span className="loc__label-icon">
            <LabelIcon size={12} color="currentColor" strokeWidth={1.5} />
          </span>
        )}
        {label}
      </label>
      <div className="loc__row">
        <input
          id={id}
          className="loc__input"
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKey}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          autoComplete="off"
          required
        />
        {detecting && <span className="loc__spin" aria-label="Detecting location" />}
        {!detecting && searching && <span className="loc__spin loc__spin--subtle" />}
        {detectGeo && !detecting && !searching && (
          <button type="button" className="loc__detect" onClick={detect} title="Use my location">
            <Location03Icon size={14} color="currentColor" />
          </button>
        )}
      </div>

      {open && suggestions.length > 0 && (
        <ul className="loc__dropdown" role="listbox" aria-label="Location suggestions">
          {suggestions.map((s, i) => (
            <li
              key={i}
              className={`loc__option${i === activeIdx ? ' loc__option--active' : ''}`}
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={e => { e.preventDefault(); pick(s.label) }}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
