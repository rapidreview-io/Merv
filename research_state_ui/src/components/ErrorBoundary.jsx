import { Component } from 'react';

// Catches a render-time throw below it, so one bad payload blanks a page,
// not the app. Keyed by route in App, so navigating away clears it.
export default class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page-stage">
        <div className="empty-state" style={{ textAlign: 'left' }}>
          <h2>Something broke on this page</h2>
          <div className="error-message">{String(this.state.error?.message || this.state.error)}</div>
          <p style={{ marginTop: 18 }}>
            <button className="btn" onClick={() => window.location.reload()}>Reload</button>{' '}
            <button className="btn btn--ghost" onClick={() => window.history.back()}>Back</button>
          </p>
        </div>
      </div>
    );
  }
}
