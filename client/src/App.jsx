import { useEffect, useState } from 'react';
import LogViewer from './LogViewer.jsx';
import Welcome from './Welcome.jsx';
import Chat from './Chat.jsx';

// user = null (welcome page) | { type: 'guest' } | { type: 'member', customer }
export default function App() {
  const [user, setUser] = useState(null);
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  if (hash === '#log') return <LogViewer />;

  return user ? (
    <Chat user={user} onExit={() => setUser(null)} />
  ) : (
    <Welcome onStart={setUser} />
  );
}
