import { StrictMode, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Login from './pages/Login';
import Register from './pages/Register';
import ProjectList from './pages/ProjectList';
import ProjectDetail from './pages/ProjectDetail';
import './index.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-gray-900 flex items-center justify-center p-8">
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-6 max-w-2xl w-full">
            <h2 className="text-red-400 text-xl font-bold mb-2">Something went wrong</h2>
            <pre className="text-red-300 text-sm whitespace-pre-wrap break-words">{this.state.error.message}</pre>
            <pre className="text-red-400/50 text-xs mt-2 whitespace-pre-wrap break-words">{this.state.error.stack}</pre>
            <button onClick={() => window.location.href = '/projects'} className="mt-4 px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600">
              Back to Projects
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/projects" element={<ProtectedRoute><ProjectList /></ProtectedRoute>} />
          <Route path="/projects/:id" element={<ProtectedRoute><ErrorBoundary><ProjectDetail /></ErrorBoundary></ProtectedRoute>} />
          <Route path="/" element={<Navigate to="/projects" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
