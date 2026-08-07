import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../sidebar/styles.css';
import './gallery.css';
import { Gallery } from './Gallery';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('找不到 #root 容器');
}

createRoot(container).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
