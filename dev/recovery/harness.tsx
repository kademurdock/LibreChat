import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RequestPasswordReset from '../../client/src/components/Auth/RequestPasswordReset';
import ResetPassword from '../../client/src/components/Auth/ResetPassword';
import translations from '../../client/src/locales/en/translation.json';

function Layout() {
  const [header, setHeaderText] = useState('com_auth_reset_password');
  const [error, setError] = useState('');
  return <main style={{ maxWidth: 440, padding: 24, margin: 'auto' }}>
    <h1>{translations[header]}</h1>
    {error && <p role="alert">{translations[error]} <a href="/forgot-password">Request a new reset link</a></p>}
    <Outlet context={{ setHeaderText, setError,
      startupConfig: { emailEnabled: !location.search.includes('email=off'), minPasswordLength: 8 } }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={[location.pathname + location.search]}>
      <Routes><Route element={<Layout />}>
        <Route path="/forgot-password" element={<RequestPasswordReset />} />
        <Route path="/reset-password" element={<ResetPassword />} />
      </Route></Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
