import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import SwimApp from './SwimApp.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <SwimApp />
  </StrictMode>
);
