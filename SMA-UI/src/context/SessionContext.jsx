import { createContext, useContext, useState } from 'react';

const SESSION_KEY = 'sma_session';

const EMPTY_SESSION = {
  userId: '',
  clientId: '',
  brokerName: 'kite',
  apiKey: '',
  accessToken: '',
};

function readStorage() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || EMPTY_SESSION;
  } catch {
    return EMPTY_SESSION;
  }
}

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [session, setSession] = useState(readStorage);

  function saveSession(data) {
    const updated = { ...session, ...data };
    setSession(updated);
    localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
  }

  function clearSession() {
    setSession(EMPTY_SESSION);
    localStorage.removeItem(SESSION_KEY);
  }

  const isActive = !!(session.userId && session.brokerName && session.accessToken);

  return (
    <SessionContext.Provider value={{ session, saveSession, clearSession, isActive }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}
