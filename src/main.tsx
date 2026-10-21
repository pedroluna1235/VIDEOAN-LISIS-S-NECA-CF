import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

window.addEventListener('error', (event) => {
  console.warn('Global error guarded:', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.warn('Global unhandled rejection guarded:', event.reason);
});

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: error?.message || 'Error inesperado en el visor' };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error capturado en RootErrorBoundary:', error, errorInfo);
  }

  handleRecover = () => {
    try {
      const raw = localStorage.getItem('seneca_cf_current_project');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          parsed.captures = [];
          if (Array.isArray(parsed.events)) {
            parsed.events = parsed.events.map(({ drawingDataUrl, ...rest }: any) => rest);
          }
          localStorage.setItem('seneca_cf_current_project', JSON.stringify(parsed));
        }
      }
    } catch {
      try {
        localStorage.removeItem('seneca_cf_current_project');
      } catch {}
    }
    this.setState({ hasError: false, errorMessage: '' });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#161616] text-white flex flex-col items-center justify-center p-6 text-center">
          <div className="max-w-md w-full bg-[#222] border-t-4 border-[#cc2016] p-6 rounded shadow-xl">
            <h2 className="font-condensed font-bold text-xl text-[#f5b800] uppercase mb-2">
              ANÁLISIS SÉNECA CF — RECUPERACIÓN AUTOMÁTICA
            </h2>
            <p className="text-xs text-gray-300 mb-4">
              Se ha detectado un exceso de memoria temporal en el navegador ({this.state.errorMessage}). Tus cortes y
              análisis están protegidos.
            </p>
            <button
              onClick={this.handleRecover}
              className="px-4 py-2 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-sm uppercase tracking-wider rounded transition"
            >
              CONTINUAR EN EL EDITOR
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
