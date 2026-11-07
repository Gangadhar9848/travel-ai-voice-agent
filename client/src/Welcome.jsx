import { useState } from 'react';
import { identify } from './api.js';
import Scene from './Scene.jsx';

export default function Welcome({ onStart }) {
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function lookup(e) {
    e.preventDefault();
    if (!identifier.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const customer = await identify(identifier);
      if (customer) onStart({ type: 'member', customer });
      else setError("We couldn't find an account with that email or customer ID.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="welcome">
      <Scene />
      <div className="welcome-card">
        <div className="brand center">
          <span className="logo">✈</span>
          <div>
            <h1>Holiday Assistant</h1>
            <p>Flight + hotel packages · activities</p>
          </div>
        </div>

        <h2>Plan your next holiday</h2>
        <p className="lead">Chat with our holiday assistant to find and book your perfect package.</p>

        <section className="option">
          <h3>I'm a member</h3>
          <p className="hint">Log in with your email or customer ID for personalised suggestions.</p>
          <form onSubmit={lookup}>
            <input
              value={identifier}
              onChange={(e) => { setIdentifier(e.target.value); setError(''); }}
              placeholder="Email or customer ID (e.g. C00001)"
              autoComplete="email"
              autoFocus
            />
            <button type="submit" disabled={!identifier.trim() || busy}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </form>
          {error && (
            <div className="error">
              {error}{' '}
              <button className="link" onClick={() => onStart({ type: 'guest' })}>Continue as guest instead</button>
            </div>
          )}
        </section>

        <div className="divider"><span>or</span></div>

        <section className="option">
          <h3>Continue as guest</h3>
          <p className="hint">No account needed. You can create a member account later.</p>
          <button className="secondary" onClick={() => onStart({ type: 'guest' })}>Start as guest</button>
        </section>
      </div>
    </div>
  );
}
