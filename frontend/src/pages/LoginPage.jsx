import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ShieldCheck, Eye, EyeOff } from 'lucide-react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e?.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">
          <div className="logo-badge"><ShieldCheck size={21} /></div>
          <div>
            <div className="login-brand-name">GatePass</div>
            <div className="login-brand-tagline">Item Movement Control</div>
          </div>
        </div>

        <div className="login-card-title">Sign in</div>
        <div className="login-card-sub">Enter your credentials to continue</div>

        <div className="form-group">
          <label className="form-label" htmlFor="login-email">Email address</label>
          <input
            id="login-email"
            className="form-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoFocus
          />
        </div>
        <div className="form-group" style={{ marginBottom: 20 }}>
          <label className="form-label" htmlFor="login-password">Password</label>
          <div className="input-wrap">
            <input
              id="login-password"
              className="form-input"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
            />
            <button
              type="button"
              className="input-affix"
              onClick={() => setShowPassword(s => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {error && (
          <div className="alert alert-danger" role="alert" style={{ marginBottom: 16 }}>
            <AlertTriangle size={15} />
            {error}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: '100%', minHeight: 42, fontSize: 14 }}
          disabled={loading}
        >
          {loading
            ? <><div className="spinner" style={{ width: 16, height: 16, borderTopColor: '#fff' }} /> Signing in…</>
            : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
