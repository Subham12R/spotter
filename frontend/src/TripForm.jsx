import { useState } from 'react'
import { Clock01Icon } from 'hugeicons-react'
import LocationInput from './LocationInput'

export default function TripForm({ onSubmit, loading }) {
  const [form, setForm] = useState({
    current_location:   '',
    pickup_location:    '',
    dropoff_location:   '',
    current_cycle_used: '',
  })

  function set(key, val) { setForm(f => ({ ...f, [key]: val })) }

  function handleSubmit(e) {
    e.preventDefault()
    onSubmit({
      current_location:   form.current_location.trim(),
      pickup_location:    form.pickup_location.trim(),
      dropoff_location:   form.dropoff_location.trim(),
      current_cycle_used: parseFloat(form.current_cycle_used) || 0,
    })
  }

  const cycleVal = parseFloat(form.current_cycle_used) || 0
  const cyclePct = Math.min((cycleVal / 70) * 100, 100)
  const cycleColor = cyclePct >= 90 ? '#ef4444' : cyclePct >= 70 ? '#E8A020' : '#22c55e'

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      {/* Header */}
      <div className="form__head">
        <div>
          <div className="form__title">Trip Planner</div>
          <div className="form__sub">49 CFR Part 395 · Property</div>
        </div>
        <span className="form__tag">70 hr / 8 day</span>
      </div>

      {/* Route locations — icons live in the label, no arrow dividers */}
      <div className="form__route">
        <LocationInput
          id="current_location"
          label="Current Location"
          labelType="start"
          placeholder="Chicago, IL"
          value={form.current_location}
          onChange={v => set('current_location', v)}
          detectGeo
        />
        <LocationInput
          id="pickup_location"
          label="Pickup"
          labelType="pickup"
          placeholder="Dallas, TX"
          value={form.pickup_location}
          onChange={v => set('pickup_location', v)}
        />
        <LocationInput
          id="dropoff_location"
          label="Dropoff"
          labelType="dropoff"
          placeholder="Los Angeles, CA"
          value={form.dropoff_location}
          onChange={v => set('dropoff_location', v)}
        />
      </div>

      {/* Cycle used */}
      <div className="cycle-field">
        <label className="cycle-field__label" htmlFor="cycle">
          <Clock01Icon size={12} color="currentColor" />
          Current Cycle Used
        </label>
        <div className="cycle-field__row">
          <input
            id="cycle"
            className="cycle-field__input"
            type="number"
            placeholder="0"
            min="0"
            max="70"
            step="0.5"
            value={form.current_cycle_used}
            onChange={e => set('current_cycle_used', e.target.value)}
            required
          />
          <span className="cycle-field__unit">hrs of 70</span>
        </div>
        {cycleVal > 0 && (
          <div className="cycle-field__bar">
            <div
              className="cycle-field__fill"
              style={{ width: `${cyclePct}%`, background: cycleColor }}
            />
          </div>
        )}
      </div>

      <button type="submit" className="btn-plan" disabled={loading}>
        {loading
          ? <><span className="btn-plan__spin" />Calculating…</>
          : 'Plan Trip'
        }
      </button>
    </form>
  )
}
