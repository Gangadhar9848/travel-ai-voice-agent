// Holiday package results from search_packages.
export default function PackageCards({ data, onAction, disabled }) {
  return (
    <div className="cards-row">
      {data.results.map((p) => (
        <div key={p.id} className="card pkg">
          <div className="card-body">
            <div className="pkg-top">
              <span className="stars" aria-label={`${p.stars} stars`}>{'★'.repeat(p.stars)}<span>{'★'.repeat(Math.max(0, 5 - p.stars))}</span></span>
              {p.availability === 'Limited' && <span className="badge warn">Limited</span>}
            </div>
            <div className="card-title">{p.hotel}</div>
            <div className="muted">{p.destination} · from {p.origin}</div>
            <div className="facts">
              <span>🌙 {p.nights} nights</span>
              <span>🍽️ {p.board}</span>
            </div>
            {p.hotelActivities?.length > 0 && (
              <div className="chips">
                {p.hotelActivities.slice(0, 3).map((a) => <span key={a} className="chip">{a}</span>)}
              </div>
            )}
            <div className="pkg-bottom">
              <div className="price">€{p.priceEur}<small> package</small></div>
              <button
                className="card-btn"
                disabled={disabled}
                onClick={() => onAction(`I'd like package ${p.id} — ${p.hotel}, ${p.nights} nights (${p.board}), €${p.priceEur}. Which dates can I fly?`)}
              >
                Choose →
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
