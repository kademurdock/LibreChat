import React from 'react';
import { createRoot } from 'react-dom/client';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import ConversationMode from '../../client/src/components/Chat/ConversationMode';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><RecoilRoot><MemoryRouter>
    <main><h1>Call dialog development</h1><p>This runs the complete web call dialog. The local test server uses a sample recording; no real microphone audio leaves this computer.</p>
    <ConversationMode index={0}/></main>
  </MemoryRouter></RecoilRoot></React.StrictMode>,
);
