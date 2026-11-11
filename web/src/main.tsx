import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SharedPhotos } from './SharedPhotos';
import './style.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/^\/share\/?$/.test(window.location.pathname) ? <SharedPhotos /> : <App />}
  </React.StrictMode>,
);
