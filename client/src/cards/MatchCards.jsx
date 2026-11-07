// Destination match results from match_destinations.
function theme(type = '') {
  const t = type.toLowerCase();
  if (t.includes('arctic')) return { icon: '🌌', cls: 'th-arctic' };
  if (t.includes('nature') || t.includes('adventure')) return { icon: '🏔️', cls: 'th-nature' };
  if (t.includes('beach') || t.includes('coast') || t.includes('island')) return { icon: '🏖️', cls: 'th-beach' };
  if (t.includes('romantic')) return { icon: '💫', cls: 'th-romance' };
  if (t.includes('spa')) return { icon: '♨️', cls: 'th-city' };
  return { icon: '🏛️', cls: 'th-city' };
}

export default function MatchCards({ data, onAction, disabled }) {
  return (
    <div className="cards-row">
      {data.results.map((d, i) => {
        const th = theme(d.type);
        return (
          <div key={d.id} className="card match">
            <div className={`match-hero ${th.cls}`}>
              <span className="match-rank">#{i + 1}</span>
              <span className="match-icon">{th.icon}</span>
              <div className="match-ring" style={{ '--p': d.matchPercent }}>
                <span>{d.matchPercent}%</span>
              </div>
            </div>
            <div className="card-body">
              <div className="card-title">{d.name}</div>
              <div className="muted">{d.country} · {d.type}</div>
              <div className="chips">
                {d.whyItMatches.map((w) => <span key={w} className="chip">{w}</span>)}
              </div>
              <div className="facts">
                <span className={d.inSeason ? 'ok' : 'warn'}>{d.inSeason ? '☀️' : '⚠️'} {d.bestSeason}</span>
                <span>€{d.dailyCostEur}/day</span>
                {d.fromPriceEur != null && <span>from <b>€{d.fromPriceEur}</b></span>}
              </div>
              {d.notes?.length > 0 && <div className="note">{d.notes.join(' · ')}</div>}
              <button className="card-btn" disabled={disabled} onClick={() => onAction(`Show me holiday packages to ${d.name}`)}>
                See packages →
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
