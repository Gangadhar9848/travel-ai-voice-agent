// Activities from find_activities (GetYourGuide, or package-inventory fallback).
const money = (n, cur) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: 0 }).format(n);

function Stars({ rating }) {
  const full = Math.round(rating);
  return (
    <span className="stars small" aria-label={`${rating} out of 5`}>
      {'★'.repeat(full)}<span>{'★'.repeat(5 - full)}</span>
    </span>
  );
}

export default function ActivityCards({ data }) {
  if (data.source !== 'getyourguide') {
    return (
      <div className="card act-fallback">
        <div className="card-body">
          <div className="card-title">🎟️ Things to do in {data.destination}</div>
          <div className="chips">
            {data.results.map((a) => <span key={a.title} className="chip">{a.title}</span>)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cards-row">
      {data.results.map((a) => (
        <a key={a.id} className="card act" href={a.url} target="_blank" rel="noopener noreferrer">
          <div className="act-img">
            <img src={a.image} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
            {a.duration && <span className="act-dur">⏱ {a.duration}</span>}
            {(a.bestseller || a.likelyToSellOut) && (
              <span className="act-badge">{a.likelyToSellOut ? 'Likely to sell out' : 'Bestseller'}</span>
            )}
          </div>
          <div className="card-body">
            <div className="act-title">{a.title}</div>
            <div className="act-rating">
              <Stars rating={a.rating} /> <b>{a.rating}</b> <span className="muted">({a.ratingCount.toLocaleString()})</span>
            </div>
            {a.categories.length > 0 && (
              <div className="chips">
                {a.categories.slice(0, 2).map((c) => <span key={c} className="chip">{c}</span>)}
              </div>
            )}
            <div className="pkg-bottom">
              <div className="price small">
                {a.originalPrice > a.price && <s className="was">{money(a.originalPrice, a.currency)}</s>}
                from {money(a.price, a.currency)}<small> / person</small>
              </div>
              <span className="card-btn">View ↗</span>
            </div>
          </div>
        </a>
      ))}
      <div className="gyg-credit">Activities powered by GetYourGuide</div>
    </div>
  );
}
