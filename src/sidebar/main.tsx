import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { t } from '@/shared/i18n';
import { applyDocumentLocale } from '@/shared/document-locale';

applyDocumentLocale(t('extension_name'));

const container = document.getElementById('root');
if (container === null) {
  throw new Error(t('root_container_missing'));
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
