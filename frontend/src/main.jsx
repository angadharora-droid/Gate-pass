import { ErrorBoundary } from './sentry';   // first — catches errors from the very start
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import App from './App';
import './index.css';

// A crash while rendering used to leave a blank white page; now the user gets
// a way back, and the error is reported to Sentry
function CrashScreen() {
  return (
    <div className="loading-page" style={{ flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Something went wrong on this page.</div>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary fallback={<CrashScreen />}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
